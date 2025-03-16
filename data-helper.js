import axios from "axios";
import {
  inferSearchParam,
  searchBraveAPI,
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
/**
 * Reranks and filters a list of text contents based on their relevance to a given message.
 *
 * @param {Array} contextBody - An array of objects, each containing either 'text_content' or 'summary'.
 * @param {string} message - The message used for ranking relevance.
 * @param {string} userId - The ID of the user.
 * @param {boolean} requiresSearch - Indicates if a web search should be attempted if reranking results are poor.
 * @returns {Promise<string>} - A concatenated string of relevant content, or a default message if no relevant content is found.
 */
const resultsReranked = async (
  contextBody,
  message,
  userId,
  requiresSearch = false,
  cotReturn = false
) => {
  try {
    if (!contextBody || !message) {
      logger.log("Embedding", "Missing contextBody or message parameter");
      return "- No additional information to provide.\n";
    }

    if (contextBody.length === 0) {
      logger.log("Embedding", "No context body provided for reranking.");
      return "- No additional context provided for this section.";
    }
    let resultsRaw = []
    let resultsTitle = []
    if (!contextBody[0].relation) {
      resultsRaw = contextBody
        .map((item) => item.text_content || item.summary)
        .filter(Boolean);
      resultsTitle = contextBody
        .map((item) => item.relation)
        .filter(Boolean)
    } else {
      resultsRaw = contextBody
        .map((item) => item.text_content || item.summary)
        .filter(Boolean);
    }

    if (resultsRaw.length === 0) {
      logger.log("Embedding", "No valid content found in context body.");
      return "- No additional information to provide.\n";
    }

    logger.log("Embedding", "Asking rerank helper to optimize...");
    const rerankOptimized = await rerankString(message, userId);

    const rerankData = {
      model: await retrieveConfigValue("models.rerank.model"),
      query: rerankOptimized,
      documents: resultsRaw,
    };

    logger.log("Embedding", `Starting rerank...`);
    const response = await axios.post(`${await retrieveConfigValue("models.rerank.endpoint")}/rerank`, rerankData, {
      headers: {
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
      },
      timeout: 30000,
    });

    logger.log("Embedding", `Rerank finished. Sorting results.`);
    const rerankedArray = response.data.results;
    let rerankedMissed = 0;

    let rerankProcessed = rerankedArray.filter((item) => {
      if (item.relevance_score > 0.5) {
        return true;
      } else {
        rerankedMissed++;
        return false;
      }
    })
      .map((item) => resultsRaw[parseInt(item.index)]);

    // Fallback to top results if not enough high-scoring matches
    if (rerankProcessed.length < 5) {
      logger.log(
        "Embedding",
        `Not enough high-scoring matches, taking top 5 results.`
      );
      rerankProcessed = rerankedArray
        .slice(0, 5)
        .map((item) => resultsRaw[parseInt(item.index)]);
    }

    // Attempt web search if too many misses and search is required
    if (requiresSearch && rerankedMissed > rerankProcessed.length - 2) {
      logger.log(
        "Embedding",
        `Attempting web search for additional context. Missed: ${rerankedMissed}, Processed: ${rerankProcessed.length}`
      );
      const augmentResult = await startWebResults(message, userId);
      if (augmentResult) {
        rerankProcessed.push(augmentResult);
      }
    }
    if (cotReturn) {
      return rerankProcessed
    } else {
      return rerankProcessed.join("\n");
    }
  } catch (error) {
    logger.log("Embedding", `Error in resultsReranked: ${error.stack}`);
    return "- Error processing information.\n";
  }
};

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
async function startWebResults(message, userId) {
  const query = await inferSearchParam(message, userId);

  if (query == false) {
    return "";
  }

  const pmWebSearch = await searchSearXNG(query.searchTerm, query.freshness);
  logger.log("LLM", `Starting web search for '${query.searchTerm}'`);
  const searchedResults = await retrieveWebContext(
    pmWebSearch,
    query.searchTerm,
    query.subject,
    userId
  );

  return searchedResults;
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

const pullFromWebScraper = async (urls, subject) => {
  if (!urls || urls.length === 0) {
    logger.log("Augment", "No URLs provided for content extraction.");
    return "";
  }
  const fetchPromises = urls.map(async (link) => { // Remove index, we don't need it for headers anymore
    try {
      const url = new URL(`${await retrieveConfigValue("server.externalScraper.endpoint")}/api/article`);
      url.searchParams.set("cache", await retrieveConfigValue("server.externalScraper.caching"));
      url.searchParams.set("resource", "document");
      url.searchParams.set("device", await retrieveConfigValue("server.externalScraper.deviceType"));
      url.searchParams.set("url", link.url);
      url.searchParams.set("format", "json");

      const response = await axios.get(url.toString());
      const content = `## From the web page "${link.source}", titled "${link.title}":\n\n${response.data.textContent}`; // Format content for each page

      return content; // Return the content for this URL
    } catch (error) {
      logger.log("Augment", `Error processing URL "${link.url}": ${error}`);
      return ""; // Return empty string on error to be filtered later
    }
  });

  const contents = await Promise.all(fetchPromises); // Wait for all requests to complete

  // Construct the final page content text
  let pageContentText = `# Start of documents related to the subject "${subject}"\n\n`; // Add initial header
  const validContents = contents.filter(Boolean); // Filter out any empty strings (from errors)
  pageContentText += validContents.join("\n\n"); // Join valid content with separators

  return pageContentText;
};

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
  resultsReranked,
  pullFromWeb,
  pullFromWebScraper
};