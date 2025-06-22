import fs from "fs-extra";
import moment from "moment";
import { socialMedias } from "./twitch-helper.js";
import { interpretEmotions } from "./data-helper.js";
import { returnAuthObject } from "./api-helper.js";
import {
  promptTokenizedFromRemote,
} from "./token-helper.js";
import { retrieveConfigValue } from "./config-helper.js";
import { returnRecentChats } from "./ai-logic.js";
import {
  ChatRequestBody,
  ChatRequestBodyCoT,
  ToolRequestBody,
  QueryRequestBody,
  ModerationRequestBody,
  SummaryRequestBody,
} from "./oai-requests.js";
import { jsonrepair } from "jsonrepair";
import OpenAI from "openai";
import { performance } from "node:perf_hooks";
import { logger } from "./create-global-logger.js";
import { utils } from "./utils/index.js";

const { getTemplate } = utils.file;
const { replacePlaceholders } = utils.string;
const { withErrorHandling } = utils.error;

// FIXED: Bounded template cache with LRU eviction
const MAX_TEMPLATE_CACHE_SIZE = 50;
const templateCache = new Map();

// FIXED: Add template cache management
function addToTemplateCache(key, value) {
  if (templateCache.size >= MAX_TEMPLATE_CACHE_SIZE) {
    // Remove oldest entry
    const firstKey = templateCache.keys().next().value;
    templateCache.delete(firstKey);
  }
  templateCache.set(key, value);
}

// FIXED: Enhanced OpenAI client pool to prevent connection leaks
const clientPool = new Map();
const MAX_CLIENT_POOL_SIZE = 5;

function getOpenAIClient(endpoint, apiKey) {
  const key = `${endpoint}_${apiKey?.substring(0, 8)}`;
  
  if (clientPool.has(key)) {
    return clientPool.get(key);
  }
  
  // Remove oldest client if pool is full
  if (clientPool.size >= MAX_CLIENT_POOL_SIZE) {
    const firstKey = clientPool.keys().next().value;
    const oldClient = clientPool.get(firstKey);
    // Cleanup old client if it has cleanup methods
    if (oldClient?.destroy) {
      oldClient.destroy();
    }
    clientPool.delete(firstKey);
  }
  
  const client = new OpenAI({
    baseURL: endpoint,
    apiKey: apiKey,
    timeout: 60000,
    maxRetries: 0,
  });
  
  clientPool.set(key, client);
  return client;
}

/**
 * Helper function to extract all social media replacements for templates.
 * Gets both the full socials string and individual platform entries.
 *
 * @param {string} userId - The user ID
 * @returns {Promise<object>} - Object containing all social media replacements
 */
async function getSocialMediaReplacements(userId) {
  try {
    // Get the complete socials string for {{socials}} replacement
    const allSocials = await socialMedias(userId);

    // Create the base replacements object
    const replacements = {
      "{{socials}}": allSocials || "",
    };

    // Get all available platforms for the user
    const socialPlatforms = await socialMedias(userId, "all");

    // Add individual platform replacements
    for (const [platform, value] of Object.entries(socialPlatforms)) {
      if (value && value.trim() !== "") {
        replacements[`{{socials.${platform}}}`] = value;
      }
    }

    // Add specific commonly used platform shortcuts
    // These are kept for backward compatibility
    replacements["{{soc_tiktok}}"] =
      (await socialMedias(userId, "tiktok")) || "";
    replacements["{{soc_youtube}}"] =
      (await socialMedias(userId, "youtube")) || "";
    replacements["{{soc_twitter}}"] =
      (await socialMedias(userId, "twitter")) || "";
    replacements["{{soc_instagram}}"] =
      (await socialMedias(userId, "instagram")) || "";

    return replacements;
  } catch (error) {
    logger.log(
      "System",
      `Error getting social media replacements: ${error.message}`
    );
    return { "{{socials}}": "" };
  }
}

/**
 * Sends a chat completion request for tool tasks like query writing and reranking.
 * FIXED: Proper memory management and response size limits.
 *
 * @param {object} requestBody - The request body for the completion.
 * @param {object} modelConfig - Configuration for the model.
 * @returns {Promise<object>} - The completion response.
 */
export async function sendToolCompletionRequest(requestBody, modelConfig) {
  const openai = getOpenAIClient(modelConfig.endpoint, modelConfig.apiKey);
  const startTime = performance.now();
  let fullResponse = "";
  const MAX_RESPONSE_SIZE = 25000; // FIXED: Reduced from 50KB to 25KB

  let stream = null;
  
  try {
    stream = await openai.chat.completions.create({
      ...requestBody,
      stream: true,
    });

    for await (const part of stream) {
      const content = part.choices[0]?.delta?.content;
      if (content) {
        // FIXED: Check size limit before concatenation
        if (fullResponse.length + content.length > MAX_RESPONSE_SIZE) {
          logger.log(
            "API",
            `Tool response approaching ${MAX_RESPONSE_SIZE / 1000}KB limit, truncating`
          );
          break;
        }
        fullResponse += content;
      }
    }

    // Calculate total processing time
    const totalTime = (performance.now() - startTime) / 1000;

    // For JSON responses, make sure we have valid JSON
    if (requestBody.response_format?.type === "json_schema") {
      if (typeof fullResponse === "object" && fullResponse !== null) {
        return {
          response: fullResponse,
          rawResponse: JSON.stringify(fullResponse),
          processingTime: totalTime.toFixed(3),
        };
      }

      try {
        const jsonResponse = JSON.parse(fullResponse);
        return {
          response: jsonResponse,
          rawResponse: fullResponse,
          processingTime: totalTime.toFixed(3),
        };
      } catch (jsonError) {
        try {
          const fixedResponse = jsonrepair(fullResponse);
          const jsonResponse = JSON.parse(fixedResponse);
          logger.log("API", "Fixed malformed JSON in tool response");
          return {
            response: jsonResponse,
            rawResponse: fixedResponse,
            processingTime: totalTime.toFixed(3),
            jsonFixed: true,
          };
        } catch (repairError) {
          logger.log(
            "API",
            `Failed to parse JSON response: ${jsonError.message}`
          );
          return {
            error: "JSON parsing failed",
            rawResponse: fullResponse.substring(0, 1000),
            processingTime: totalTime.toFixed(3),
          };
        }
      }
    }

    return {
      response: fullResponse,
      processingTime: totalTime.toFixed(3),
    };
  } catch (error) {
    logger.log(
      "API",
      `Tool completion error: ${error}; Model: ${modelConfig.model}`
    );
    return { error: error.message };
  } finally {
    // FIXED: Ensure stream is properly closed
    if (stream && typeof stream.controller?.abort === 'function') {
      stream.controller.abort();
    }
    // FIXED: Clear references
    stream = null;
    fullResponse = null;
  }
}

