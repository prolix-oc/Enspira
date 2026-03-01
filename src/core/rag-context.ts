/**
 * RAG Context Retrieval and Management
 * Handles context retrieval, vector search, and document management
 */

import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import https from 'https';
import fetch from 'node-fetch';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'url';

import { logger } from './logger.js';
import { retrieveConfigValue } from './config.js';
import { returnAuthObject } from './api-helper.js';
import { getMessageEmbedding } from './embeddings.js';
import {
  getCachedResult,
  setCachedResult,
  checkAndCreateCollection,
  ensureCollectionLoaded,
  getCollectionSchema,
  searchDocumentsInMilvus,
  validateEmbeddingDimension,
  insertVectorToMilvus,
  upsertIntelligenceToMilvus,
  deleteVectorsFromMilvus,
  scheduleVectorInsertion,
} from './vector-db.js';
import {
  resultsReranked,
  createRagError,
  pullFromWebScraper,
} from './data-helper.js';
import { SummaryRequestBody } from './llm-requests.js';
import { sendToolCompletionRequest } from './llm-client.js';
import { queryPrompt } from './prompt-builder.js';

import type {
  MilvusSearchResult,
  MilvusSearchOptions,
  MilvusUserInfo,
  WebSearchResultItem,
  SummaryResult,
  DocumentComparisonResult,
  DocumentUpsertData,
  RagError,
  ModelConfig,
} from '@/types/ai.types.js';
import type { FormattedChatMessage } from '@/types/user.types.js';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== SEARCH FUNCTIONS ====================

/**
 * Generic function to find relevant items in any collection
 * @param message - Search message
 * @param userId - User ID
 * @param collectionType - Type of collection to search
 * @param outputFields - Fields to return
 * @param topK - Number of results
 * @param searchOptions - Additional search options
 * @returns Search results
 */
export async function findRelevantItems(
  message: string,
  userId: string,
  collectionType: string,
  outputFields: string | string[],
  topK: number = 10,
  searchOptions: MilvusSearchOptions = {}
): Promise<MilvusSearchResult[]> {
  const cacheKey = `${collectionType}_${userId}_${message}`;
  const cachedResult = getCachedResult<MilvusSearchResult[]>(cacheKey);
  if (cachedResult) return cachedResult;

  try {
    const configKey = `milvus.collections.${collectionType}`;
    const collectionName = await retrieveConfigValue<string>(configKey);
    if (!collectionName) {
      logger.warn('RAG', `No collection name configured for ${collectionType}`);
      return [];
    }

    const created = await checkAndCreateCollection(collectionName, userId);
    if (!created) {
      return [];
    }

    const messageEmbedding = await getMessageEmbedding(message);
    const binaryEmbedding = Buffer.from(messageEmbedding);

    // Validate embedding dimensions
    const collectionSchema = await getCollectionSchema(collectionName, userId);
    const embeddingField = collectionSchema.fields.find(
      (field) => field.name === 'embedding'
    );
    const dimParam = embeddingField?.type_params.find((param) => param.key === 'dim');
    const expectedDim = dimParam ? parseInt(dimParam.value) : 1024;
    validateEmbeddingDimension(binaryEmbedding, expectedDim);

    const searchResponse = await searchDocumentsInMilvus(
      binaryEmbedding,
      collectionName,
      outputFields,
      topK,
      userId,
      searchOptions
    );

    // Set appropriate cache TTL based on collection type
    const cacheTTL =
      collectionType === 'intelligence'
        ? 300000 // 5 minutes for documents
        : collectionType === 'chat'
          ? 30000 // 30 seconds for chats
          : 60000; // 1 minute for others

    setCachedResult(cacheKey, searchResponse.results, cacheTTL);
    return searchResponse.results;
  } catch (error) {
    logger.log(
      'Milvus',
      `Error in findRelevantItems for ${collectionType}: ${error}`
    );
    return [];
  }
}

/**
 * Find relevant chats with fallback to MongoDB
 * @param message - The message to search for
 * @param user - The username
 * @param userId - The user ID
 * @param topK - The number of top results to return
 * @returns Search results
 */
