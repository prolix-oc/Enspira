import axios from "axios";
import {
  inferSearchParam,
  searchSearXNG,
  retrieveWebContext,
  rerankString,
} from "./ai-logic.js";
import fs from "fs-extra";
import { Readability } from "@mozilla/readability";
import { join } from "path";
import * as cheerio from 'cheerio';
import { JSDOM } from "jsdom";
import { retrieveConfigValue } from './config-helper.js'

const userAgentStrings = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.2227.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Herring/97.1.8280.8"
];

/**
 * A structured error response for web RAG operations
 * @param {string} stage - The stage where the error occurred (e.g., 'search', 'retrieval')
 * @param {string} message - Human-readable error message
 * @param {object} [details] - Additional error details
 * @returns {object} - Structured error object
 */
export function createRagError(stage, message, details = null) {
  return {
    success: false,
    error: true,
    stage: stage,
    message: message,
    details: details,
    timestamp: new Date().toISOString()
  };
}

/**
 * Maintains a history of voice messages in a text file, adding new lines
 * and removing old ones to keep the file within a specified size limit.
 *
 * @param {string} newLine - The new line to add to the voice message history.
 * @returns {Promise<void>}
 */
async function maintainVoiceContext(newLine) {
  try {
    const chatContextPath = join(process.cwd(), "/world_info/voice_messages.txt");

    await fs.ensureFile(chatContextPath); // Ensures the file exists

    const currentContent = await fs.readFile(chatContextPath, "utf-8");
    const currentLines = currentContent.split("\n").filter(Boolean);

    currentLines.push("- " + newLine);

    // Remove oldest lines if the number of lines exceeds the limit
    while (currentLines.length > await retrieveConfigValue("twitch.maxChatsToSave")) {
      currentLines.shift();
    }

    await fs.writeFile(chatContextPath, currentLines.join("\n") + "\n");
  } catch (error) {
    logger.log("Voice Context", `Error maintaining voice context: ${error}`);
  }
}

/**
 * Reranks and filters a list of text contents based on their relevance to a given message.
 *
 * @param {Array} contextBody - An array of objects, each containing either 'text_content' or 'summary'.
 * @param {string} message - The message used for ranking relevance.
 * @param {string} userId - The ID of the user.
 * @param {boolean} requiresSearch - Indicates if a web search should be attempted if reranking results are poor.
 * @returns {Promise<string>} - A concatenated string of relevant content, or a default message if no relevant content is found.
 */