export async function sendChatCompletionRequest(
  requestBody,
  modelConfig,
  userObj = null
) {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  let stream = null;
  let fullResponse = "";
  let thinkingStuff = "";

  try {
    // FIXED: Validate model configuration
    logger.log("API", `[${requestId}] Starting chat completion request`);

    if (!modelConfig?.endpoint || !modelConfig?.apiKey || !modelConfig?.model) {
      throw new Error("Invalid model configuration - missing endpoint, apiKey, or model");
    }

    if (!requestBody?.messages?.length) {
      throw new Error("Invalid request body: missing or empty messages array");
    }

    // FIXED: Use client pool instead of creating new instances
    const openai = getOpenAIClient(modelConfig.endpoint, modelConfig.apiKey);

    const startTime = performance.now();
    let firstTokenTimeElapsed = null;
    let backendStartTime;
    const MAX_RESPONSE_SIZE = 75000; // FIXED: Reduced from 100KB to 75KB

    // FIXED: Remove debug file creation entirely - major memory leak source
    // Replaced with simple logging for debugging if needed
    if (process.env.DEBUG_CHAT_REQUESTS === 'true') {
      logger.log("API", `[${requestId}] Request details:`, {
        endpoint: modelConfig.endpoint,
        model: requestBody.model || modelConfig.model,
        messageCount: requestBody.messages.length,
      });
    }

    logger.log("API", `[${requestId}] Sending request to vLLM...`);

    try {
      stream = await openai.chat.completions.create({
        ...requestBody,
        stream: true,
      });
      logger.log("API", `[${requestId}] Successfully created stream connection to vLLM`);
    } catch (streamError) {
      logger.error("API", `[${requestId}] Failed to create stream to vLLM:`, {
        error: streamError.message,
        code: streamError.code,
        status: streamError.status,
      });

      if (streamError.message.includes("ECONNREFUSED")) {
        throw new Error(`Cannot connect to vLLM at ${modelConfig.endpoint} - connection refused. Is vLLM running?`);
      } else if (streamError.message.includes("ENOTFOUND")) {
        throw new Error(`Cannot resolve hostname for vLLM endpoint: ${modelConfig.endpoint}`);
      } else if (streamError.message.includes("timeout")) {
        throw new Error(`Connection to vLLM timed out at ${modelConfig.endpoint}`);
      } else {
        throw new Error(`vLLM connection error: ${streamError.message}`);
      }
    }

    logger.log("API", `[${requestId}] Processing response stream...`);

    try {
      for await (const part of stream) {
        const content = part.choices[0]?.delta?.content;
        const thinkContent = part.choices[0]?.delta?.reasoning_content;
        
        if (content) {
          if (firstTokenTimeElapsed === null) {
            firstTokenTimeElapsed = (performance.now() - startTime) / 1000;
            backendStartTime = performance.now();
            logger.log("API", `[${requestId}] First token received after ${firstTokenTimeElapsed.toFixed(3)} seconds`);
          }

          // FIXED: Check size before concatenation
          if (fullResponse.length + content.length > MAX_RESPONSE_SIZE) {
            logger.log("API", `[${requestId}] Response exceeded ${MAX_RESPONSE_SIZE / 1000}KB limit, truncating`);
            fullResponse += "\n\n[Response truncated due to length limits]";
            break;
          }
          fullResponse += content;
        } else if (thinkContent) {
          if (firstTokenTimeElapsed === null) {
            firstTokenTimeElapsed = (performance.now() - startTime) / 1000;
            backendStartTime = performance.now();
            logger.log("API", `[${requestId}] First thought token received after ${firstTokenTimeElapsed.toFixed(3)} seconds`);
          }

          // FIXED: Check size before concatenation
          if (thinkingStuff.length + thinkContent.length > MAX_RESPONSE_SIZE) {
            logger.log("API", `[${requestId}] Thinking response exceeded ${MAX_RESPONSE_SIZE / 1000}KB limit, truncating`);
            thinkingStuff += "\n\n[Response truncated due to length limits]";
            break;
          }
          thinkingStuff += thinkContent;
        }
      }
    } catch (streamProcessError) {
      logger.error("API", `[${requestId}] Error processing stream:`, {
        error: streamProcessError.message,
        responseLength: fullResponse.length,
      });

      if (fullResponse.length === 0 && thinkingStuff.length === 0) {
        throw new Error(`Stream processing failed: ${streamProcessError.message}`);
      } else {
        logger.warn("API", `[${requestId}] Stream ended with error but got partial response (${fullResponse.length} chars)`);
      }
    }

    const backendTimeElapsed = backendStartTime ? (performance.now() - backendStartTime) / 1000 : 0;

    logger.log("API", `[${requestId}] Response completed:`, {
      responseLength: fullResponse.length,
      thoughtResponseLength: thinkingStuff.length,
      firstTokenTime: firstTokenTimeElapsed?.toFixed(3),
      totalTime: ((performance.now() - startTime) / 1000).toFixed(3),
      backendTime: backendTimeElapsed.toFixed(3),
    });

    if (!fullResponse || fullResponse.trim() === "") {
      throw new Error("Received empty response from vLLM");
    }

    // FIXED: More efficient tokenization with error handling
    let generatedTokens;
    try {
      generatedTokens = await promptTokenizedFromRemote(fullResponse);
    } catch (tokenizationError) {
      logger.warn("API", `[${requestId}] Tokenization failed: ${tokenizationError.message}`);
      generatedTokens = Math.ceil(fullResponse.length / 4);
    }

    let backendTokensPerSecond = 0;
    if (backendTimeElapsed > 0 && generatedTokens > 0) {
      backendTokensPerSecond = (generatedTokens / backendTimeElapsed).toFixed(2);
    }

    // FIXED: Remove debug file creation for completion - major memory leak source
    // Only create debug files in development mode if explicitly enabled
    if (process.env.NODE_ENV === 'development' && process.env.DEBUG_SAVE_RESPONSES === 'true') {
      try {
        await fs.writeJSON(`./debug/chat-response-${requestId}.json`, {
          response: fullResponse.substring(0, 5000), // Only save first 5KB
          thinking: thinkingStuff.substring(0, 5000),
          timestamp: new Date().toISOString(),
        });
      } catch (debugError) {
        // Don't fail the request if debug saving fails
        logger.warn("API", `[${requestId}] Could not save debug file: ${debugError.message}`);
      }
    }

    // Enhanced thought process extraction
    let thoughtProcess = "";
    let finalResponse = "";

    const startTag = "<think>";
    const endTag = " </think>";
    const startTagIndex = fullResponse.indexOf(startTag);
    const endTagIndex = fullResponse.indexOf(endTag);
    
    if (startTagIndex !== -1 && endTagIndex !== -1 && endTagIndex > startTagIndex) {
      thoughtProcess = fullResponse.substring(startTagIndex + startTag.length, endTagIndex).trim();
      finalResponse = fullResponse.substring(endTagIndex + endTag.length).trim();
    } else if (startTagIndex === -1 && endTagIndex !== -1) {
      thoughtProcess = fullResponse.substring(0, endTagIndex).trim();
      finalResponse = fullResponse.substring(endTagIndex + endTag.length).trim();
    } else if (fullResponse.includes(" \n</think>")) {
      let currentPos = 0;
      let thoughts = [];
      let lastEndTagPos = -1;

      while (true) {
        const nextStartTag = fullResponse.indexOf(startTag, currentPos);
        const nextEndTag = fullResponse.indexOf(endTag, currentPos);

        if (nextEndTag === -1) break;
        lastEndTagPos = nextEndTag;

        if (nextStartTag !== -1 && nextStartTag < nextEndTag) {
          thoughts.push(fullResponse.substring(nextStartTag + startTag.length, nextEndTag).trim());
          currentPos = nextEndTag + endTag.length;
        } else {
          if (thoughts.length === 0 && nextStartTag === -1) {
            thoughts.push(fullResponse.substring(0, nextEndTag).trim());
          } else {
            thoughts.push(fullResponse.substring(currentPos, nextEndTag).trim());
          }
          currentPos = nextEndTag + endTag.length;
        }
      }

      thoughtProcess = thoughts.join("\n");
      if (lastEndTagPos !== -1) {
        finalResponse = fullResponse.substring(lastEndTagPos + endTag.length).trim();
      } else {
        finalResponse = fullResponse;
      }
    } else {
      finalResponse = fullResponse.trim();
    }

    logger.log("API", `[${requestId}] Request completed successfully:`, {
      finalResponseLength: finalResponse.length,
      thoughtProcessLength: thoughtProcess.length,
      tokensPerSecond: backendTokensPerSecond,
    });

    return {
      response: finalResponse,
      thoughtProcess,
      timeToFirstToken: firstTokenTimeElapsed ? firstTokenTimeElapsed.toFixed(3) : null,
      tokensPerSecond: backendTokensPerSecond,
      requestId: requestId,
      metadata: {
        totalTokens: generatedTokens,
        totalTime: ((performance.now() - startTime) / 1000).toFixed(3),
        endpoint: modelConfig.endpoint,
        model: requestBody.model || modelConfig.model,
      },
    };
  } catch (error) {
    logger.error("API", `[${requestId}] OpenAI chat completion error:`, {
      error: error.message,
      model: modelConfig?.model || "unknown",
      endpoint: modelConfig?.endpoint || "unknown",
    });

    return {
      error: error.message,
      requestId: requestId,
      details: {
        endpoint: modelConfig?.endpoint,
        model: modelConfig?.model,
        hasApiKey: !!modelConfig?.apiKey,
      },
    };
  } finally {
    // FIXED: Ensure proper cleanup
    if (stream && typeof stream.controller?.abort === 'function') {
      stream.controller.abort();
    }
    // Clear references to help garbage collection
    stream = null;
    fullResponse = null;
    thinkingStuff = null;
  }
}