export async function findRelevantChats(
  message: string,
  user: string,
  userId: string,
  topK: number = 10
): Promise<MilvusSearchResult[] | FormattedChatMessage[] | boolean> {
  try {
    // Import MongoDB search function for hybrid approach
    const { findRelevantChatContext } = await import('./database.js');
    const results = await findRelevantChatContext(userId, message, user, topK, {
      useVectors: true,
      simpleTextSearch: true,
    });

    return results;
  } catch (error) {
    logger.log('Chat', `Error in findRelevantChats: ${(error as Error).message}`);

    // Fallback to Milvus-only search
    return await findRelevantItems(
      message,
      userId,
      'chat',
      ['text_content', 'username', 'raw_msg', 'ai_message'],
      topK,
      { requireStrongConsistency: false }
    );
  }
}

/**
 * Find relevant documents in intelligence collection
 * @param message - The message to search for
 * @param userId - The user ID
 * @param topK - The number of top results to return
 * @returns Search results
 */
export async function findRelevantDocuments(
  message: string,
  userId: string,
  topK: number = 10
): Promise<MilvusSearchResult[]> {
  return await findRelevantItems(
    message,
    userId,
    'intelligence',
    ['text_content', 'relation'],
    topK,
    { criticalSearch: true, maxRetries: 3 }
  );
}

/**
 * Find relevant voice interactions
 * @param message - The message to search for
 * @param userId - The user ID
 * @param topK - The number of top results to return
 * @returns Search results
 */
export async function findRelevantVoiceInMilvus(
  message: string,
  userId: string,
  topK: number = 5
): Promise<MilvusSearchResult[]> {
  return await findRelevantItems(
    message,
    userId,
    'voice',
    ['summary', 'username', 'user_message', 'ai_resp', 'date_time'],
    topK,
    { requireStrongConsistency: false }
  );
}

/**
 * Find user in Milvus by username
 */
export async function findUserInMilvus(
  username: string,
  userId: string
): Promise<MilvusSearchResult | null> {
  const results = await findRelevantItems(
    username,
    userId,
    'user',
    ['gender', 'age', 'residence'],
    1,
    { requireStrongConsistency: true }
  );

  return results[0] || null;
}

/**
 * Get recent chats for a user
 */
export async function returnRecentChats(
  userId: string,
  fromConsole: boolean = false,
  allChats: boolean = false
): Promise<string | { chatList: string; executionTime: number } | never[]> {
  try {
    const userObj = await returnAuthObject(userId);
    const { getRecentChats } = await import('./database.js');
    const startTime = performance.now();
    const limit = allChats ? 1000 : (userObj as { max_chats?: number })?.max_chats || 25;
    const messages = await getRecentChats(userId, limit);
    const sortedResults = [...messages].sort((a, b) => a.time_stamp - b.time_stamp);
    const formattedResults = sortedResults
      .map(
        (item) =>
          `- ${item.username} sent the following message in ${(userObj as { user_name?: string })?.user_name}'s Twitch channel: ${item.raw_msg}`
      )
      .join('\n');

    const timeElapsed = (performance.now() - startTime) / 1000;
    logger.log(
      'DB Metrics',
      `Recent chats took ${timeElapsed.toFixed(3)} seconds for query.`
    );

    if (fromConsole) {
      return { chatList: formattedResults, executionTime: timeElapsed };
    } else {
      return formattedResults;
    }
  } catch (error) {
    logger.log('MongoDB', `Error in findRecentChats: ${(error as Error).message}`);
    return [];
  }
}

// ==================== VECTOR INSERTION ====================

/**
 * Insert intelligence vectors
 */
export async function insertAugmentVectorsToMilvus(
  vectors: number[],
  content: string,
  relational: string,
  userId: string
): Promise<boolean> {
  const vectorData = {
    embedding: vectors,
    relation: relational,
    text_content: content,
  };

  return await insertVectorToMilvus('intelligence', userId, vectorData);
}

/**
 * Insert voice interaction vectors
 */
export async function insertVoiceVectorsIntoMilvus(
  vectors: number[],
  summary: string,
  message: string,
  response: string,
  user: string,
  date: string,
  userId: string
): Promise<boolean> {
  const vectorData = {
    embedding: vectors,
    username: user,
    user_message: message,
    ai_resp: response,
    summary: summary,
    date_time: date,
  };

  return await insertVectorToMilvus('voice', userId, vectorData);
}

/**
 * Add chat message as vector with batching
 */