export async function resultsReranked(
  contextBody,
  message,
  userId,
  requiresSearch = false,
  cotReturn = false
) {
  try {
    if (!contextBody || !message) {
      logger.log("Embedding", "Missing contextBody or message parameter");
      return "- No additional information to provide.\n";
    }

    // Case 1: No documents at all - trigger web search immediately if allowed
    if (contextBody.length === 0) {
      logger.log("Embedding", "No context body provided for reranking.");
      
      if (requiresSearch) {
        logger.log("Embedding", "Attempting web search for additional context (no documents found)");
        const webResults = await startWebResults(message, userId);
        
        if (webResults && webResults.error) {
          if (webResults.optedOut) {
            return "- No additional context available for this query.\n";
          }
          logger.log("Search", `Web search failed: ${webResults.message}`);
          return "- Unable to find relevant information for this query.\n";
        }
        
        if (webResults) {
          return cotReturn ? [webResults] : webResults;
        }
        
        return "- No additional context provided for this section.";
      } else {
        return "- No additional context provided for this section.";
      }
    }
    
    // Process the documents for reranking
    let resultsRaw = [];
    let resultsTitle = [];
    
    if (!contextBody[0].relation) {
      resultsRaw = contextBody
        .map((item) => item.text_content || item.summary)
        .filter(Boolean);
      resultsTitle = contextBody
        .map((item) => item.relation)
        .filter(Boolean);
    } else {
      resultsRaw = contextBody
        .map((item) => item.text_content || item.summary)
        .filter(Boolean);
    }

    if (resultsRaw.length === 0) {
      logger.log("Embedding", "No valid content found in context body.");
      
      // Case 2: No valid content in documents - trigger web search if allowed
      if (requiresSearch) {
        logger.log("Embedding", "Attempting web search for additional context (no valid content)");
        const webResults = await startWebResults(message, userId);
        
        if (webResults && !webResults.error) {
          return cotReturn ? [webResults] : webResults;
        }
      }
      
      return "- No additional information to provide.\n";
    }

    // Get optimized query for reranking
    logger.log("Embedding", "Asking rerank helper to optimize...");
    let rerankOptimized = await rerankString(message, userId);
    
    if (rerankOptimized && rerankOptimized.error) {
      logger.log("Embedding", `Error optimizing rerank query: ${rerankOptimized.message}`);
      rerankOptimized = message;
    }

    // Perform the reranking
    const rerankData = {
      model: await retrieveConfigValue("models.rerank.model"),
      query: rerankOptimized,
      documents: resultsRaw,
      top_k: contextBody.length
    };

    logger.log("Embedding", `Starting rerank...`);
    
    try {
      const response = await axios.post(`${await retrieveConfigValue("models.rerank.endpoint")}/rerank`, rerankData, {
        headers: {
          "Content-Type": "application/json",
          "Accept-Encoding": "gzip, deflate, br",
          Connection: "keep-alive",
          Authorization: `Bearer ${await retrieveConfigValue("models.rerank.apiKey")}`
        },
        timeout: 10000,
      });

      logger.log("Embedding", `Rerank finished. Sorting results.`);
      const rerankedArray = response.data;

      // ADJUSTED RELEVANCE THRESHOLDS FOR LOGIT SCORES (-10 to 10 range)
      const HIGH_RELEVANCE_THRESHOLD = 6.0;    // Very high relevance (was 0.7)
      const ACCEPTABLE_THRESHOLD = 4.5;        // Good relevance (was 0.5)
      const LOW_RELEVANCE_THRESHOLD = 1.4;     // Low but possibly useful (new)
      
      // Count documents in each relevance category
      const highRelevanceCount = rerankedArray.filter(item => item.score >= HIGH_RELEVANCE_THRESHOLD).length;
      const acceptableCount = rerankedArray.filter(item => item.score >= ACCEPTABLE_THRESHOLD).length;
      const lowRelevanceCount = rerankedArray.filter(item => item.score < ACCEPTABLE_THRESHOLD).length;
      
      // Calculate average relevance of top 5 results
      const avgTopRelevance = rerankedArray
        .slice(0, 5)
        .reduce((sum, item) => sum + item.score, 0) / Math.min(5, rerankedArray.length);
      
      logger.log("Embedding", `Relevance stats - High (>=${HIGH_RELEVANCE_THRESHOLD}): ${highRelevanceCount}, ` +
        `Acceptable (>=${ACCEPTABLE_THRESHOLD}): ${acceptableCount}, Low: ${lowRelevanceCount}, ` +
        `Avg Top 5: ${avgTopRelevance.toFixed(2)}`);
      
      // Filter results based on the new acceptable threshold (5.0)
      let rerankProcessed = rerankedArray
        .filter(item => item.score >= ACCEPTABLE_THRESHOLD)
        .map(item => resultsRaw[parseInt(item.index)]);

      // If we have less than 3 acceptable results, include some lower-scoring ones
      if (rerankProcessed.length < 3) {
        logger.log("Embedding", `Not enough results above threshold ${ACCEPTABLE_THRESHOLD}. Including lower-scoring results.`);
        
        // Get additional items that didn't meet the acceptable threshold, but still have some relevance
        const additionalItems = rerankedArray
          .filter(item => item.score >= LOW_RELEVANCE_THRESHOLD && item.relevance_score < ACCEPTABLE_THRESHOLD)
          .map(item => resultsRaw[parseInt(item.index)]);
        
        // Add them to our processed results
        rerankProcessed = rerankProcessed.concat(additionalItems);
        
        // If we still don't have enough, just take the top 5
        if (rerankProcessed.length < 3) {
          rerankProcessed = rerankedArray
            .slice(0, 5)
            .map(item => resultsRaw[parseInt(item.index)]);
        }
      }

      // Trigger web search if ANY of these conditions are met:
      const shouldSearchWeb = requiresSearch && (
        // 1. We have fewer than 2 high-quality documents  
        highRelevanceCount < 2 || 
        // 2. Average top 5 score is below 6.0 (moderately relevant)
        avgTopRelevance < 6.0 ||
        // 3. More than 60% of results are below our acceptable threshold
        (lowRelevanceCount > 0 && lowRelevanceCount / rerankedArray.length > 0.6)
      );
      
      if (shouldSearchWeb) {
        logger.log(
          "Embedding", 
          `Attempting web search for additional context. Relevance too low: ` +
          `High: ${highRelevanceCount}, Avg: ${avgTopRelevance.toFixed(2)}, ` + 
          `Low Ratio: ${(lowRelevanceCount / rerankedArray.length).toFixed(2)}`
        );
        
        const augmentResult = await startWebResults(message, userId);
        
        if (augmentResult && augmentResult.error) {
          logger.log("Embedding", `Web search failed: ${augmentResult.message}`);
        } else if (augmentResult) {
          logger.log("Embedding", "Web search returned additional context, adding to results");
          rerankProcessed.push(augmentResult);
        }
      } else if (requiresSearch) {
        logger.log(
          "Embedding", 
          `Skipping web search - sufficient document quality. ` +
          `High: ${highRelevanceCount}, Acceptable: ${acceptableCount}, Avg: ${avgTopRelevance.toFixed(2)}`
        );
      }
      
      if (cotReturn) {
        return rerankProcessed;
      } else {
        return rerankProcessed.join("\n");
      }
    } catch (rerankError) {
      logger.log("Embedding", `Error during reranking: ${rerankError.message}`);
      
      // If reranking fails and search is allowed, try web search as fallback
      if (requiresSearch) {
        logger.log("Embedding", "Falling back to web search due to rerank failure");
        try {
          const webResults = await startWebResults(message, userId);
          if (webResults && !webResults.error) {
            return cotReturn ? [webResults] : webResults;
          }
        } catch (webError) {
          logger.log("Embedding", `Web search fallback also failed: ${webError.message}`);
        }
      }
      
      // Last resort: return the raw results limited to 5
      if (resultsRaw.length > 0) {
        const limitedResults = resultsRaw.slice(0, 5);
        return cotReturn ? limitedResults : limitedResults.join("\n");
      }
      
      return "- Error processing information. Using available context.\n";
    }
  } catch (error) {
    logger.log("Embedding", `Error in resultsReranked: ${error.stack}`);
    return createRagError('reranking', error.message, { stack: error.stack });
  }
}