export async function sendChatCompletionRequestCoT(requestBody, modelConfig) {
  // FIXED: Use client pool
  const openai = getOpenAIClient(modelConfig.endpoint, modelConfig.apiKey);
  const startTime = performance.now();
  let firstTokenTimeElapsed = null;
  let backendStartTime;
  let fullResponse = "";
  let stream = null;

  try {
    stream = await openai.chat.completions.create({
      ...requestBody,
      stream: true,
    });

    for await (const part of stream) {
      const content = part.choices[0]?.delta?.content;
      if (content) {
        if (firstTokenTimeElapsed === null) {
          firstTokenTimeElapsed = (performance.now() - startTime) / 1000;
          backendStartTime = performance.now();
        }
        
        // FIXED: Size limit check
        if (fullResponse.length + content.length > 50000) {
          logger.log("API", "CoT response approaching 50KB limit, truncating");
          break;
        }
        fullResponse += content;
      }
    }

    const backendTimeElapsed = (performance.now() - backendStartTime) / 1000;

    // Tokenize the full response
    let generatedTokens;
    try {
      generatedTokens = await promptTokenizedFromRemote(fullResponse, modelConfig.modelType);
    } catch (tokenizationError) {
      logger.log("API", `Error tokenizing CoT response: ${tokenizationError}. Using character-based estimate.`);
      generatedTokens = Math.ceil(fullResponse.length / 4);
    }

    let backendTokensPerSecond = 0;
    if (backendTimeElapsed > 0 && generatedTokens > 0) {
      backendTokensPerSecond = (generatedTokens / backendTimeElapsed).toFixed(2);
    }

    // Attempt to parse the JSON response with multiple fallback mechanisms
    let formattedResponse;
    let thoughtsArray = [];
    let fullOutput = null;

    try {
      try {
        formattedResponse = JSON.parse(fullResponse);
      } catch (initialParseError) {
        logger.log("API", `Initial JSON parse failed, trying jsonrepair: ${initialParseError.message}`);
        const fixedResponse = jsonrepair(fullResponse);
        formattedResponse = JSON.parse(fixedResponse);
      }

      // Process thoughts array safely
      if (formattedResponse.thoughts) {
        if (Array.isArray(formattedResponse.thoughts)) {
          thoughtsArray = formattedResponse.thoughts.filter(thought => thought && thought !== "");
        } else if (Array.isArray(formattedResponse.thoughts) && formattedResponse.thoughts.length > 0 && formattedResponse.thoughts[0].thought) {
          thoughtsArray = formattedResponse.thoughts.map(t => t.thought).filter(thought => thought && thought !== "");
        } else {
          logger.log("API", "Invalid thoughts format in response, using empty array");
          thoughtsArray = [];
        }
      }

      fullOutput = formattedResponse.final_response || formattedResponse.response || "";

      // FIXED: More aggressive truncation
      if (fullOutput && fullOutput.length > 50000) {
        logger.log("API", `CoT response too large (${fullOutput.length} bytes), truncating`);
        fullOutput = fullOutput.substring(0, 50000) + "\n[Response truncated due to length...]";
      }
    } catch (parseError) {
      logger.log("API", `Error parsing JSON response: ${parseError}; Response: ${fullResponse.substring(0, 500)}...`, "error");

      try {
        const finalResponseMatch = fullResponse.match(/"final_response"\s*:\s*"([^"]+)"/);
        if (finalResponseMatch && finalResponseMatch[1]) {
          fullOutput = finalResponseMatch[1];
        } else {
          fullOutput = "I apologize, but I encountered an error processing your message.";
        }
        logger.error("API", `All JSON parsing attempts failed. Constructed basic response.`);
        thoughtsArray = ["Error parsing JSON response"];
      } catch (emergencyError) {
        logger.error("API", `Emergency parsing also failed: ${emergencyError.message}`);
        return {
          error: `Error parsing JSON: ${parseError.message}`,
          rawResponse: fullResponse.substring(0, 1000),
        };
      }
    }

    return {
      response: fullOutput,
      thoughtProcess: thoughtsArray,
      timeToFirstToken: firstTokenTimeElapsed ? firstTokenTimeElapsed.toFixed(2) : null,
      tokensPerSecond: backendTokensPerSecond,
    };
  } catch (error) {
    logger.log("API", `OpenAI chat completion error: ${error}; Model Config: ${JSON.stringify(modelConfig)}`, "error");
    return { error: error.message };
  } finally {
    // FIXED: Ensure proper cleanup
    if (stream && typeof stream.controller?.abort === 'function') {
      stream.controller.abort();
    }
    stream = null;
    fullResponse = null;
  }
}