export async function addChatMessageAsVector(
  sumText: string,
  message: string,
  username: string,
  date: string,
  response: string,
  userId: string
): Promise<boolean> {
  try {
    const currentTime = Date.now();
    const embeddingsArray = await getMessageEmbedding(sumText);

    const vectorData = {
      embedding: embeddingsArray,
      username: username,
      text_content: sumText,
      raw_msg: message,
      ai_message: response,
      time_stamp: currentTime,
    };

    scheduleVectorInsertion('chat', userId, vectorData);
    return true;
  } catch (error) {
    logger.log('Milvus', `Error processing chat text: ${error}`);
    return false;
  }
}

/**
 * Add voice message as vector
 */
export async function addVoiceMessageAsVector(
  sumString: string,
  message: string,
  username: string,
  date: string,
  response: string,
  userId: string
): Promise<void> {
  try {
    const embeddingsArray = await getMessageEmbedding(message);
    const success = await insertVoiceVectorsIntoMilvus(
      embeddingsArray,
      sumString,
      message,
      response,
      username,
      date,
      userId
    );

    if (success) {
      logger.log('Milvus', 'Voice message successfully inserted into Milvus.');
    } else {
      logger.log('Milvus', 'Failed to insert voice message into Milvus.');
    }
  } catch (error) {
    logger.log('Milvus', `Error processing voice message: ${error}`);
  }
}

/**
 * Upsert user info to Milvus
 */
export async function upsertUserInfo(
  userId: string,
  userInfo: MilvusUserInfo
): Promise<void> {
  try {
    const collectionName = `${await retrieveConfigValue('milvus.collections.user')}_${userId}`;
    const userEmbedding = await getMessageEmbedding(userInfo.username);

    const fieldsData = [
      {
        embedding: userEmbedding,
        username: userInfo.username,
        gender: userInfo.gender || '',
        age: userInfo.age || 0,
        residence: userInfo.residence || '',
      },
    ];

    const { upsertIntelligenceToMilvus: upsertFn } = await import('./vector-db.js');
    const userCollectionName = await retrieveConfigValue<string>('milvus.collections.user');
    if (!userCollectionName) {
      throw new Error('User collection name not configured');
    }
    await upsertFn(
      fieldsData.map((f) => ({
        relation: f.username,
        text_content: JSON.stringify(f),
        embedding: f.embedding,
      })),
      userCollectionName,
      userId
    );

    logger.log(
      'Milvus',
      `User info for ${userInfo.username} upserted in collection ${collectionName}.`
    );
  } catch (error) {
    logger.log('Milvus', `Error upserting user info: ${error}`);
  }
}

// ==================== WEB SEARCH ====================

/**
 * Search using Brave API
 */
export async function searchBraveAPI(
  query: string,
  freshness: string
): Promise<WebSearchResultItem[] | RagError> {
  try {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('result_filter', 'web');
    url.searchParams.set('freshness', freshness);

    const httpsAgent = new https.Agent({
      keepAlive: true,
      rejectUnauthorized: true,
      timeout: 10000,
    });

    const braveApiKey = await retrieveConfigValue<string>('brave.apiKey');
    if (!braveApiKey) {
      return createRagError('search', 'Brave API key not configured');
    }
    const response = await fetch(url.toString(), {
      method: 'GET',
      agent: httpsAgent,
      headers: {
        'X-Subscription-Token': braveApiKey,
        Accept: 'application/json',
        'User-Agent': 'curl/7.68.0',
      },
    });

    const data = (await response.json()) as {
      web?: {
        results?: Array<{
          url: string;
          title: string;
          meta_url: { hostname: string };
        }>;
      };
    };

    if (data && data.web && Array.isArray(data.web.results)) {
      const chosenResults = data.web.results.slice(0, 4);
      const resultStuff: WebSearchResultItem[] = [];
      for (const item of chosenResults) {
        const relevantItems = {
          url: item.url,
          title: item.title,
          source: item.meta_url.hostname,
        };
        resultStuff.push(relevantItems);
      }
      return resultStuff;
    } else {
      logger.log(
        'Brave Search',
        `No web results found from Brave for '${query}' using freshness '${freshness}'`,
        'error'
      );
      return [];
    }
  } catch (error) {
    console.error('Error:', error);
    return [];
  }
}

/**
 * Search using SearXNG
 */