export async function axiosRequestWithRetry(config, attempts = 3, initialDelay = 1000) {
  let delay = initialDelay;
  for (let i = 0; i < attempts; i++) {
    try {
      return await axios(config);
    } catch (error) {
      if (i === attempts - 1) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff
    }
  }
}

/**
 * Initiates a web search process for a given message and user ID.
 * It uses the message to infer a search query, performs a Brave search,
 * and then retrieves web context based on the search results.
 *
 * @param {string} message - The message to initiate the web search for.
 * @param {string} userId - The ID of the user performing the search.
 * @returns {Promise<string>} - The result of the web context retrieval, or an empty string if no query is inferred.
 */
export async function startWebResults(message, userId) {
  const queryResult = await inferSearchParam(message, userId);

  // Handle structured error from inferSearchParam
  if (!queryResult.success) {
    if (queryResult.optedOut) {
      logger.log("LLM", `Search opted out: ${queryResult.reason}`);
      return { 
        success: false, 
        optedOut: true, 
        reason: queryResult.reason,
        noSearchNeeded: true 
      };
    }
    
    logger.log("LLM", `Search parameter inference failed: ${queryResult.message}`);
    return queryResult; // Return the error object
  }

  try {
    const pmWebSearch = await searchSearXNG(queryResult.searchTerm, queryResult.freshness);
    
    // Check if searchSearXNG returned an error object
    if (pmWebSearch && pmWebSearch.error) {
      return pmWebSearch; // Already a properly formatted error
    }
    
    if (!pmWebSearch || pmWebSearch.length === 0) {
      return createRagError(
        'search-execution', 
        'No search results found',
        { searchTerm: queryResult.searchTerm, freshness: queryResult.freshness }
      );
    }
    
    logger.log("LLM", `Starting web search for '${queryResult.searchTerm}'`);
    const searchedResults = await retrieveWebContext(
      pmWebSearch,
      queryResult.searchTerm,
      queryResult.subject,
      userId
    );

    // Check if retrieveWebContext returned an error
    if (searchedResults && searchedResults.error) {
      return searchedResults;
    }

    return searchedResults || createRagError(
      'context-retrieval',
      'Failed to retrieve context from search results',
      { searchResults: pmWebSearch.length }
    );
  } catch (error) {
    logger.log("LLM", `Error in web search process: ${error.message}`);
    return createRagError('web-search', error.message, { stack: error.stack });
  }
}