// FIXED: Cache management for moderation prompts
const moderationPromptCache = new Map();
const MAX_MODERATION_CACHE = 25;

const moderatorPrompt = async (message, userId) => {
  const cacheKey = `${userId}_moderation`;
  
  if (moderationPromptCache.has(cacheKey)) {
    const cached = moderationPromptCache.get(cacheKey);
    if (Date.now() - cached.timestamp < 300000) { // 5 minutes
      return { ...cached.prompt, messages: [...cached.prompt.messages, { role: "user", content: message }] };
    }
  }

  const userObject = await returnAuthObject(userId);
  const instructTemplate = await withErrorHandling(
    () => getTemplate(`./instructs/helpers/moderation.prompt`),
    {
      context: "Templates",
      defaultValue: "",
      logError: true,
    }
  );
  
  const socialReplacements = await getSocialMediaReplacements(userId);

  const replacements = {
    "{{user}}": userObject.user_name,
    "{{char}}": userObject.bot_name,
    "{{twitch}}": userObject.twitch_name,
    "{{modlist}}": userObject.mod_list.join("\n- "),
    "{{sites}}": userObject.approved_sites.join("\n- "),
    ...socialReplacements,
  };

  const instructionTemplate = replacePlaceholders(instructTemplate, replacements);
  const promptWithSamplers = await ModerationRequestBody.create(
    instructionTemplate,
    await retrieveConfigValue("models.moderator.model"),
    message
  );

  // FIXED: Cache management
  if (moderationPromptCache.size >= MAX_MODERATION_CACHE) {
    const firstKey = moderationPromptCache.keys().next().value;
    moderationPromptCache.delete(firstKey);
  }
  
  moderationPromptCache.set(cacheKey, {
    prompt: promptWithSamplers,
    timestamp: Date.now()
  });

  logger.log(
    "LLM",
    `Moderation prompt is using ${await promptTokenizedFromRemote(
      promptWithSamplers.messages
    )} of your available ${await retrieveConfigValue("models.moderator.maxTokens")} tokens.`
  );
  return promptWithSamplers;
};

/**
 * FIXED: Optimized contextPromptChat with better memory management
 */
