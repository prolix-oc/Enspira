/**
 * Data helper utilities for Enspira
 * Handles web scraping, content reranking, emotion classification, and RAG context
 * @module core/data-helper
 */

import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import fs from 'fs-extra';
import { Readability } from '@mozilla/readability';
import { join } from 'path';
import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { retrieveConfigValue } from './config.js';
import { logger } from './logger.js';
import type {
  RagError,
  SearchInferenceResult,
  WebUrl,
  RerankItem,
  ContextItem,
  EmotionResult,
  MilvusSearchResult,
} from '../types/index.js';

// Type definitions for ai-logic.js functions (not yet migrated)
type InferSearchParamFn = (message: string, userId: string) => Promise<SearchInferenceResult>;
type SearchSearXNGFn = (
  searchTerm: string,
  freshness?: string
) => Promise<WebUrl[] | RagError>;
type RetrieveWebContextFn = (
  urls: WebUrl[],
  searchTerm: string,
  subject: string,
  userId: string
) => Promise<string | RagError>;
type RerankStringFn = (message: string, userId: string) => Promise<string | RagError>;

// User agent strings for web scraping
const userAgentStrings = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.2227.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Herring/97.1.8280.8',
];

/**
 * Creates a structured error response for RAG operations
 * @param stage - The stage where the error occurred
 * @param message - Human-readable error message
 * @param details - Additional error details
 * @returns Structured error object
 */