export async function searchSearXNG(
  query: string,
  _freshness: string
): Promise<WebSearchResultItem[] | RagError> {
  try {
    const url = new URL('https://search.prolix.dev/search');
    url.searchParams.set('q', query);
    url.searchParams.set('safesearch', '0');
    url.searchParams.set('categories', 'general');
    url.searchParams.set('engines', 'google,bing');
    url.searchParams.set('format', 'json');

    const response = await axios.get<{
      results?: Array<{
        url: string;
        title: string;
        parsed_url: string[];
      }>;
    }>(url.toString());

    if (!response.data || !Array.isArray(response.data.results)) {
      return createRagError('search-api', 'Invalid response from search API', {
        query: query,
        responseStatus: response.status,
      });
    }

    if (response.data.results.length === 0) {
      return createRagError('search-results', 'No results found for query', {
        query: query,
        freshness: _freshness,
      });
    }

    const chosenResults = response.data.results.slice(0, 4);
    const resultStuff: WebSearchResultItem[] = [];

    for (const item of chosenResults) {
      const relevantItems = {
        url: item.url,
        title: item.title,
        source: item.parsed_url[1] ?? '',
      };
      resultStuff.push(relevantItems);
    }

    return resultStuff;
  } catch (error) {
    logger.log('SearXNG Search', `Error searching: ${(error as Error).message}`);
    return createRagError('search-execution', (error as Error).message, { query: query });
  }
}

/**
 * Infer search parameters from a query
 */
export async function inferSearchParam(
  query: string,
  userId: string
): Promise<
  | { success: true; searchTerm: string; subject: string; freshness: string; vectorString: string }
  | { success: false; optedOut?: boolean; reason?: string }
  | RagError
> {
  try {
    const queryModelConfig = await retrieveConfigValue<ModelConfig>('models.query');
    if (!queryModelConfig) {
      return createRagError('query-generation', 'Query model configuration not found');
    }
    const instruct = await queryPrompt(query, userId);
    const chatTask = await sendToolCompletionRequest(instruct, queryModelConfig);

    if (!chatTask || chatTask.error) {
      return createRagError(
        'query-generation',
        'Failed to generate search query',
        { originalError: chatTask?.error || 'Unknown error' }
      );
    }

    const fullChat = chatTask.response as {
      valid?: boolean;
      reason?: string;
      searchTerm?: string;
      subject?: string;
      freshness?: string;
      vectorString?: string;
    };

    if (!fullChat || typeof fullChat !== 'object') {
      return createRagError(
        'query-parsing',
        'Invalid response structure from query builder',
        { responseType: typeof fullChat }
      );
    }

    if (fullChat.valid === false) {
      logger.log(
        'LLM',
        `Query builder opted out of search for this query. Reason: ${fullChat.reason}`
      );
      return {
        success: false,
        optedOut: true,
        reason: fullChat.reason,
      };
    } else {
      logger.log(
        'LLM',
        `Returned optimized search param: '${fullChat.searchTerm}'. Time to first token: ${(chatTask as { timeToFirstToken?: string }).timeToFirstToken} seconds. Process speed: ${(chatTask as { tokensPerSecond?: string }).tokensPerSecond}tps`
      );
      return {
        success: true,
        searchTerm: fullChat.searchTerm || '',
        subject: fullChat.subject || '',
        freshness: fullChat.freshness || '',
        vectorString: fullChat.vectorString || '',
      };
    }
  } catch (error) {
    logger.log('LLM', `Error inferring search parameter: ${error}`);
    return createRagError('query-inference', (error as Error).message, {
      stack: (error as Error).stack,
    });
  }
}

// ==================== WEB CONTEXT RETRIEVAL ====================

/**
 * Summarize a page's content
 */