/**
 * Classifies the emotions present in a given message using a specified classification model.
 * It sends the message to an embedding endpoint for classification and returns the ranked emotions.
 *
 * @param {string} message - The message to classify emotions from.
 * @returns {Promise<string>} - A string describing the ranked emotions in the message.
 */
const interpretEmotions = async (message) => {
  try {
    const classifyBody = {
      model: await retrieveConfigValue("models.classifier.model"),
      input: [message],
    };
    const response = await axios.post(`${await retrieveConfigValue("models.classifier.endpoint")}/classify`, classifyBody);
    const results = response.data.data[0];
    let emotionsResult = getEmotionRanking(results);
    return emotionsResult;
  } catch (error) {
    logger.log("Emotion", `Error in interpretEmotions: ${error}`);
    return "Error interpreting emotions.";
  }
};

/**
 * Pulls content from multiple web pages using Cheerio, parses, and cleans it.
 *
 * @param {Array} urls - An array of objects, each containing a URL to process.
 * @param {string} subject - The subject matter related to the URLs.
 * @returns {Promise<string>} - A concatenated string of cleaned content from all URLs, or an empty string if no content is found.
 */
const pullFromWeb = async (urls, subject) => {
  if (!urls || urls.length === 0) {
    logger.log("Augment", "No URLs provided for content extraction.");
    return "";
  }

  const fetchPromises = urls.map(async (link, index) => {
    try {
      const response = await axios.get(link.url, {
        headers: {
          "User-Agent":
            userAgentStrings[
            Math.floor(Math.random() * userAgentStrings.length)
            ],
        },
        timeout: 10000,
      });

      const $ = cheerio.load(response.data);

      // Remove script and style tags
      $("script, style").remove();

      // Get the HTML content after removing script and style tags
      const htmlContent = $.html();

      // Use Readability to extract the main content
      const document = new JSDOM(htmlContent); // Use JSDOM here
      const reader = new Readability(document.window.document);
      const article = reader.parse();

      if (!article) {
        logger.log("Augment", `Could not parse content from "${link.url}".`);
        return "";
      }

      const cleanContent = cleanContentWithNewlines(article.textContent);
      let content = "";

      if (index === 0) {
        content += `# Start of documents related to the subject "${subject}"`;
        content += `\n\n## From the web page "${link.source}", :\n\n${cleanContent}`;
      } else if (index === urls.length - 1) {
        content += `\n\n## From the web page "${link.url}", titled "${link.title}":\n\n${cleanContent}`;
        content += `\n\n# End of documents`;
      } else {
        content += `\n\n## From the web page "${link.url}" in regards to the subject matter "${subject}":\n\n${cleanContent}`;
      }

      return content;
    } catch (error) {
      logger.log("Augment", `Error processing URL "${link.url}": ${error}`);
      return "";
    }
  });

  const contents = await Promise.all(fetchPromises);
  const pageContentText = contents.filter(Boolean).join("\n\n");

  return pageContentText;
};

/**
 * Pulls content from multiple web pages using the scraper service
 * @param {Array} urls - Array of URL objects
 * @param {string} subject - The subject related to the URLs
 * @returns {Promise<string|object>} - Concatenated content or error object
 */