export function createRagError(
  stage: string,
  message: string,
  details: unknown = null
): RagError {
  return {
    success: false,
    error: true,
    stage,
    message,
    details: details ?? undefined,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Maintains a history of voice messages in a text file
 * Adds new lines and removes old ones to keep within size limit
 * @param newLine - The new line to add to the voice message history
 */
export async function maintainVoiceContext(newLine: string): Promise<void> {
  try {
    const chatContextPath = join(process.cwd(), '/world_info/voice_messages.txt');

    await fs.ensureFile(chatContextPath);

    const currentContent = await fs.readFile(chatContextPath, 'utf-8');
    const currentLines = currentContent.split('\n').filter(Boolean);

    currentLines.push('- ' + newLine);

    const maxChats = (await retrieveConfigValue<number>('twitch.maxChatsToSave')) ?? 100;
    while (currentLines.length > maxChats) {
      currentLines.shift();
    }

    await fs.writeFile(chatContextPath, currentLines.join('\n') + '\n');
  } catch (error) {
    logger.log('Voice Context', `Error maintaining voice context: ${error}`);
  }
}

/**
 * Performs an axios request with exponential backoff retry
 * @param config - Axios request configuration
 * @param attempts - Maximum number of retry attempts
 * @param initialDelay - Initial delay in milliseconds
 * @returns Axios response
 */
export async function axiosRequestWithRetry<T = unknown>(
  config: AxiosRequestConfig,
  attempts = 3,
  initialDelay = 1000
): Promise<AxiosResponse<T>> {
  let delay = initialDelay;
  for (let i = 0; i < attempts; i++) {
    try {
      return await axios<T>(config);
    } catch (error) {
      if (i === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff
    }
  }
  // This should never be reached, but TypeScript needs it
  throw new Error('Retry loop completed without returning');
}

/**
 * Initiates a web search process for a given message and user ID
 * Uses the message to infer a search query, performs a search,
 * and retrieves web context based on the results
 * @param message - The message to initiate the web search for
 * @param userId - The ID of the user performing the search
 * @returns The result of the web context retrieval, or an error object
 */
export async function startWebResults(
  message: string,
  userId: string
): Promise<string | RagError> {
  // Dynamic import of rag-context module (to avoid circular dependencies)
  const ragContextModule = await import('./rag-context.js').catch(() => null);

  if (!ragContextModule) {
    return createRagError('import', 'Failed to load rag-context module');
  }

  const inferSearchParam = ragContextModule.inferSearchParam as InferSearchParamFn;
  const searchSearXNG = ragContextModule.searchSearXNG as SearchSearXNGFn;
  const retrieveWebContext = ragContextModule.retrieveWebContext as RetrieveWebContextFn;

  const queryResult = await inferSearchParam(message, userId);

  // Handle structured error from inferSearchParam
  if (!queryResult.success) {
    if (queryResult.optedOut) {
      logger.log('LLM', `Search opted out: ${queryResult.reason}`);
      return {
        success: false,
        error: true,
        stage: 'inference',
        message: queryResult.reason ?? 'Search opted out',
        optedOut: true,
        noSearchNeeded: true,
        timestamp: new Date().toISOString(),
      };
    }

    logger.log('LLM', `Search parameter inference failed: ${queryResult.message}`);
    return createRagError('inference', queryResult.message ?? 'Inference failed');
  }

  try {
    const pmWebSearch = await searchSearXNG(queryResult.searchTerm, queryResult.freshness);

    // Check if searchSearXNG returned an error object
    if (pmWebSearch && 'error' in pmWebSearch && pmWebSearch.error) {
      return pmWebSearch as RagError;
    }

    if (!pmWebSearch || (Array.isArray(pmWebSearch) && pmWebSearch.length === 0)) {
      return createRagError('search-execution', 'No search results found', {
        searchTerm: queryResult.searchTerm,
        freshness: queryResult.freshness,
      });
    }

    logger.log('LLM', `Starting web search for '${queryResult.searchTerm}'`);
    const searchedResults = await retrieveWebContext(
      pmWebSearch as WebUrl[],
      queryResult.searchTerm,
      queryResult.subject ?? '',
      userId
    );

    // Check if retrieveWebContext returned an error
    if (searchedResults && typeof searchedResults === 'object' && 'error' in searchedResults) {
      return searchedResults as RagError;
    }

    return (
      searchedResults ||
      createRagError('context-retrieval', 'Failed to retrieve context from search results', {
        searchResults: (pmWebSearch as WebUrl[]).length,
      })
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.log('LLM', `Error in web search process: ${errorMessage}`);
    return createRagError('web-search', errorMessage, { stack: errorStack });
  }
}

/**
 * Reranks and filters a list of text contents based on relevance to a message
 * @param contextBody - Array of objects containing text_content or summary
 * @param message - The message used for ranking relevance
 * @param userId - The ID of the user
 * @param requiresSearch - Whether to attempt web search if results are poor
 * @param cotReturn - Whether to return as array (chain-of-thought) or string
 * @returns Concatenated string of relevant content, or array if cotReturn is true
 */
export async function resultsReranked(
  contextBody: ContextItem[] | MilvusSearchResult[],
  message: string,
  userId: string,
  requiresSearch = false,
  cotReturn = false
): Promise<string | string[] | RagError> {
  try {
    if (!contextBody || !message) {
      logger.log('Embedding', 'Missing contextBody or message parameter');
      return '- No additional information to provide.\n';
    }

    // Case 1: No documents at all - trigger web search immediately if allowed
    if (contextBody.length === 0) {
      logger.log('Embedding', 'No context body provided for reranking.');

      if (requiresSearch) {
        logger.log('Embedding', 'Attempting web search for additional context (no documents found)');
        const webResults = await startWebResults(message, userId);

        if (webResults && typeof webResults === 'object' && 'error' in webResults) {
          if (webResults.optedOut) {
            return '- No additional context available for this query.\n';
          }
          logger.log('Search', `Web search failed: ${webResults.message}`);
          return '- Unable to find relevant information for this query.\n';
        }

        if (webResults) {
          return cotReturn ? [webResults as string] : (webResults as string);
        }

        return '- No additional context provided for this section.';
      }
      return '- No additional context provided for this section.';
    }

    // Process the documents for reranking
    let resultsRaw: string[] = [];

    if (!contextBody[0]?.relation) {
      resultsRaw = contextBody
        .map((item) => item.text_content || item.summary)
        .filter((item): item is string => Boolean(item));
    } else {
      resultsRaw = contextBody
        .map((item) => item.text_content || item.summary)
        .filter((item): item is string => Boolean(item));
    }

    if (resultsRaw.length === 0) {
      logger.log('Embedding', 'No valid content found in context body.');

      // Case 2: No valid content in documents - trigger web search if allowed
      if (requiresSearch) {
        logger.log('Embedding', 'Attempting web search for additional context (no valid content)');
        const webResults = await startWebResults(message, userId);

        if (webResults && typeof webResults !== 'object') {
          return cotReturn ? [webResults] : webResults;
        }
      }

      return '- No additional information to provide.\n';
    }

    // Get optimized query for reranking
    logger.log('Embedding', 'Asking rerank helper to optimize...');

    // Dynamic import of ai-engine module for rerankString
    const aiEngineModule = await import('./ai-engine.js').catch(() => null);
    let rerankOptimized: string = message;

    if (aiEngineModule?.rerankString) {
      const rerankString = aiEngineModule.rerankString as RerankStringFn;
      const result = await rerankString(message, userId);

      if (typeof result === 'string') {
        rerankOptimized = result;
      } else if (result && 'error' in result) {
        logger.log('Embedding', `Error optimizing rerank query: ${result.message}`);
      }
    }

    // Perform the reranking
    const rerankData = {
      model: await retrieveConfigValue<string>('models.rerank.model'),
      query: rerankOptimized,
      documents: resultsRaw,
      top_k: contextBody.length,
    };

    logger.log('Embedding', 'Starting rerank...');

    try {
      const endpoint = await retrieveConfigValue<string>('models.rerank.endpoint');
      const apiKey = await retrieveConfigValue<string>('models.rerank.apiKey');

      const response = await axios.post<RerankItem[]>(`${endpoint}/rerank`, rerankData, {
        headers: {
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip, deflate, br',
          Connection: 'keep-alive',
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 10000,
      });

      logger.log('Embedding', 'Rerank finished. Sorting results.');
      const rerankedArray = response.data;

      // Adjusted relevance thresholds for logit scores (-10 to 10 range)
      const HIGH_RELEVANCE_THRESHOLD = 6.0;
      const ACCEPTABLE_THRESHOLD = 4.5;
      const LOW_RELEVANCE_THRESHOLD = 1.4;

      // Count documents in each relevance category
      const highRelevanceCount = rerankedArray.filter(
        (item) => item.score >= HIGH_RELEVANCE_THRESHOLD
      ).length;
      const acceptableCount = rerankedArray.filter(
        (item) => item.score >= ACCEPTABLE_THRESHOLD
      ).length;
      const lowRelevanceCount = rerankedArray.filter(
        (item) => item.score < ACCEPTABLE_THRESHOLD
      ).length;

      // Calculate average relevance of top 5 results
      const avgTopRelevance =
        rerankedArray.slice(0, 5).reduce((sum, item) => sum + item.score, 0) /
        Math.min(5, rerankedArray.length);

      logger.log(
        'Embedding',
        `Relevance stats - High (>=${HIGH_RELEVANCE_THRESHOLD}): ${highRelevanceCount}, ` +
          `Acceptable (>=${ACCEPTABLE_THRESHOLD}): ${acceptableCount}, Low: ${lowRelevanceCount}, ` +
          `Avg Top 5: ${avgTopRelevance.toFixed(2)}`
      );

      // Filter results based on the acceptable threshold
      let rerankProcessed: string[] = rerankedArray
        .filter((item) => item.score >= ACCEPTABLE_THRESHOLD)
        .map((item) => resultsRaw[parseInt(String(item.index), 10)])
        .filter((item): item is string => item !== undefined);

      // If we have less than 3 acceptable results, include some lower-scoring ones
      if (rerankProcessed.length < 3) {
        logger.log(
          'Embedding',
          `Not enough results above threshold ${ACCEPTABLE_THRESHOLD}. Including lower-scoring results.`
        );

        // Get additional items that didn't meet the acceptable threshold
        const additionalItems: string[] = rerankedArray
          .filter(
            (item) =>
              item.score >= LOW_RELEVANCE_THRESHOLD &&
              (item.relevance_score ?? item.score) < ACCEPTABLE_THRESHOLD
          )
          .map((item) => resultsRaw[parseInt(String(item.index), 10)])
          .filter((item): item is string => item !== undefined);

        rerankProcessed = rerankProcessed.concat(additionalItems);

        // If we still don't have enough, just take the top 5
        if (rerankProcessed.length < 3) {
          rerankProcessed = rerankedArray
            .slice(0, 5)
            .map((item) => resultsRaw[parseInt(String(item.index), 10)])
            .filter((item): item is string => item !== undefined);
        }
      }

      // Trigger web search if any of these conditions are met
      const shouldSearchWeb =
        requiresSearch &&
        (highRelevanceCount < 2 ||
          avgTopRelevance < 6.0 ||
          (lowRelevanceCount > 0 && lowRelevanceCount / rerankedArray.length > 0.6));

      if (shouldSearchWeb) {
        logger.log(
          'Embedding',
          `Attempting web search for additional context. Relevance too low: ` +
            `High: ${highRelevanceCount}, Avg: ${avgTopRelevance.toFixed(2)}, ` +
            `Low Ratio: ${(lowRelevanceCount / rerankedArray.length).toFixed(2)}`
        );

        const augmentResult = await startWebResults(message, userId);

        if (augmentResult && typeof augmentResult === 'object' && 'error' in augmentResult) {
          logger.log('Embedding', `Web search failed: ${augmentResult.message}`);
        } else if (augmentResult) {
          logger.log('Embedding', 'Web search returned additional context, adding to results');
          rerankProcessed.push(augmentResult as string);
        }
      } else if (requiresSearch) {
        logger.log(
          'Embedding',
          `Skipping web search - sufficient document quality. ` +
            `High: ${highRelevanceCount}, Acceptable: ${acceptableCount}, Avg: ${avgTopRelevance.toFixed(2)}`
        );
      }

      if (cotReturn) {
        return rerankProcessed;
      }
      return rerankProcessed.join('\n');
    } catch (rerankError) {
      const errorMessage = rerankError instanceof Error ? rerankError.message : String(rerankError);
      logger.log('Embedding', `Error during reranking: ${errorMessage}`);

      // If reranking fails and search is allowed, try web search as fallback
      if (requiresSearch) {
        logger.log('Embedding', 'Falling back to web search due to rerank failure');
        try {
          const webResults = await startWebResults(message, userId);
          if (webResults && typeof webResults !== 'object') {
            return cotReturn ? [webResults] : webResults;
          }
        } catch (webError) {
          const webErrorMessage = webError instanceof Error ? webError.message : String(webError);
          logger.log('Embedding', `Web search fallback also failed: ${webErrorMessage}`);
        }
      }

      // Last resort: return the raw results limited to 5
      if (resultsRaw.length > 0) {
        const limitedResults = resultsRaw.slice(0, 5);
        return cotReturn ? limitedResults : limitedResults.join('\n');
      }

      return '- Error processing information. Using available context.\n';
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.log('Embedding', `Error in resultsReranked: ${errorStack}`);
    return createRagError('reranking', errorMessage, { stack: errorStack });
  }
}

/**
 * Gets the appropriate emotion modifier based on score
 */
function getEmotionModifier(score: number): string {
  if (score <= 0.33) {
    return 'a bit of';
  } else if (score <= 0.66) {
    return 'quite a bit of';
  } else {
    return 'a lot of';
  }
}

/**
 * Gets the description for an emotion label
 */
function getEmotionDescription(label: string): string {
  const emotionMap: Record<string, string> = {
    curious: 'a quizzical and curious vibe',
    surprise: 'shock and awe',
    think: 'curiosity',
    cheeky: 'cheeky banter',
    grumpy: 'a grumpy vibe',
    whiny: 'a whiny tone',
    empathetic: 'a sense of compassion',
    guilty: 'regret',
    anger: 'a heated emotion',
    disgust: 'a disgusted tone',
    impatient: 'frustration',
    energetic: 'an electrifying energy',
    joy: 'an uplifting and vibrant energy',
    serious: 'a stone-cold serious vibe',
    neutral: 'a lack of emotional energy',
    fear: 'a reserved or tense mood',
    love: 'a heartfelt or warm sentiment',
    confuse: 'a puzzled demeanor',
    suspicious: 'a doubtful tone',
    sadness: 'melancholy',
  };

  return emotionMap[label] ?? 'an undefined or mixed feeling';
}

/**
 * Generates a description of emotional tone from classification results
 * @param emotions - Array of emotion objects with label and score
 * @returns Description of the emotional tone
 */
function getEmotionRanking(emotions: EmotionResult[]): string {
  const topEmotions = emotions.sort((a, b) => b.score - a.score).slice(0, 3);

  const messageParts = topEmotions.map(({ label, score }) => {
    const modifier = getEmotionModifier(score);
    const description = getEmotionDescription(label);
    return `${modifier} ${description}`;
  });

  const formattedMessage =
    messageParts.length > 1
      ? `${messageParts.slice(0, -1).join(', ')}, and ${messageParts.slice(-1)}`
      : messageParts[0];

  return `You feel that this message gives off ${formattedMessage}.`;
}

/**
 * Classifies the emotions present in a message
 * @param message - The message to classify emotions from
 * @returns Description of the ranked emotions in the message
 */
export async function interpretEmotions(message: string): Promise<string> {
  try {
    const classifyBody = {
      model: await retrieveConfigValue<string>('models.classifier.model'),
      input: [message],
    };

    const endpoint = await retrieveConfigValue<string>('models.classifier.endpoint');
    const response = await axios.post<{ data: EmotionResult[][] }>(
      `${endpoint}/classify`,
      classifyBody
    );

    const results = response.data.data[0];
    if (!results || results.length === 0) {
      return 'Unable to determine emotional tone.';
    }
    return getEmotionRanking(results);
  } catch (error) {
    logger.log('Emotion', `Error in interpretEmotions: ${error}`);
    return 'Error interpreting emotions.';
  }
}

/**
 * Cleans text content by removing extra spaces and normalizing newlines
 * @param content - The text content to clean
 * @returns Cleaned text content
 */
function cleanContentWithNewlines(content: string): string {
  return content
    .replace(/\s+/g, ' ')
    .replace(/(?:\s*\n\s*)+/g, '\n')
    .trim();
}

/**
 * Pulls content from multiple web pages using Cheerio
 * @param urls - Array of URL objects to process
 * @param subject - The subject matter related to the URLs
 * @returns Concatenated string of cleaned content
 */
export async function pullFromWeb(urls: WebUrl[], subject: string): Promise<string> {
  if (!urls || urls.length === 0) {
    logger.log('Augment', 'No URLs provided for content extraction.');
    return '';
  }

  const fetchPromises = urls.map(async (link, index) => {
    try {
      const response = await axios.get<string>(link.url, {
        headers: {
          'User-Agent': userAgentStrings[Math.floor(Math.random() * userAgentStrings.length)],
        },
        timeout: 10000,
      });

      const $ = cheerio.load(response.data);

      // Remove script and style tags
      $('script, style').remove();

      // Get the HTML content after removing script and style tags
      const htmlContent = $.html();

      // Use Readability to extract the main content
      const document = new JSDOM(htmlContent);
      const reader = new Readability(document.window.document);
      const article = reader.parse();

      if (!article || !article.textContent) {
        logger.log('Augment', `Could not parse content from "${link.url}".`);
        return '';
      }

      const cleanContent = cleanContentWithNewlines(article.textContent);
      let content = '';

      if (index === 0) {
        content += `# Start of documents related to the subject "${subject}"`;
        content += `\n\n## From the web page "${link.source}", :\n\n${cleanContent}`;
      } else if (index === urls.length - 1) {
        content += `\n\n## From the web page "${link.url}", titled "${link.title}":\n\n${cleanContent}`;
        content += '\n\n# End of documents';
      } else {
        content += `\n\n## From the web page "${link.url}" in regards to the subject matter "${subject}":\n\n${cleanContent}`;
      }

      return content;
    } catch (error) {
      logger.log('Augment', `Error processing URL "${link.url}": ${error}`);
      return '';
    }
  });

  const contents = await Promise.all(fetchPromises);
  const pageContentText = contents.filter(Boolean).join('\n\n');

  return pageContentText;
}

/**
 * Pulls content from multiple web pages using an external scraper service
 * @param urls - Array of URL objects
 * @param subject - The subject related to the URLs
 * @returns Concatenated content or error object
 */
export async function pullFromWebScraper(
  urls: WebUrl[],
  subject: string
): Promise<string | RagError> {
  if (!urls || urls.length === 0) {
    return createRagError('scraping', 'No URLs provided for content extraction');
  }

  try {
    const scraperEndpoint = await retrieveConfigValue<string>('server.externalScraper.endpoint');
    const caching = await retrieveConfigValue<string>('server.externalScraper.caching');
    const deviceType = await retrieveConfigValue<string>('server.externalScraper.deviceType');

    if (!scraperEndpoint) {
      return createRagError('scraping', 'External scraper endpoint not configured');
    }

    const fetchPromises = urls.map(async (link) => {
      try {
        const url = new URL(`${scraperEndpoint}/api/article`);
        url.searchParams.set('cache', caching ?? 'true');
        url.searchParams.set('resource', 'document');
        url.searchParams.set('device', deviceType ?? 'desktop');
        url.searchParams.set('url', link.url);
        url.searchParams.set('format', 'json');

        const response = await axios.get<{ textContent?: string }>(url.toString(), {
          timeout: 15000,
        });

        // Check if the response has the expected structure
        if (!response.data || typeof response.data !== 'object') {
          logger.log('Augment', `Invalid response format for URL ${link.url}`);
          return '';
        }

        // Check for textContent property specifically
        if (!response.data.textContent || typeof response.data.textContent !== 'string') {
          logger.log('Augment', `No text content found for URL ${link.url}`);
          return '';
        }

        return `## From the web page "${link.source}", titled "${link.title}":\n\n${response.data.textContent}`;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.log('Augment', `Error processing URL "${link.url}": ${errorMessage}`);
        return '';
      }
    });

    const contents = await Promise.all(fetchPromises);
    const validContents = contents.filter(Boolean);

    if (validContents.length === 0) {
      return createRagError('scraping-results', 'No valid content extracted from any URL', {
        urlsAttempted: urls.length,
      });
    }

    // Construct the final page content text
    let pageContentText = `# Start of documents related to the subject "${subject}"\n\n`;
    pageContentText += validContents.join('\n\n');
    pageContentText += `\n\n# End of documents related to the subject "${subject}"`;

    return pageContentText;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.log('Augment', `Error in web scraping: ${errorMessage}`);
    return createRagError('scraping-execution', errorMessage);
  }
}

export default {
  createRagError,
  maintainVoiceContext,
  axiosRequestWithRetry,
  startWebResults,
  resultsReranked,
  interpretEmotions,
  pullFromWeb,
  pullFromWebScraper,
};