const contextPromptChat = async (promptData, message, userID) => {
  const currentAuthObject = await returnAuthObject(userID);
  
  // FIXED: Use cache for templates
  const templateCacheKey = 'system_prompt';
  let instructTemplate;
  
  if (templateCache.has(templateCacheKey)) {
    instructTemplate = templateCache.get(templateCacheKey);
  } else {
    instructTemplate = await withErrorHandling(
      () => getTemplate(`./instructs/system.prompt`),
      {
        context: "Templates",
        defaultValue: "",
        logError: true,
      }
    );
    addToTemplateCache(templateCacheKey, instructTemplate);
  }

  const timeStamp = moment().format("dddd, MMMM Do YYYY, [at] hh:mm A");

  // Load all necessary files in parallel for better performance
  const fileContents = await readPromptFiles(userID, [
    "character_personality",
    "world_lore",
    "scenario",
    "character_card",
    "weather",
    "twitch_chat",
    "player_info",
    "voice_messages",
  ]);

  const sentiment = await interpretEmotions(message);
  logger.log("LLM", `Analysis of emotions: ${sentiment}`);
  const user = promptData.chat_user;

  const socialReplacements = await getSocialMediaReplacements(userID);

  const commonReplacements = {
    "{{user}}": currentAuthObject.user_name,
    "{{char}}": currentAuthObject.bot_name,
    "{{char_limit}}": await retrieveConfigValue("twitch.maxCharLimit"),
    "{{chat_user}}": user,
    "{{model_author}}": await retrieveConfigValue("models.chat.author"),
    "{{model_org}}": await retrieveConfigValue("models.chat.organization"),
    ...socialReplacements,
  };

  const systemPrompt = replacePlaceholders(instructTemplate, commonReplacements);

  const structuredPromptData = {
    systemPrompt: systemPrompt,
    characterDescription: fileContents.character_card
      ? `# ${currentAuthObject.bot_name}'s Description:\n${replacePlaceholders(fileContents.character_card, commonReplacements)}`
      : null,
    characterPersonality: fileContents.character_personality
      ? `# ${currentAuthObject.bot_name}'s Personality:\n${replacePlaceholders(fileContents.character_personality, commonReplacements)}`
      : null,
    worldInfo: fileContents.world_lore
      ? `# World Information:\nUse this information to reflect the world and context around ${currentAuthObject.bot_name}:\n${replacePlaceholders(fileContents.world_lore, commonReplacements)}`
      : null,
    scenario: fileContents.scenario
      ? `# Scenario:\n${replacePlaceholders(fileContents.scenario, commonReplacements)}`
      : null,
    playerInfo: fileContents.player_info
      ? `# Information about ${currentAuthObject.user_name}:\nThis is pertinent information regarding ${currentAuthObject.user_name} that you should always remember.\n${replacePlaceholders(fileContents.player_info, commonReplacements)}`
      : null,
    recentChat: `# Current Messages from Chat:\nUp to the last ${await retrieveConfigValue("twitch.maxChatsToSave")} messages are provided to you from ${currentAuthObject.user_name}'s Twitch chat. Use these messages to keep up with the current conversation:\n${await returnRecentChats(userID)}`,
    weatherInfo:
      currentAuthObject.weather && fileContents.weather
        ? `# Current Weather:\n${replacePlaceholders(fileContents.weather, commonReplacements)}`
        : null,
    additionalContext: {
      contextResults: promptData.relContext
        ? `# Additional Information:\nExternal context relevant to the conversation:\n${promptData.relContext}`
        : null,
      chatHistory: promptData.relChats
        ? `# Other Relevant Chat Context:\nBelow are potentially relevant chat messages sent previously, that may be relevant to the conversation:\n${promptData.relChats}`
        : null,
      voiceInteractions: promptData.relVoice
        ? `# Previous Voice Interactions:\nNon-exhaustive list of prior vocal interactions you've had with ${currentAuthObject.user_name}:\n${promptData.relVoice}`
        : null,
      recentVoice: fileContents.voice_messages
        ? `# Current Voice Conversations with ${currentAuthObject.user_name}:\nUp to the last ${await retrieveConfigValue("twitch.maxChatsToSave")} voice messages are provided to you. Use these voice messages to help you keep up with the current conversation:\n${fileContents.voice_messages}`
        : null,
      emotionalAssessment: sentiment
        ? `# Current Emotional Assessment of Message:\n- ${sentiment}`
        : null,
      dateTime: `# Current Date and Time:\n- The date and time where you and ${currentAuthObject.user_name} live is currently: ${timeStamp}`,
    },
    userMessage: `${promptData.chat_user} says: "${message}"`,
  };

  const promptWithSamplers = await ChatRequestBody.create(structuredPromptData);

  logger.log(
    "LLM",
    `Chat prompt is using ${await promptTokenizedFromRemote(
      promptWithSamplers.messages
    )} of your available ${await retrieveConfigValue(
      "models.chat.maxTokens"
    )} tokens.`
  );

  return promptWithSamplers;
};

// FIXED: Similar optimizations for other prompt functions...
const contextPromptChatCoT = async (promptData, message, userID) => {
  const currentAuthObject = await returnAuthObject(userID);
  
  const templateCacheKey = 'system_cot_prompt';
  let instructTemplate;
  
  if (templateCache.has(templateCacheKey)) {
    instructTemplate = templateCache.get(templateCacheKey);
  } else {
    instructTemplate = await withErrorHandling(
      () => getTemplate(`./instructs/system_cot.prompt`),
      {
        context: "Templates",
        defaultValue: "",
        logError: true,
      }
    );
    addToTemplateCache(templateCacheKey, instructTemplate);
  }
  
  const timeStamp = moment().format("dddd, MMMM Do YYYY, [at] hh:mm A");

  const fileContents = await readPromptFiles(userID, [
    "character_personality",
    "world_lore", 
    "scenario",
    "character_card",
    "weather",
    "twitch_chat",
    "player_info",
    "voice_messages",
  ]);

  const sentiment = await interpretEmotions(message);
  logger.log("LLM", `Analysis of emotions: ${sentiment}`);

  const socialReplacements = await getSocialMediaReplacements(userID);

  const commonReplacements = {
    "{{user}}": currentAuthObject.user_name,
    "{{char}}": currentAuthObject.bot_name,
    "{{char_limit}}": await retrieveConfigValue("twitch.maxCharLimit"),
    "{{chat_user}}": promptData.user,
    "{{model_author}}": await retrieveConfigValue("models.chat.author"),
    "{{model_org}}": await retrieveConfigValue("models.chat.organization"),
    ...socialReplacements,
  };

  let systemPrompt = replacePlaceholders(instructTemplate, commonReplacements);

  const structuredPromptData = {
    systemPrompt: systemPrompt,
    characterDescription: fileContents.character_card
      ? `# ${currentAuthObject.bot_name}'s Description:\n${replacePlaceholders(fileContents.character_card, commonReplacements)}`
      : null,
    characterPersonality: fileContents.character_personality
      ? `# ${currentAuthObject.bot_name}'s Personality:\n${replacePlaceholders(fileContents.character_personality, commonReplacements)}`
      : null,
    worldInfo: fileContents.world_lore
      ? `# World Information:\nUse this information to reflect the world and context around ${currentAuthObject.bot_name}:\n${replacePlaceholders(fileContents.world_lore, commonReplacements)}`
      : null,
    scenario: fileContents.scenario
      ? `# Scenario:\n${replacePlaceholders(fileContents.scenario, commonReplacements)}`
      : null,
    playerInfo: fileContents.player_info
      ? `# Information about ${currentAuthObject.user_name}:\nThis is pertinent information regarding ${currentAuthObject.user_name} that you should always remember.\n${replacePlaceholders(fileContents.player_info, commonReplacements)}`
      : null,
    recentChat: `# Current Messages from Chat:\nUp to the last ${await retrieveConfigValue("twitch.maxChatsToSave")} messages are provided to you from ${currentAuthObject.user_name}'s Twitch chat. Use these messages to keep up with the current conversation:\n${await returnRecentChats(userID)}`,
    weatherInfo:
      currentAuthObject.weather && fileContents.weather
        ? `# Current Weather:\n${replacePlaceholders(fileContents.weather, commonReplacements)}`
        : null,
    additionalContext: {
      contextResults: promptData.relContext
        ? `# Additional Information:\nExternal context relevant to the conversation:\n${promptData.relContext}`
        : null,
      chatHistory: promptData.relChats
        ? `# Other Relevant Chat Context:\nBelow are potentially relevant chat messages sent previously, that may be relevant to the conversation:\n${promptData.relChats}`
        : null,
      voiceInteractions: promptData.relVoice
        ? `# Previous Voice Interactions:\nNon-exhaustive list of prior vocal interactions you've had with ${currentAuthObject.user_name}:\n${promptData.relVoice}`
        : null,
      recentVoice: fileContents.voice_messages
        ? `# Current Voice Conversations with ${currentAuthObject.user_name}:\nUp to the last ${await retrieveConfigValue("twitch.maxChatsToSave")} voice messages are provided to you. Use these voice messages to help you keep up with the current conversation:\n${fileContents.voice_messages}`
        : null,
      emotionalAssessment: sentiment
        ? `# Current Emotional Assessment of Message:\n- ${sentiment}`
        : null,
      dateTime: `# Current Date and Time:\n- The date and time where you and ${currentAuthObject.user_name} live is currently: ${timeStamp}`,
    },
    userMessage: `${promptData.chat_user} says: "message"`,
    isChainOfThought: true,
  };

  const promptWithSamplers = await ChatRequestBodyCoT.create(structuredPromptData);

  logger.log(
    "LLM",
    `Thoughtful chat prompt is using ${await promptTokenizedFromRemote(
      promptWithSamplers.messages
    )} of your available ${await retrieveConfigValue(
      "models.chat.maxTokens"
    )} tokens.`
  );

  return promptWithSamplers;
};