async function summarizePage(
  pageContent: string,
  subject: string
): Promise<SummaryResult | { error: string; details?: string } | null> {
  try {
    const summaryModel = await retrieveConfigValue<string>('models.summary.model');
    const summaryConfig = await retrieveConfigValue<ModelConfig>('models.summary');
    if (!summaryModel || !summaryConfig) {
      logger.log('Augment', 'Summary model configuration not found');
      return { error: 'Summary model configuration not found' };
    }

    const instruct = await SummaryRequestBody.create(
      `Please summarize the following content about "${subject}" in a way that provides both a concise vector-optimized sentence and a detailed summary.`,
      summaryModel,
      pageContent
    );

    const chatTask = await sendToolCompletionRequest(instruct, summaryConfig);

    if (!chatTask) {
      logger.log('Augment', 'Empty response from summary request');
      return null;
    }

    if (chatTask.error) {
      logger.log('Augment', `Error in summary request: ${chatTask.error}`);
      return { error: chatTask.error };
    }

    if (typeof chatTask.response === 'object' && chatTask.response !== null) {
      return chatTask.response as SummaryResult;
    }

    try {
      return JSON.parse(chatTask.response as string) as SummaryResult;
    } catch (parseError) {
      logger.log(
        'Augment',
        `Failed to parse summary response as JSON: ${(parseError as Error).message}`
      );
      return { error: 'JSON parsing failed', details: (parseError as Error).message };
    }
  } catch (error) {
    logger.log('Augment', `Error in summarizePage: ${(error as Error).message}`);
    return { error: (error as Error).message };
  }
}

/**
 * Generate final combined summary from multiple summaries
 */
async function finalCombinedSummary(
  summaries: SummaryResult[],
  subject: string
): Promise<SummaryResult | RagError> {
  try {
    const summaryModel = await retrieveConfigValue<string>('models.summary.model');
    const summaryConfig = await retrieveConfigValue<ModelConfig>('models.summary');
    if (!summaryModel || !summaryConfig) {
      return createRagError('summary-generation', 'Summary model configuration not found');
    }

    const combinedText = summaries
      .map(
        (s) => `Vector hint: ${s.vectorString}\nDetailed: ${s.summaryContents}`
      )
      .join('\n\n');

    const finalPrompt = `You are provided with multiple summaries for content about "${subject}". Please consolidate these into a final summary. Your output must be in JSON format with two properties: "vectorString" (a single concise sentence optimized for vector search) and "summaryContents" (the complete final summary). Here are the individual summaries:\n\n${combinedText}`;

    const instruct = await SummaryRequestBody.create(
      finalPrompt,
      summaryModel,
      combinedText
    );

    const chatTask = await sendToolCompletionRequest(instruct, summaryConfig);

    if (!chatTask) {
      logger.log('Augment', 'Empty response from final summary request');
      return createRagError(
        'summary-generation',
        'Empty response from summary tool'
      );
    }

    if (chatTask.error) {
      logger.log(
        'Augment',
        `Error in final summary request: ${chatTask.error}`
      );
      return createRagError('summary-generation', chatTask.error);
    }

    if (typeof chatTask.response === 'object' && chatTask.response !== null) {
      const response = chatTask.response as SummaryResult;
      if (!response.vectorString || !response.summaryContents) {
        logger.log(
          'Augment',
          'Final summary response missing required properties'
        );
        return createRagError(
          'summary-format',
          'Summary response missing required properties',
          {
            response:
              JSON.stringify(chatTask.response).substring(0, 100) + '...',
          }
        );
      }
      return response;
    }

    try {
      const parsedResponse = JSON.parse(chatTask.response as string) as SummaryResult;
      if (!parsedResponse.vectorString || !parsedResponse.summaryContents) {
        logger.log(
          'Augment',
          'Parsed final summary response missing required properties'
        );
        return createRagError(
          'summary-format',
          'Parsed summary response missing required properties',
          { response: JSON.stringify(parsedResponse).substring(0, 100) + '...' }
        );
      }
      return parsedResponse;
    } catch (parseError) {
      logger.log(
        'Augment',
        `Failed to parse final summary response as JSON: ${(parseError as Error).message}`
      );
      return createRagError(
        'summary-parsing',
        'Failed to parse summary as JSON',
        {
          error: (parseError as Error).message,
          rawResponse: (chatTask.response as string).substring(0, 100) + '...',
        }
      );
    }
  } catch (error) {
    logger.log('Augment', `Error in finalCombinedSummary: ${(error as Error).message}`);
    return createRagError('summary-execution', (error as Error).message, {
      stack: (error as Error).stack,
    });
  }
}

/**
 * Retrieve web context from URLs
 */