export async function pullFromWebScraper(urls, subject) {
  if (!urls || urls.length === 0) {
    return createRagError('scraping', 'No URLs provided for content extraction');
  }
  
  try {
    const fetchPromises = urls.map(async (link) => {
      try {
        const url = new URL(`${await retrieveConfigValue("server.externalScraper.endpoint")}/api/article`);
        url.searchParams.set("cache", await retrieveConfigValue("server.externalScraper.caching"));
        url.searchParams.set("resource", "document");
        url.searchParams.set("device", await retrieveConfigValue("server.externalScraper.deviceType"));
        url.searchParams.set("url", link.url);
        url.searchParams.set("format", "json");

        const response = await axios.get(url.toString(), { timeout: 15000 });
        
        // Check if the response has the expected structure
        if (!response.data || typeof response.data !== 'object') {
          logger.log("Augment", `Invalid response format for URL ${link.url}`);
          return "";
        }
        
        // Check for textContent property specifically
        if (!response.data.textContent || typeof response.data.textContent !== 'string') {
          logger.log("Augment", `No text content found for URL ${link.url}`);
          return "";
        }
        
        return `## From the web page "${link.source}", titled "${link.title}":\n\n${response.data.textContent}`;
      } catch (error) {
        logger.log("Augment", `Error processing URL "${link.url}": ${error.message}`);
        return ""; // Return empty string on error to be filtered later
      }
    });

    const contents = await Promise.all(fetchPromises);
    const validContents = contents.filter(Boolean);
    
    if (validContents.length === 0) {
      return createRagError(
        'scraping-results', 
        'No valid content extracted from any URL',
        { urlsAttempted: urls.length }
      );
    }

    // Construct the final page content text
    let pageContentText = `# Start of documents related to the subject "${subject}"\n\n`;
    pageContentText += validContents.join("\n\n");
    pageContentText += `\n\n# End of documents related to the subject "${subject}"`;

    return pageContentText;
  } catch (error) {
    logger.log("Augment", `Error in web scraping: ${error.message}`);
    return createRagError('scraping-execution', error.message);
  }
}

/**
 * Cleans a given text content by removing extra spaces and normalizing newlines.
 *
 * @param {string} content - The text content to clean.
 * @returns {string} - The cleaned text content.
 */
function cleanContentWithNewlines(content) {
  return content
    .replace(/\s+/g, " ")
    .replace(/(?:\s*\n\s*)+/g, "\n")
    .trim();
}

/**
 * Generates a description of the emotional tone conveyed in a message based on emotion classification results.
 *
 * @param {Array} emotions - An array of emotion objects, each with a 'label' and 'score'.
 * @returns {string} - A description of the emotional tone.
 */
const getEmotionRanking = (emotions) => {
  const getModifier = (score) => {
    if (score <= 0.33) {
      return "a bit of";
    } else if (score <= 0.66) {
      return "quite a bit of";
    } else {
      return "a lot of";
    }
  };

  const getEmotionDescription = (label) => {
    switch (label) {
      case "curious":
        return "a quizzical and curious vibe";
      case "surprise":
        return "shock and awe";
      case "think":
        return "curiosity";
      case "cheeky":
        return "cheeky banter";
      case "grumpy":
        return "a grumpy vibe";
      case "whiny":
        return "a whiny tone";
      case "empathetic":
        return "a sense of compassion";
      case "guilty":
        return "regret";
      case "anger":
        return "a heated emotion";
      case "disgust":
        return "a disgusted tone";
      case "impatient":
        return "frustration";
      case "energetic":
        return "an electrifying energy";
      case "joy":
        return "an uplifting and vibrant energy";
      case "serious":
        return "a stone-cold serious vibe";
      case "neutral":
        return "a lack of emotional energy";
      case "fear":
        return "a reserved or tense mood";
      case "love":
        return "a heartfelt or warm sentiment";
      case "confuse":
        return "a puzzled demeanor";
      case "suspicious":
        return "a doubtful tone";
      case "sadness":
        return "melancholy";
      default:
        return "an undefined or mixed feeling";
    }
  };

  const topEmotions = emotions.sort((a, b) => b.score - a.score).slice(0, 3);

  const messageParts = topEmotions.map(({ label, score }) => {
    const modifier = getModifier(score);
    const description = getEmotionDescription(label);
    return `${modifier} ${description}`;
  });

  const formattedMessage =
    messageParts.length > 1
      ? `${messageParts.slice(0, -1).join(", ")}, and ${messageParts.slice(-1)}`
      : messageParts[0];

  return `You feel that this message gives off ${formattedMessage}.`;
};

export {
  interpretEmotions,
  maintainVoiceContext,
  pullFromWeb,
};