const eventPromptChat = async (message, userId) => {
  const userObject = await returnAuthObject(userId);
  logger.log("System", `Doing eventing stuff for: ${userObject.user_name} and ${userId}`);

  const templateCacheKey = 'event_system_prompt';
  let instructTemplate;
  
  if (templateCache.has(templateCacheKey)) {
    instructTemplate = templateCache.get(templateCacheKey);
  } else {
    instructTemplate = await withErrorHandling(
      () => getTemplate(`./instructs/system.prompt`),
      {
        context: "Templates",
        defaultValue: "",
        logError: true,
      }
    );
    addToTemplateCache(templateCacheKey, instructTemplate);
  }

  const timeStamp = moment().format("dddd, MMMM Do YYYY, [at] hh:mm A");

  const fileContents = await readPromptFiles(userId, [
    "character_personality",
    "world_lore",
    "scenario", 
    "character_card",
    "weather",
    "player_info",
  ]);

  const socialReplacements = await getSocialMediaReplacements(userId);

  const commonReplacements = {
    "{{user}}": userObject.user_name,
    "{{char}}": userObject.bot_name,
    "{{char_limit}}": await retrieveConfigValue("twitch.maxCharLimit"),
    "{{model_author}}": await retrieveConfigValue("models.chat.author"),
    "{{model_org}}": await retrieveConfigValue("models.chat.organization"),
    ...socialReplacements,
  };

  const systemPrompt = replacePlaceholders(instructTemplate, commonReplacements);

  const structuredPromptData = {
    systemPrompt: systemPrompt,
    characterDescription: fileContents.character_card
      ? `# ${userObject.bot_name}'s Description:\n${replacePlaceholders(fileContents.character_card, commonReplacements)}`
      : null,
    characterPersonality: fileContents.character_personality
      ? `# ${userObject.bot_name}'s Personality:\n${replacePlaceholders(fileContents.character_personality, commonReplacements)}`
      : null,
    worldInfo: fileContents.world_lore
      ? `# World Information:\nUse this information to reflect the world and context around ${userObject.bot_name}:\n${replacePlaceholders(fileContents.world_lore, commonReplacements)}`
      : null,
    scenario: fileContents.scenario
      ? `# Scenario:\n${replacePlaceholders(fileContents.scenario, commonReplacements)}`
      : null,
    playerInfo: fileContents.player_info
      ? `# Information about ${userObject.user_name}:\nThis is pertinent information regarding ${userObject.user_name} that you should always remember.\n${replacePlaceholders(fileContents.player_info, commonReplacements)}`
      : null,
    recentChat: `# Current Messages from Chat:\nUp to the last ${await retrieveConfigValue("twitch.maxChatsToSave")} messages are provided to you from ${userObject.user_name}'s Twitch chat. Use these messages to keep up with the current conversation:\n${await returnRecentChats(userId)}`,
    weatherInfo:
      userObject.weather && fileContents.weather
        ? `# Current Weather:\n${replacePlaceholders(fileContents.weather, commonReplacements)}`
        : null,
    additionalContext: {
      dateTime: `# Current Date and Time:\n- The date and time where you and ${userObject.user_name} live is currently: ${timeStamp}`,
    },
    userMessage: message,
  };

  const promptWithSamplers = await ChatRequestBody.create(structuredPromptData);

  logger.log(
    "LLM",
    `Event handler prompt is using ${await promptTokenizedFromRemote(
      promptWithSamplers.messages
    )} of your available ${await retrieveConfigValue(
      "models.chat.maxTokens"
    )} tokens.`
  );

  return promptWithSamplers;
};