export async function retrieveWebContext(
  urls: Array<{ url: string; source?: string; title?: string }>,
  query: string,
  subject: string,
  userId: string
): Promise<string | RagError> {
  if (!urls || urls.length === 0) {
    return createRagError(
      'context-retrieval',
      'No URLs provided for context extraction',
      { query: query }
    );
  }

  try {
    logger.log(
      'LLM',
      `Starting optimized web context retrieval for '${query}'`
    );

    const scrapePromises = urls.map((urlObj) =>
      pullFromWebScraper([urlObj], subject)
    );
    const pageContentsArray = await Promise.all(scrapePromises);
    const validContents = pageContentsArray.filter(
      (content): content is string =>
        content !== null && typeof content === 'string' && content.trim() !== ''
    );

    if (validContents.length === 0) {
      return createRagError(
        'content-scraping',
        'No valid content found from scraped URLs',
        { urlCount: urls.length }
      );
    }

    const summaryPromises = validContents.map((content) =>
      summarizePage(content, subject)
    );
    const individualSummaries = await Promise.all(summaryPromises);

    const validSummaries = individualSummaries.filter(
      (summary): summary is SummaryResult =>
        summary !== null &&
        !('error' in summary) &&
        'vectorString' in summary &&
        'summaryContents' in summary
    );

    if (validSummaries.length === 0) {
      return createRagError(
        'summarization',
        'Failed to generate valid summaries from content',
        { contentCount: validContents.length }
      );
    }

    const finalSummaryResult = await finalCombinedSummary(validSummaries, subject);

    // Check if this is a RagError (has success: false and error message)
    if ('success' in finalSummaryResult && finalSummaryResult.success === false) {
      return finalSummaryResult as RagError;
    }

    // Type narrow to SummaryResult
    const finalSummary = finalSummaryResult as SummaryResult;

    if (
      !finalSummary ||
      !finalSummary.vectorString ||
      !finalSummary.summaryContents
    ) {
      return createRagError(
        'final-summary',
        'Failed to generate final combined summary',
        { summaryCount: validSummaries.length }
      );
    }

    const finalText = `### Final Summary for ${subject}:\n${finalSummary.summaryContents}`;
    const embeddingArray = await getMessageEmbedding(finalSummary.vectorString);

    if (!embeddingArray) {
      return createRagError(
        'embedding-generation',
        'Failed to generate embedding for summary',
        { vectorString: finalSummary.vectorString.substring(0, 100) + '...' }
      );
    }

    const upsertData = [
      {
        relation: finalSummary.vectorString.slice(0, 512),
        text_content: finalText,
        embedding: embeddingArray,
      },
    ];

    const intelligenceCollection = await retrieveConfigValue<string>('milvus.collections.intelligence');
    if (!intelligenceCollection) {
      return createRagError('vector-storage', 'Intelligence collection not configured');
    }
    const upsertResult = await upsertIntelligenceToMilvus(
      upsertData,
      intelligenceCollection,
      userId
    );

    if (!upsertResult) {
      return createRagError(
        'vector-storage',
        'Failed to store summary in vector database',
        { subject: subject }
      );
    }

    logger.log('Augment', `Final combined summary stored for '${subject}'`);
    return finalText;
  } catch (error) {
    logger.log(
      'Augment',
      `Error in web context retrieval for '${query}': ${(error as Error).message}`,
      'error'
    );
    return createRagError('web-context', (error as Error).message, {
      query: query,
      subject: subject,
    });
  }
}

// ==================== FILE PROCESSING ====================

/**
 * Check if string is valid JSON
 */
function isValidJson(input: unknown): boolean {
  if (typeof input === 'string') {
    try {
      JSON.parse(input);
      return true;
    } catch {
      return false;
    }
  } else if (typeof input === 'object' && input !== null) {
    return true;
  }
  return false;
}

/**
 * Read files from directory recursively
 */
async function readFilesFromDirectory(directory: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const items = await fs.readdir(directory, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(directory, item.name);
      if (item.isDirectory()) {
        const subDirFiles = await readFilesFromDirectory(fullPath);
        files.push(...subDirFiles);
      } else if (item.isFile() && path.extname(item.name) === '.json') {
        files.push(fullPath);
      }
    }
  } catch (error) {
    logger.log('File System', `Error reading directory ${directory}: ${error}`);
    return [];
  }
  return files;
}

/**
 * Compare local documents with Milvus collection
 */