const queryPrompt = async (message, userId) => {
  const userObject = await returnAuthObject(userId);
  
  const templateCacheKey = 'query_prompt';
  let instructTemplate;
  
  if (templateCache.has(templateCacheKey)) {
    instructTemplate = templateCache.get(templateCacheKey);
  } else {
    instructTemplate = await withErrorHandling(
      () => getTemplate(`./instructs/helpers/query.prompt`),
      {
        context: "Templates",
        defaultValue: "",
        logError: true,
      }
    );
    addToTemplateCache(templateCacheKey, instructTemplate);
  }
  
  const timeStamp = moment().format("MM/DD/YY [at] HH:mm");
  const [dateString, timeString] = timeStamp.split(" at ");

  const socialReplacements = await getSocialMediaReplacements(userId);

  const replacements = {
    "{{datetime}}": `${dateString}. The current time is ${timeString}`,
    "{{query}}": message,
    "{{user}}": userObject.user_name,
    "{{char}}": userObject.bot_name,
    ...socialReplacements,
  };

  const instructionTemplate = replacePlaceholders(instructTemplate, replacements);
  const promptWithSamplers = await QueryRequestBody.create(
    instructionTemplate,
    await retrieveConfigValue("models.query.model"),
    message + "\n/no_think"
  );

  logger.log(
    "LLM",
    `Search query prompt is using ${await promptTokenizedFromRemote(
      promptWithSamplers.messages
    )} of your available ${await retrieveConfigValue("models.query.maxTokens")} tokens.`
  );
  return promptWithSamplers;
};

const rerankPrompt = async (message, userId) => {
  logger.log("Rerank", `Received message ${message}`);
  const userObject = await returnAuthObject(userId);
  
  const templateCacheKey = 'rerank_prompt';
  let instructTemplate;
  
  if (templateCache.has(templateCacheKey)) {
    instructTemplate = templateCache.get(templateCacheKey);
  } else {
    instructTemplate = await withErrorHandling(
      () => getTemplate(`./instructs/helpers/rerank.prompt`),
      {
        context: "Templates",
        defaultValue: "",
        logError: true,
      }
    );
    addToTemplateCache(templateCacheKey, instructTemplate);
  }
  
  const socialReplacements = await getSocialMediaReplacements(userId);

  const replacements = {
    "{{user}}": userObject.user_name,
    ...socialReplacements,
  };

  const instructionTemplate = replacePlaceholders(instructTemplate, replacements);
  const promptWithSamplers = await ToolRequestBody.create(
    instructionTemplate,
    await retrieveConfigValue("models.rerankTransform.model"),
    message
  );

  logger.log(
    "LLM",
    `Reranking prompt is using ${await promptTokenizedFromRemote(
      promptWithSamplers.messages
    )} of your available ${await retrieveConfigValue("models.rerankTransform.maxTokens")} tokens.`
  );
  return promptWithSamplers;
};

const summaryPrompt = async (textContent) => {
  const templateCacheKey = 'summary_prompt';
  let instructTemplate;
  
  if (templateCache.has(templateCacheKey)) {
    instructTemplate = templateCache.get(templateCacheKey);
  } else {
    instructTemplate = await withErrorHandling(
      () => getTemplate(`./instructs/helpers/summary.prompt`),
      {
        context: "Templates",
        defaultValue: "",
        logError: true,
      }
    );
    addToTemplateCache(templateCacheKey, instructTemplate);
  }
  
  const promptWithSamplers = await SummaryRequestBody.create(
    instructTemplate,
    await retrieveConfigValue("models.summary.model"),
    textContent
  );

  logger.log(
    "LLM",
    `Summary prompt is using ${await promptTokenizedFromRemote(
      promptWithSamplers.messages
    )} of your available ${await retrieveConfigValue("models.summary.maxTokens")} tokens.`
  );
  return promptWithSamplers;
};

/**
 * FIXED: Reads multiple files with better error handling and memory management
 */
async function readPromptFiles(userId, fileNames) {
  const fileContents = {};
  
  // FIXED: Process files in smaller batches to reduce memory pressure
  const batchSize = 3;
  for (let i = 0; i < fileNames.length; i += batchSize) {
    const batch = fileNames.slice(i, i + batchSize);
    
    await Promise.all(
      batch.map(async (fileName) => {
        const filePath = `./world_info/${userId}/${fileName}.txt`;
        try {
          const content = await fs.readFile(filePath, "utf-8");
          // FIXED: Limit file size to prevent memory issues
          if (content.length > 50000) {
            logger.log("Files", `File ${filePath} is large (${content.length} chars), truncating`);
            fileContents[fileName] = content.substring(0, 50000) + "\n[Content truncated...]";
          } else {
            fileContents[fileName] = content;
          }
        } catch (error) {
          logger.log("Files", `Error reading file ${filePath}: ${error}`);
          fileContents[fileName] = "";
        }
      })
    );
  }
  
  return fileContents;
}

// FIXED: Response stripping with size limits
const replyStripped = async (message, userId) => {
  // FIXED: Limit input size
  if (message.length > 10000) {
    message = message.substring(0, 10000);
    logger.log("System", "Message truncated for processing");
  }

  const userObj = await returnAuthObject(userId);
  let formatted = message
    .replace(/(\r\n|\n|\r)/gm, " ")
    .replace(new RegExp(`${userObj.bot_name}:\\s?`, "g"), "")
    .replace(/\(500 characters\)/g, "")
    .replace(/\\/g, "")
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .replace("shoutout", "shout out");
  
  formatted = formatted.replace(/^['"]|['"]$/g, "");
  return formatted.trim();
};

// FIXED: TTS string processing with better error handling
const fixTTSString = async (inputString) => {
  // FIXED: Limit input size
  if (inputString.length > 5000) {
    inputString = inputString.substring(0, 5000);
  }

  const acronymRegex = /\b([A-Z]{2,})(?!\w)/g;
  const jsRegex = /\.js\b/gi;
  const exceptions = ["GOATs", "LOL", "LMAO"];

  let acronymCount = 0;
  let jsCount = 0;

  let transformedString = inputString.replace(acronymRegex, (match) => {
    if (exceptions.includes(match)) {
      return match;
    }
    acronymCount++;
    let transformed = match.slice(0, -1).split("").join(".") + "." + match.slice(-1);
    if (match.endsWith("S") && match.length > 2) {
      const base = match.slice(0, -1).split("").join(".");
      transformed = `${base}'s`;
    }
    return transformed;
  });

  transformedString = transformedString.replace(jsRegex, (match) => {
    jsCount++;
    return ".J.S";
  });

  return { fixedString: transformedString, acronymCount, jsCount };
};

const filterCharacterFromMessage = async (str, userId) => {
  // FIXED: Limit input size
  if (str.length > 2000) {
    str = str.substring(0, 2000);
  }

  const userObject = await returnAuthObject(userId);
  const twitchRegex = new RegExp(`@?${userObject.bot_twitch}`, "i");
  const nameRegex = new RegExp(
    `,?\\s*\\b(?:${userObject.bot_name}|hey ${userObject.bot_name})\\b,?\\s*`,
    "i"
  );

  let result = str.replace(twitchRegex, "").trim();
  result = result.replace(nameRegex, "").trim();
  return result;
};

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function containsCharacterName(message, userId) {
  try {
    const userObj = await returnAuthObject(userId);

    if (!message || typeof message !== "string") {
      return false;
    }

    const normalizedMessage = message.toLowerCase().trim();
    const namesToCheck = new Set();

    if (userObj.bot_name) {
      namesToCheck.add(userObj.bot_name.toLowerCase());
    }

    if (userObj.bot_twitch) {
      const botTwitch = userObj.bot_twitch.toLowerCase();
      namesToCheck.add(botTwitch);
      const cleanBotTwitch = botTwitch.startsWith("@") ? botTwitch.slice(1) : botTwitch;
      namesToCheck.add(cleanBotTwitch);
      namesToCheck.add("@" + cleanBotTwitch);
    }

    if (userObj.twitch_tokens?.bot?.twitch_login) {
      const botLogin = userObj.twitch_tokens.bot.twitch_login.toLowerCase();
      namesToCheck.add(botLogin);
      namesToCheck.add("@" + botLogin);
    }

    if (userObj.twitch_tokens?.bot?.twitch_display_name) {
      const botDisplayName = userObj.twitch_tokens.bot.twitch_display_name.toLowerCase();
      namesToCheck.add(botDisplayName);
      namesToCheck.add("@" + botDisplayName);
    }

    if (userObj.twitch_tokens?.streamer?.twitch_login) {
      const streamerLogin = userObj.twitch_tokens.streamer.twitch_login.toLowerCase();
      namesToCheck.add(streamerLogin);
      namesToCheck.add("@" + streamerLogin);
    }

    const validNames = Array.from(namesToCheck).filter(name => name && name.length > 0);

    if (validNames.length === 0) {
      logger.warn("Twitch", `No valid bot names found for user ${userId} when checking mentions`);
      return false;
    }

    for (const nameToCheck of validNames) {
      const wordBoundaryRegex = new RegExp(`\\b${escapeRegExp(nameToCheck)}\\b`, "i");
      if (wordBoundaryRegex.test(normalizedMessage)) {
        logger.log("Twitch", `Character name detected: "${nameToCheck}" in message: "${message}"`);
        return true;
      }

      if (nameToCheck.startsWith("@")) {
        const atMentionRegex = new RegExp(`${escapeRegExp(nameToCheck)}`, "i");
        if (atMentionRegex.test(normalizedMessage)) {
          logger.log("Twitch", `@ mention detected: "${nameToCheck}" in message: "${message}"`);
          return true;
        }
      }
    }

    return false;
  } catch (error) {
    logger.error("Twitch", `Error checking character name in message: ${error.message}`);
    return false;
  }
}

async function containsPlayerSocials(message, userId) {
  const userObj = await returnAuthObject(userId);
  const nameRegex = new RegExp(userObj.twitch_name, "i");
  return nameRegex.test(message);
}

async function containsAuxBotName(message, userId) {
  try {
    const userObj = await returnAuthObject(userId);

    if (!message || typeof message !== "string" || !Array.isArray(userObj.aux_bots)) {
      return false;
    }

    const normalizedMessage = message.toLowerCase();

    for (const botName of userObj.aux_bots) {
      if (!botName || typeof botName !== "string") continue;

      const normalizedBotName = botName.toLowerCase();
      const wordBoundaryRegex = new RegExp(`\\b${escapeRegExp(normalizedBotName)}\\b`, "i");
      if (wordBoundaryRegex.test(normalizedMessage)) {
        logger.log("Twitch", `Aux bot name detected: "${botName}" in message, ignoring`);
        return true;
      }

      const atBotName = "@" + normalizedBotName;
      const atMentionRegex = new RegExp(`\\b${escapeRegExp(atBotName)}\\b`, "i");
      if (atMentionRegex.test(normalizedMessage)) {
        logger.log("Twitch", `Aux bot @ mention detected: "${atBotName}" in message, ignoring`);
        return true;
      }
    }

    return false;
  } catch (error) {
    logger.error("Twitch", `Error checking aux bot names: ${error.message}`);
    return false;
  }
}

// FIXED: Add cleanup function for manual cache clearing
export function clearPromptHelperCaches() {
  templateCache.clear();
  moderationPromptCache.clear();
  clientPool.forEach(client => {
    if (client?.destroy) {
      client.destroy();
    }
  });
  clientPool.clear();
  logger.log("System", "Prompt helper caches cleared");
}

// FIXED: Add periodic cleanup
setInterval(() => {
  // Clear template cache if it gets too large
  if (templateCache.size > MAX_TEMPLATE_CACHE_SIZE) {
    const excess = templateCache.size - MAX_TEMPLATE_CACHE_SIZE;
    const keysToDelete = Array.from(templateCache.keys()).slice(0, excess);
    keysToDelete.forEach(key => templateCache.delete(key));
  }
  
  // Clear old moderation cache entries
  const now = Date.now();
  for (const [key, value] of moderationPromptCache.entries()) {
    if (now - value.timestamp > 300000) { // 5 minutes
      moderationPromptCache.delete(key);
    }
  }
}, 300000); // Run every 5 minutes

export {
  replyStripped,
  moderatorPrompt,
  containsAuxBotName,
  containsPlayerSocials,
  summaryPrompt,
  filterCharacterFromMessage,
  queryPrompt,
  contextPromptChat,
  contextPromptChatCoT,
  fixTTSString,
  rerankPrompt,
  eventPromptChat,
  containsCharacterName,
};