async function compareDocuments(
  directory: string,
  userId: string,
  collectionName: string
): Promise<DocumentComparisonResult> {
  const filenames = await readFilesFromDirectory(`${directory}/${userId}`);
  const localDocuments = (
    await Promise.all(
      filenames.map(async (filename) => {
        try {
          const content = await fs.readFile(filename, 'utf8');
          return isValidJson(content) ? JSON.parse(content) as { relation?: string; content?: string } : null;
        } catch (error) {
          logger.log(
            'File System',
            `Error reading or parsing file ${filename}: ${error}`
          );
          return null;
        }
      })
    )
  ).filter((content): content is { relation: string; content: string } => content !== null);

  // For now, we'll assume we need to fetch existing docs differently
  const existingDocsMap = new Map<string, { text_content: string; embedding: number[] }>();

  // This is a simplified version - in production you'd query Milvus directly
  logger.log(
    'Milvus',
    `Comparing ${localDocuments.length} local documents for user ${userId}.`
  );

  const toInsert: DocumentUpsertData[] = [];
  const toUpdate: DocumentUpsertData[] = [];
  const toDelete = new Set(existingDocsMap.keys());

  for (const localDoc of localDocuments) {
    if (!localDoc || !localDoc.relation || localDoc.content === undefined) {
      logger.log(
        'Milvus',
        `Skipping invalid local document: ${JSON.stringify(localDoc)}`
      );
      continue;
    }
    const existingDoc = existingDocsMap.get(localDoc.relation);

    // getMessageEmbedding(string) always returns number[], no flattening needed
    const embedding = await getMessageEmbedding(localDoc.relation);

    if (!existingDoc) {
      toInsert.push({
        relation: localDoc.relation,
        text_content: localDoc.content,
        embedding,
      });
    } else {
      toDelete.delete(localDoc.relation);

      if (existingDoc.text_content !== localDoc.content) {
        toUpdate.push({
          relation: localDoc.relation,
          text_content: localDoc.content,
          embedding,
        });
      }
    }
  }

  return {
    missing: toInsert,
    update: toUpdate,
    remove: Array.from(toDelete).map((relation) => ({ relation })),
  };
}

/**
 * Process files and sync with Milvus
 */
export async function processFiles(
  directory: string,
  userId: string
): Promise<void> {
  try {
    const intelligenceCollectionType = await retrieveConfigValue<string>('milvus.collections.intelligence');
    if (!intelligenceCollectionType) {
      logger.log('Milvus', 'Intelligence collection type not configured');
      return;
    }

    const collectionName = `${intelligenceCollectionType}_${userId}`;
    const collectionCreated = await checkAndCreateCollection(
      intelligenceCollectionType,
      userId
    );
    if (!collectionCreated) {
      logger.log(
        'Milvus',
        `Failed to create or verify collection for ${userId}.`
      );
      return;
    }

    const loadedColl = await ensureCollectionLoaded(
      intelligenceCollectionType,
      userId
    );
    if (!loadedColl) {
      logger.log('Milvus', `Failed to load collection for ${userId}.`);
      return;
    }

    const actions = await compareDocuments(directory, userId, collectionName);

    if (actions.missing.length > 0) {
      await upsertIntelligenceToMilvus(
        [...actions.missing],
        intelligenceCollectionType,
        userId
      );
      logger.log(
        'Milvus',
        `Adding ${actions.missing.length} documents to ${userId}'s intelligence collection...`
      );
    }

    if (actions.update.length > 0) {
      await upsertIntelligenceToMilvus(
        [...actions.update],
        intelligenceCollectionType,
        userId
      );
      logger.log(
        'Milvus',
        `Updating ${actions.update.length} documents from ${userId}'s intelligence collection...`
      );
    }

    if (actions.remove.length > 0) {
      await deleteVectorsFromMilvus(
        actions.remove.map((doc) => doc.relation),
        intelligenceCollectionType,
        userId
      );
      logger.log(
        'Milvus',
        `Removing ${actions.remove.length} documents from ${userId}'s intelligence collection...`
      );
    }
  } catch (error) {
    logger.log('Milvus', `Error processing files for ${userId}: ${error}`);
  }
}

/**
 * Start indexing vectors for a user
 */
export async function startIndexingVectors(userId: string): Promise<void> {
  const authObjects = await returnAuthObject(userId);
  logger.log('Milvus', `Beginning indexing for ${(authObjects as { user_id?: string })?.user_id}`);
  await processFiles(
    `${await retrieveConfigValue('milvus.localTextDirectory')}`,
    (authObjects as { user_id?: string })?.user_id || userId
  );
}
