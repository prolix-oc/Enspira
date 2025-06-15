import fs from "fs-extra";
import moment from "moment";
import { socialMedias } from "./twitch-helper.js";
import { interpretEmotions } from "./data-helper.js";
import { returnAuthObject } from "./api-helper.js";
import { tokenizedFromRemote, promptTokenizedFromRemote } from "./token-helper.js";
import { retrieveConfigValue } from "./config-helper.js";
import { returnRecentChats } from "./ai-logic.js";
import { ChatRequestBody, ChatRequestBodyCoT, ToolRequestBody, QueryRequestBody, ModerationRequestBody, SummaryRequestBody } from "./oai-requests.js";
import { jsonrepair } from 'jsonrepair'
import OpenAI from "openai";
import { performance } from "node:perf_hooks";
import { logger } from './create-global-logger.js';
import { utils } from './utils/index.js';

const { getTemplate } = utils.file;
const { replacePlaceholders } = utils.string
const { withErrorHandling } = utils.error

const templateCache = {};

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
      "{{socials}}": allSocials || ""
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
    replacements["{{soc_tiktok}}"] = await socialMedias(userId, "tiktok") || "";
    replacements["{{soc_youtube}}"] = await socialMedias(userId, "youtube") || "";
    replacements["{{soc_twitter}}"] = await socialMedias(userId, "twitter") || "";
    replacements["{{soc_instagram}}"] = await socialMedias(userId, "instagram") || "";
    
    return replacements;
  } catch (error) {
    logger.log("System", `Error getting social media replacements: ${error.message}`);
    return { "{{socials}}": "" };
  }
}

/**
 * Sends a chat completion request for tool tasks like query writing and reranking.
 * Simplified version without reasoning or chain-of-thought features.
 * 
 * @param {object} requestBody - The request body for the completion.
 * @param {object} modelConfig - Configuration for the model.
 * @returns {Promise<object>} - The completion response.
 */
export async function sendToolCompletionRequest(requestBody, modelConfig) {
  const openai = new OpenAI({
    baseURL: modelConfig.endpoint,
    apiKey: modelConfig.apiKey,
  });

  const startTime = performance.now();
  let fullResponse = "";
  const MAX_RESPONSE_SIZE = 50000; // 50KB limit for tool responses

  try {
    const stream = await openai.chat.completions.create({
      ...requestBody,
      stream: true,
    });

    for await (const part of stream) {
      const content = part.choices[0]?.delta?.content;
      if (content) {
        // Add content to full response, but check size limit
        fullResponse += content;
        
        // If exceeded max size, stop processing stream
        if (fullResponse.length > MAX_RESPONSE_SIZE) {
          logger.log("API", `Tool response exceeded ${MAX_RESPONSE_SIZE/1000}KB limit, truncating`);
          break; // Exit the loop to stop processing more tokens
        }
      }
    }
    
    // Calculate total processing time
    const totalTime = (performance.now() - startTime) / 1000;
    
    // For JSON responses, make sure we have valid JSON
    if (requestBody.response_format?.type === "json_schema") {
      // Check if the response is already an object
      if (typeof fullResponse === 'object' && fullResponse !== null) {
        return {
          response: fullResponse,
          rawResponse: JSON.stringify(fullResponse),
          processingTime: totalTime.toFixed(3)
        };
      }
      
      try {
        // Try parsing the JSON response
        const jsonResponse = JSON.parse(fullResponse);
        return {
          response: jsonResponse,
          rawResponse: fullResponse,
          processingTime: totalTime.toFixed(3)
        };
      } catch (jsonError) {
        // If JSON parsing fails, try to fix it using jsonrepair
        try {
          const fixedResponse = jsonrepair(fullResponse);
          const jsonResponse = JSON.parse(fixedResponse);
          
          logger.log("API", "Fixed malformed JSON in tool response");
          
          return {
            response: jsonResponse,
            rawResponse: fixedResponse,
            processingTime: totalTime.toFixed(3),
            jsonFixed: true
          };
        } catch (repairError) {
          // If repair also fails, return error
          logger.log("API", `Failed to parse JSON response: ${jsonError.message}`);
          return { 
            error: "JSON parsing failed", 
            rawResponse: fullResponse.substring(0, 1000),
            processingTime: totalTime.toFixed(3)
          };
        }
      }
    }
    
    // For non-JSON responses, just return the content
    return {
      response: fullResponse,
      processingTime: totalTime.toFixed(3)
    };
  } catch (error) {
    logger.log(
      "API",
      `Tool completion error: ${error}; Model: ${modelConfig.model}`
    );
    return { error: error.message };
  }
}
export async function sendChatCompletionRequest(requestBody, modelConfig, userObj) {
  const openai = new OpenAI({
    baseURL: modelConfig.endpoint,
    apiKey: modelConfig.apiKey,
  });

  const startTime = performance.now();
  let firstTokenTimeElapsed = null;
  let backendStartTime;
  let fullResponse = "";
  const MAX_RESPONSE_SIZE = 100000; // 100KB limit, adjust as needed
  await fs.writeJSON('./chat-request.json', requestBody)
  try {
    const stream = await openai.chat.completions.create({
      ...requestBody,
      stream: true,
    });

    for await (const part of stream) {
      const content = part.choices[0]?.delta?.content;
      if (content) {
        if (firstTokenTimeElapsed === null) {
          // Calculate time to first token in seconds
          firstTokenTimeElapsed = (performance.now() - startTime) / 1000;
          // Start backend timer after first token arrives
          backendStartTime = performance.now();
        }

        // Add content to full response, but check size limit
        fullResponse += content;

        // Check if response is getting too large (warn at 50KB)
        if (fullResponse.length > 50000 && fullResponse.length < 51000) {
          logger.log("API", "Response size over 50KB, approaching limits");
        }

        // If exceeded max size, stop processing stream - prevents memory issues
        if (fullResponse.length > MAX_RESPONSE_SIZE) {
          logger.log("API", `Response exceeded ${MAX_RESPONSE_SIZE / 1000}KB limit, truncating`);
          fullResponse += "\n\n[Response truncated due to length limits]";
          break; // Exit the loop to stop processing more tokens
        }
      }
    }

    // Calculate backend processing time in seconds
    const backendTimeElapsed = (performance.now() - backendStartTime) / 1000;

    // Tokenize the full response (use simpler calculation if tokenization fails)
    let generatedTokens;
    try {
      generatedTokens = await tokenizedFromRemote(fullResponse);
    } catch (tokenizationError) {
      // Fallback to character-based estimation
      generatedTokens = Math.ceil(fullResponse.length / 4);
    }

    let backendTokensPerSecond = 0;
    if (backendTimeElapsed > 0 && generatedTokens > 0) {
      backendTokensPerSecond = (generatedTokens / backendTimeElapsed).toFixed(2);
    }

    // Enhanced thought process extraction
    let thoughtProcess = "";
    let finalResponse = "";

    // Check for thought tags and determine pattern
    const startTag = "<think>";
    const endTag = "</think>";
    const startTagIndex = fullResponse.indexOf(startTag);
    const endTagIndex = fullResponse.indexOf(endTag);

    // Case 1: Standard format with both <think> and </think>
    if (startTagIndex !== -1 && endTagIndex !== -1 && endTagIndex > startTagIndex) {
      thoughtProcess = fullResponse.substring(startTagIndex + startTag.length, endTagIndex).trim();
      finalResponse = fullResponse.substring(endTagIndex + endTag.length).trim();
    }
    // Case 2: Only </think> exists (no opening tag)
    else if (startTagIndex === -1 && endTagIndex !== -1) {
      thoughtProcess = fullResponse.substring(0, endTagIndex).trim();
      finalResponse = fullResponse.substring(endTagIndex + endTag.length).trim();
    }
    // Case 3: Multiple thought segments or complex pattern
    else if (fullResponse.includes("</think>")) {
      // Initialize markers
      let currentPos = 0;
      let thoughts = [];
      let lastEndTagPos = -1;
      
      // Iterate through finding all segments
      while (true) {
        const nextStartTag = fullResponse.indexOf(startTag, currentPos);
        const nextEndTag = fullResponse.indexOf(endTag, currentPos);
        
        // No more tags found
        if (nextEndTag === -1) break;
        
        // Found a new segment
        lastEndTagPos = nextEndTag;
        
        // If we found a start tag and it comes before the end tag
        if (nextStartTag !== -1 && nextStartTag < nextEndTag) {
          thoughts.push(fullResponse.substring(nextStartTag + startTag.length, nextEndTag).trim());
          currentPos = nextEndTag + endTag.length;
        } 
        // If we only found an end tag (or the end tag comes first)
        else {
          // If this is the first segment and there's no start tag, capture from beginning
          if (thoughts.length === 0 && nextStartTag === -1) {
            thoughts.push(fullResponse.substring(0, nextEndTag).trim());
          } else {
            // Otherwise capture from current position to end tag
            thoughts.push(fullResponse.substring(currentPos, nextEndTag).trim());
          }
          currentPos = nextEndTag + endTag.length;
        }
      }
      
      // Combine all thought segments
      thoughtProcess = thoughts.join("\n");
      
      // Final response is everything after the last </think>
      if (lastEndTagPos !== -1) {
        finalResponse = fullResponse.substring(lastEndTagPos + endTag.length).trim();
      } else {
        finalResponse = fullResponse; // Fallback to full response
      }
    } 
    // Case 4: No think tags found
    else {
      finalResponse = fullResponse.trim();
    }
    
    return {
      response: finalResponse,
      thoughtProcess,
      timeToFirstToken: firstTokenTimeElapsed ? firstTokenTimeElapsed.toFixed(3) : null,
      tokensPerSecond: backendTokensPerSecond,
    };
  } catch (error) {
    logger.log(
      "API",
      `OpenAI chat completion error: ${error}; Model: ${modelConfig.model}`
    );
    return { error: error.message };
  }
}

export async function sendChatCompletionRequestCoT(requestBody, modelConfig) {
  const openai = new OpenAI({
    baseURL: modelConfig.endpoint,
    apiKey: modelConfig.apiKey,
  });

  const startTime = performance.now();
  let firstTokenTimeElapsed = null;
  let backendStartTime;
  let fullResponse = "";

  try {
    const stream = await openai.chat.completions.create({
      ...requestBody,
      stream: true
    });

    for await (const part of stream) {
      const content = part.choices[0]?.delta?.content;
      if (content) {
        if (firstTokenTimeElapsed === null) {
          firstTokenTimeElapsed = (performance.now() - startTime) / 1000;
          backendStartTime = performance.now();
        }
        fullResponse += content;

        // Early warning for large responses
        if (fullResponse.length > 50000) {
          logger.log("API", "CoT response is becoming very large, may cause issues with API returns");
        }
      }
    }

    const backendTimeElapsed = (performance.now() - backendStartTime) / 1000;

    // Tokenize the full response
    let generatedTokens;
    try {
      generatedTokens = await tokenizedFromRemote(fullResponse, modelConfig.modelType);
    } catch (tokenizationError) {
      logger.log("API", `Error tokenizing CoT response: ${tokenizationError}. Using character-based estimate.`);
      generatedTokens = Math.ceil(fullResponse.length / 4); // Rough estimate
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
      // First attempt with regular JSON.parse
      try {
        formattedResponse = JSON.parse(fullResponse);
      } catch (initialParseError) {
        // If that fails, try jsonrepair
        logger.log("API", `Initial JSON parse failed, trying jsonrepair: ${initialParseError.message}`);
        const fixedResponse = jsonrepair(fullResponse);
        formattedResponse = JSON.parse(fixedResponse);
      }

      // Process thoughts array safely
      if (formattedResponse.thoughts) {
        // If thoughts is already an array of strings
        if (Array.isArray(formattedResponse.thoughts)) {
          thoughtsArray = formattedResponse.thoughts.filter(thought => thought && thought !== "");
        }
        // If thoughts is an array of objects with 'thought' property
        else if (Array.isArray(formattedResponse.thoughts) &&
          formattedResponse.thoughts.length > 0 &&
          formattedResponse.thoughts[0].thought) {
          thoughtsArray = formattedResponse.thoughts
            .map(t => t.thought)
            .filter(thought => thought && thought !== "");
        } else {
          // Invalid format for thoughts, create a default
          logger.log("API", "Invalid thoughts format in response, using empty array");
          thoughtsArray = [];
        }
      }

      // Extract final response safely
      fullOutput = formattedResponse.final_response || formattedResponse.response || "";

      // Truncate if too long
      if (fullOutput && fullOutput.length > 100000) {
        logger.log("API", `CoT response too large (${fullOutput.length} bytes), truncating`);
        fullOutput = fullOutput.substring(0, 100000) + "\n[Response truncated due to length...]";
      }

    } catch (parseError) {
      logger.log(
        "API",
        `Error parsing JSON response: ${parseError}; Response: ${fullResponse.substring(0, 500)}...`,
        "error"
      );

      // Last resort emergency parsing attempt
      try {
        // Try to extract anything that looks like a final response
        const finalResponseMatch = fullResponse.match(/"final_response"\s*:\s*"([^"]+)"/);
        if (finalResponseMatch && finalResponseMatch[1]) {
          fullOutput = finalResponseMatch[1];
        } else {
          fullOutput = "I apologize, but I encountered an error processing your message.";
        }

        // Log the parse failure
        logger.error("API", `All JSON parsing attempts failed. Constructed basic response.`);
        thoughtsArray = ["Error parsing JSON response"];
      } catch (emergencyError) {
        logger.error("API", `Emergency parsing also failed: ${emergencyError.message}`);
        return {
          error: `Error parsing JSON: ${parseError.message}`,
          rawResponse: fullResponse.substring(0, 1000)
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
    logger.log(
      "API",
      `OpenAI chat completion error: ${error}; Model Config: ${JSON.stringify(modelConfig)}`,
      "error"
    );
    return { error: error.message };
  }
}

const moderatorPrompt = async (message, userId) => {
  const userObject = await returnAuthObject(userId);
  const instructTemplate = await withErrorHandling(
    () => getTemplate(`./instructs/helpers/moderation.prompt`),
    { 
      context: 'Templates', 
      defaultValue: '', 
      logError: true 
    }
  ); 
  // Get social media replacements with enhanced platform-specific support
  const socialReplacements = await getSocialMediaReplacements(userId);

  const replacements = {
    "{{user}}": userObject.user_name,
    "{{char}}": userObject.bot_name,
    "{{twitch}}": userObject.twitch_name,
    "{{modlist}}": userObject.mod_list.join("\n- "),
    "{{sites}}": userObject.approved_sites.join("\n- "),
    ...socialReplacements
  };

  const instructionTemplate = replacePlaceholders(instructTemplate, replacements);
  const promptWithSamplers = await ModerationRequestBody.create(
    instructionTemplate,
    await retrieveConfigValue("models.moderator.model"),
    message
  );
  
  logger.log(
    "LLM",
    `Moderation prompt is using ${await promptTokenizedFromRemote(
      promptWithSamplers.messages,
    )} of your available ${await retrieveConfigValue("models.moderator.maxTokens")} tokens.`
  );
  return promptWithSamplers;
};

/**
 * Generates a chat completion body with context, instructions, and message.
 * Enhanced with better support for social media templating.
 *
 * @param {object} promptData - Data containing relevant context, chats, and voice interactions.
 * @param {string} message - The user message.
 * @param {string} userID - The user ID.
 * @returns {Promise<object>} - The chat completion body.
 */
const contextPromptChat = async (promptData, message, userID) => {
  const currentAuthObject = await returnAuthObject(userID);
  const instructTemplate = await withErrorHandling(
    () => getTemplate(`./instructs/system.prompt`),
    { 
      context: 'Templates', 
      defaultValue: '', 
      logError: true 
    }
  );  
  
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

  // Get social media replacements with enhanced platform-specific support
  const socialReplacements = await getSocialMediaReplacements(userID);

  // Common replacements for preprocessing text
  const commonReplacements = {
    "{{user}}": currentAuthObject.user_name,
    "{{char}}": currentAuthObject.bot_name,
    "{{char_limit}}": await retrieveConfigValue("twitch.maxCharLimit"),
    "{{chat_user}}": user,
    "{{model_author}}": await retrieveConfigValue("models.chat.author"),
    "{{model_org}}": await retrieveConfigValue("models.chat.organization"),
    // Add all social media replacements
    ...socialReplacements
  };

  // Process system prompt
  const systemPrompt = replacePlaceholders(instructTemplate, commonReplacements);

  // Structure the prompt data in the format expected by the new ChatRequestBody
  const structuredPromptData = {
    systemPrompt: systemPrompt,
    
    // Character information
    characterDescription: fileContents.character_card ? 
      `# ${currentAuthObject.bot_name}'s Description:\n${replacePlaceholders(fileContents.character_card, commonReplacements)}` : null,
      
    characterPersonality: fileContents.character_personality ? 
      `# ${currentAuthObject.bot_name}'s Personality:\n${replacePlaceholders(fileContents.character_personality, commonReplacements)}` : null,
    
    // World information
    worldInfo: fileContents.world_lore ? 
      `# World Information:\nUse this information to reflect the world and context around ${currentAuthObject.bot_name}:\n${replacePlaceholders(fileContents.world_lore, commonReplacements)}` : null,
    
    // Scenario
    scenario: fileContents.scenario ? 
      `# Scenario:\n${replacePlaceholders(fileContents.scenario, commonReplacements)}` : null,
    
    // Player information
    playerInfo: fileContents.player_info ? 
      `# Information about ${currentAuthObject.user_name}:\nThis is pertinent information regarding ${currentAuthObject.user_name} that you should always remember.\n${replacePlaceholders(fileContents.player_info, commonReplacements)}` : null,
    
    // Current chat messages
    recentChat: `# Current Messages from Chat:\nUp to the last ${await retrieveConfigValue("twitch.maxChatsToSave")} messages are provided to you from ${currentAuthObject.user_name}'s Twitch chat. Use these messages to keep up with the current conversation:\n${await returnRecentChats(userID)}`,
    
    // Weather information
    weatherInfo: currentAuthObject.weather && fileContents.weather ? 
      `# Current Weather:\n${replacePlaceholders(fileContents.weather, commonReplacements)}` : null,
    
    // Additional context elements
    additionalContext: {
      // Relevant context search results if available
      contextResults: promptData.relContext ? 
        `# Additional Information:\nExternal context relevant to the conversation:\n${promptData.relContext}` : null,
      
      // Relevant chat history if available
      chatHistory: promptData.relChats ? 
        `# Other Relevant Chat Context:\nBelow are potentially relevant chat messages sent previously, that may be relevant to the conversation:\n${promptData.relChats}` : null,
      
      // Voice interactions if available
      voiceInteractions: promptData.relVoice ? 
        `# Previous Voice Interactions:\nNon-exhaustive list of prior vocal interactions you've had with ${currentAuthObject.user_name}:\n${promptData.relVoice}` : null,
      
      // Recent voice messages if available
      recentVoice: fileContents.voice_messages ? 
        `# Current Voice Conversations with ${currentAuthObject.user_name}:\nUp to the last ${await retrieveConfigValue("twitch.maxChatsToSave")} voice messages are provided to you. Use these voice messages to help you keep up with the current conversation:\n${fileContents.voice_messages}` : null,
      
      // Emotional assessment
      emotionalAssessment: sentiment ? 
        `# Current Emotional Assessment of Message:\n- ${sentiment}` : null,
      
      // Current date/time
      dateTime: `# Current Date and Time:\n- The date and time where you and ${currentAuthObject.user_name} live is currently: ${timeStamp}`
    },
    
    // The actual user message
    userMessage: `${promptData.chat_user} says: "${message}"`
  };

  // Create the chat request body with our structured prompt data
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


const contextPromptChatCoT = async (promptData, message, userID) => {
  const currentAuthObject = await returnAuthObject(userID);
  const instructTemplate = await withErrorHandling(
    () => getTemplate(`./instructs/system_cot.prompt`),
    { 
      context: 'Templates', 
      defaultValue: '', 
      logError: true 
    }
  );    const timeStamp = moment().format("dddd, MMMM Do YYYY, [at] hh:mm A");

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

  // Get social media replacements with enhanced platform-specific support
  const socialReplacements = await getSocialMediaReplacements(userID);

  // Common replacements for preprocessing text
  const commonReplacements = {
    "{{user}}": currentAuthObject.user_name,
    "{{char}}": currentAuthObject.bot_name,
    "{{char_limit}}": await retrieveConfigValue("twitch.maxCharLimit"),
    "{{chat_user}}": promptData.user,
    "{{model_author}}": await retrieveConfigValue("models.chat.author"),
    "{{model_org}}": await retrieveConfigValue("models.chat.organization"),
    // Add all social media replacements
    ...socialReplacements
  };

  // Process system prompt and add CoT instructions
  let systemPrompt = replacePlaceholders(instructTemplate, commonReplacements);

  // Structure the prompt data in the format expected by the ChatRequestBodyCoT
  const structuredPromptData = {
    systemPrompt: systemPrompt,
    
    // Character information
    characterDescription: fileContents.character_card ? 
      `# ${currentAuthObject.bot_name}'s Description:\n${replacePlaceholders(fileContents.character_card, commonReplacements)}` : null,
      
    characterPersonality: fileContents.character_personality ? 
      `# ${currentAuthObject.bot_name}'s Personality:\n${replacePlaceholders(fileContents.character_personality, commonReplacements)}` : null,
    
    // World information
    worldInfo: fileContents.world_lore ? 
      `# World Information:\nUse this information to reflect the world and context around ${currentAuthObject.bot_name}:\n${replacePlaceholders(fileContents.world_lore, commonReplacements)}` : null,
    
    // Scenario
    scenario: fileContents.scenario ? 
      `# Scenario:\n${replacePlaceholders(fileContents.scenario, commonReplacements)}` : null,
    
    // Player information
    playerInfo: fileContents.player_info ? 
      `# Information about ${currentAuthObject.user_name}:\nThis is pertinent information regarding ${currentAuthObject.user_name} that you should always remember.\n${replacePlaceholders(fileContents.player_info, commonReplacements)}` : null,
    
    // Current chat messages
    recentChat: `# Current Messages from Chat:\nUp to the last ${await retrieveConfigValue("twitch.maxChatsToSave")} messages are provided to you from ${currentAuthObject.user_name}'s Twitch chat. Use these messages to keep up with the current conversation:\n${await returnRecentChats(userID)}`,
    
    // Weather information
    weatherInfo: currentAuthObject.weather && fileContents.weather ? 
      `# Current Weather:\n${replacePlaceholders(fileContents.weather, commonReplacements)}` : null,
    
    // Additional context elements
    additionalContext: {
      // Relevant context search results if available
      contextResults: promptData.relContext ? 
        `# Additional Information:\nExternal context relevant to the conversation:\n${promptData.relContext}` : null,
      
      // Relevant chat history if available
      chatHistory: promptData.relChats ? 
        `# Other Relevant Chat Context:\nBelow are potentially relevant chat messages sent previously, that may be relevant to the conversation:\n${promptData.relChats}` : null,
      
      // Voice interactions if available
      voiceInteractions: promptData.relVoice ? 
        `# Previous Voice Interactions:\nNon-exhaustive list of prior vocal interactions you've had with ${currentAuthObject.user_name}:\n${promptData.relVoice}` : null,
      
      // Recent voice messages if available
      recentVoice: fileContents.voice_messages ? 
        `# Current Voice Conversations with ${currentAuthObject.user_name}:\nUp to the last ${await retrieveConfigValue("twitch.maxChatsToSave")} voice messages are provided to you. Use these voice messages to help you keep up with the current conversation:\n${fileContents.voice_messages}` : null,
      
      // Emotional assessment
      emotionalAssessment: sentiment ? 
        `# Current Emotional Assessment of Message:\n- ${sentiment}` : null,
      
      // Current date/time
      dateTime: `# Current Date and Time:\n- The date and time where you and ${currentAuthObject.user_name} live is currently: ${timeStamp}`
    },
    
    // The actual user message
    userMessage: `${promptData.chat_user} says: "message"`,
    
    // Flag for chain-of-thought processing
    isChainOfThought: true
  };

  // Create the chat request body with our structured prompt data
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

/**
 * Generates a chat completion body for event-based interactions.
 * Enhanced with better support for social media templating.
 *
 * @param {string} message - The event message.
 * @param {string} userId - The user ID.
 * @returns {Promise<object>} - The chat completion body.
 */
const eventPromptChat = async (message, userId) => {
  const userObject = await returnAuthObject(userId);
  logger.log(
    "System",
    `Doing eventing stuff for: ${userObject.user_name} and ${userId}`
  );

  const instructTemplate = await withErrorHandling(
    () => getTemplate(`./instructs/system.prompt`),
    { 
      context: 'Templates', 
      defaultValue: '', 
      logError: true 
    }
  );    
  
  const timeStamp = moment().format("dddd, MMMM Do YYYY, [at] hh:mm A");

  // Load all necessary files in parallel for better performance
  const fileContents = await readPromptFiles(userId, [
    "character_personality",
    "world_lore",
    "scenario",
    "character_card",
    "weather",
    "player_info",
  ]);

  // Get social media replacements with enhanced platform-specific support
  const socialReplacements = await getSocialMediaReplacements(userId);

  // Common replacements for preprocessing text
  const commonReplacements = {
    "{{user}}": userObject.user_name,
    "{{char}}": userObject.bot_name,
    "{{char_limit}}": await retrieveConfigValue("twitch.maxCharLimit"),
    "{{model_author}}": await retrieveConfigValue("models.chat.author"),
    "{{model_org}}": await retrieveConfigValue("models.chat.organization"),
    // Add all social media replacements
    ...socialReplacements
  };

  // Process system prompt
  const systemPrompt = replacePlaceholders(instructTemplate, commonReplacements);

  // Structure the prompt data in the format expected by the new ChatRequestBody
  const structuredPromptData = {
    systemPrompt: systemPrompt,
    
    // Character information
    characterDescription: fileContents.character_card ? 
      `# ${userObject.bot_name}'s Description:\n${replacePlaceholders(fileContents.character_card, commonReplacements)}` : null,
      
    characterPersonality: fileContents.character_personality ? 
      `# ${userObject.bot_name}'s Personality:\n${replacePlaceholders(fileContents.character_personality, commonReplacements)}` : null,
    
    // World information
    worldInfo: fileContents.world_lore ? 
      `# World Information:\nUse this information to reflect the world and context around ${userObject.bot_name}:\n${replacePlaceholders(fileContents.world_lore, commonReplacements)}` : null,
    
    // Scenario
    scenario: fileContents.scenario ? 
      `# Scenario:\n${replacePlaceholders(fileContents.scenario, commonReplacements)}` : null,
    
    // Player information
    playerInfo: fileContents.player_info ? 
      `# Information about ${userObject.user_name}:\nThis is pertinent information regarding ${userObject.user_name} that you should always remember.\n${replacePlaceholders(fileContents.player_info, commonReplacements)}` : null,
    
    // Current chat messages
    recentChat: `# Current Messages from Chat:\nUp to the last ${await retrieveConfigValue("twitch.maxChatsToSave")} messages are provided to you from ${userObject.user_name}'s Twitch chat. Use these messages to keep up with the current conversation:\n${await returnRecentChats(userId)}`,
    
    // Weather information
    weatherInfo: userObject.weather && fileContents.weather ? 
      `# Current Weather:\n${replacePlaceholders(fileContents.weather, commonReplacements)}` : null,

    // Additional context elements
    additionalContext: {
      // Current date/time
      dateTime: `# Current Date and Time:\n- The date and time where you and ${userObject.user_name} live is currently: ${timeStamp}`
    },
    
    // The actual user message
    userMessage: message
  };

  // Create the chat request body with our structured prompt data
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

/**
 * Generates a prompt for querying information with specific parameters.
 *
 * @param {string} message - The query message.
 * @param {string} userId - The user ID.
 * @returns {Promise<object>} - The prompt with samplers for querying.
 */
const queryPrompt = async (message, userId) => {
  const userObject = await returnAuthObject(userId);
  const instructTemplate = await withErrorHandling(
    () => getTemplate(`./instructs/helpers/query.prompt`),
    { 
      context: 'Templates', 
      defaultValue: '', 
      logError: true 
    }
  );   const timeStamp = moment().format("MM/DD/YY [at] HH:mm");
  const [dateString, timeString] = timeStamp.split(" at ");

  // Get social media replacements with enhanced platform-specific support
  const socialReplacements = await getSocialMediaReplacements(userId);

  const replacements = {
    "{{datetime}}": `${dateString}. The current time is ${timeString}`,
    "{{query}}": message,
    "{{user}}": userObject.user_name,
    "{{char}}": userObject.bot_name,
    ...socialReplacements
  };

  const instructionTemplate = replacePlaceholders(instructTemplate, replacements);
  const promptWithSamplers = await QueryRequestBody.create(
    instructionTemplate,
    await retrieveConfigValue("models.query.model"),
    message
  )

  logger.log(
    "LLM",
    `Search query prompt is using ${await promptTokenizedFromRemote(
      promptWithSamplers.messages
    )} of your available ${await retrieveConfigValue("models.query.maxTokens")} tokens.`
  );
  return promptWithSamplers;
};

/**
 * Generates a prompt for reranking search results based on a message.
 *
 * @param {string} message - The message for reranking.
 * @param {string} userId - The user ID.
 * @returns {Promise<object>} - The prompt with samplers for reranking.
 */
const rerankPrompt = async (message, userId) => {
  logger.log("Rerank", `Received message ${message}`);
  const userObject = await returnAuthObject(userId);
  const instructTemplate = await withErrorHandling(
    () => getTemplate(`./instructs/helpers/rerank.prompt`),
    { 
      context: 'Templates', 
      defaultValue: '', 
      logError: true 
    }
  ); 
  // Get social media replacements with enhanced platform-specific support
  const socialReplacements = await getSocialMediaReplacements(userId);

  const replacements = {
    "{{user}}": userObject.user_name,
    ...socialReplacements
  };

  const instructionTemplate = replacePlaceholders(instructTemplate, replacements);
  const promptWithSamplers = await ToolRequestBody.create(
    instructionTemplate,
    await retrieveConfigValue("models.rerankTransform.model"),
    message
  )

  logger.log(
    "LLM",
    `Reranking prompt is using ${await promptTokenizedFromRemote(
      promptWithSamplers.messages
    )} of your available ${await retrieveConfigValue("models.rerankTransform.maxTokens")} tokens.`
  );
  return promptWithSamplers;
};

const summaryPrompt = async (textContent) => {
  const instructTemplate = await withErrorHandling(
    () => getTemplate(`./instructs/helpers/summary.prompt`),
    { 
      context: 'Templates', 
      defaultValue: '', 
      logError: true 
    }
  ); 
  const promptWithSamplers = await SummaryRequestBody.create(
    instructTemplate,
    await retrieveConfigValue("models.summary.model"),
    textContent
  )

  logger.log(
    "LLM",
    `Summary prompt is using ${await promptTokenizedFromRemote(
      promptWithSamplers.messages
    )} of your available ${await retrieveConfigValue("models.summary.maxTokens")} tokens.`
  );
  return promptWithSamplers;
};

/**
 * Reads multiple files and returns their contents in an object.
 *
 * @param {string} userId - The user ID.
 * @param {string[]} fileNames - An array of file names to read.
 * @returns {Promise<object>} - An object containing file names as keys and their contents as values.
 */
async function readPromptFiles(userId, fileNames) {
  const fileContents = {};
  await Promise.all(
    fileNames.map(async (fileName) => {
      const filePath = `./world_info/${userId}/${fileName}.txt`;
      try {
        fileContents[fileName] = await fs.readFile(filePath, "utf-8");
      } catch (error) {
        logger.log("Files", `Error reading file ${filePath}: ${error}`);
        fileContents[fileName] = ""; // Provide a default value or handle the error as needed
      }
    })
  );
  return fileContents;
}

/**
 * Strips specific patterns and extra whitespace from a message.
 *
 * @param {string} message - The message to be stripped.
 * @param {string} userId - The user ID.
 * @returns {Promise<string>} - The stripped message.
 */
const replyStripped = async (message, userId) => {
  const userObj = await returnAuthObject(userId);
  let formatted = message
    .replace(/(\r\n|\n|\r)/gm, " ") // Replace newlines with spaces
    .replace(new RegExp(`${userObj.bot_name}:\\s?`, "g"), "") // Remove bot's name followed by a colon and optional space
    .replace(/\(500 characters\)/g, "") // Remove (500 characters)
    .replace(/\\/g, "") // Remove backslashes
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "") // Remove only graphical emojis
    .replace(/\s+/g, " ") // Replace multiple spaces with a single space
    .replace("shoutout", "shout out")
  // Remove unmatched quotes ONLY at the beginning or end of the string
  formatted = formatted.replace(/^['"]|['"]$/g, ""); // Trim unmatched quotes at start and end

  return formatted.trim(); // Trim leading and trailing whitespace
};

/**
 * Transforms a string by replacing acronyms and specific file extensions with a modified format.
 *
 * @param {string} inputString - The string to transform.
 * @returns {Promise<object>} - An object containing the transformed string and the counts of acronyms and specific patterns found.
 */
const fixTTSString = async (inputString) => {
  const acronymRegex = /\b([A-Z]{2,})(?!\w)/g;
  const jsRegex = /\.js\b/gi;

  const exceptions = ["GOATs", "LOL", "LMAO"];

  let acronymCount = 0;
  let jsCount = 0;

  let transformedString = inputString.replace(acronymRegex, (match) => {
    if (exceptions.includes(match)) {
      return match; // Skip transformation for exceptions
    }

    acronymCount++;
    let transformed =
      match.slice(0, -1).split("").join(".") + "." + match.slice(-1);
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


/**
 * Filters out character names from a message based on a regular expression.
 *
 * @param {string} str - The message string.
 * @param {string} userId - The user ID.
 * @returns {Promise<string>} - The filtered message.
 */
const filterCharacterFromMessage = async (str, userId) => {
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

/**
 * Helper function to escape special regex characters
 * @param {string} string - String to escape
 * @returns {string} - Escaped string safe for regex
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Checks if a message contains the character's name or Twitch username.
 * Enhanced to handle multiple variations and better bot account detection.
 *
 * @param {string} message - The message to check.
 * @param {string} userId - The user ID.
 * @returns {Promise<boolean>} - True if the message contains the character's name or Twitch username, false otherwise.
 */
async function containsCharacterName(message, userId) {
  try {
    const userObj = await returnAuthObject(userId);
    
    if (!message || typeof message !== 'string') {
      return false;
    }

    const normalizedMessage = message.toLowerCase().trim();
    
    // Get all possible name variations
    const namesToCheck = new Set();
    
    // Add character/bot name
    if (userObj.bot_name) {
      namesToCheck.add(userObj.bot_name.toLowerCase());
    }
    
    // Add Twitch bot username variations
    if (userObj.bot_twitch) {
      const botTwitch = userObj.bot_twitch.toLowerCase();
      namesToCheck.add(botTwitch);
      // Remove @ if present and add both versions
      const cleanBotTwitch = botTwitch.startsWith('@') ? botTwitch.slice(1) : botTwitch;
      namesToCheck.add(cleanBotTwitch);
      namesToCheck.add('@' + cleanBotTwitch);
    }
    
    // Add the actual bot account username from tokens if available
    if (userObj.twitch_tokens?.bot?.twitch_login) {
      const botLogin = userObj.twitch_tokens.bot.twitch_login.toLowerCase();
      namesToCheck.add(botLogin);
      namesToCheck.add('@' + botLogin);
    }
    
    if (userObj.twitch_tokens?.bot?.twitch_display_name) {
      const botDisplayName = userObj.twitch_tokens.bot.twitch_display_name.toLowerCase();
      namesToCheck.add(botDisplayName);
      namesToCheck.add('@' + botDisplayName);
    }
    
    // Also check against streamer account in case bot_twitch points to streamer
    if (userObj.twitch_tokens?.streamer?.twitch_login) {
      const streamerLogin = userObj.twitch_tokens.streamer.twitch_login.toLowerCase();
      namesToCheck.add(streamerLogin);
      namesToCheck.add('@' + streamerLogin);
    }
    
    // Remove empty/undefined entries
    const validNames = Array.from(namesToCheck).filter(name => name && name.length > 0);
    
    if (validNames.length === 0) {
      logger.warn("Twitch", `No valid bot names found for user ${userId} when checking mentions`);
      return false;
    }
    
    // Check each name variation
    for (const nameToCheck of validNames) {
      // Exact word match (handles @mentions and regular mentions)
      const wordBoundaryRegex = new RegExp(`\\b${escapeRegExp(nameToCheck)}\\b`, 'i');
      if (wordBoundaryRegex.test(normalizedMessage)) {
        logger.log("Twitch", `Character name detected: "${nameToCheck}" in message: "${message}"`);
        return true;
      }
      
      // Also check for @ mentions without word boundaries (for usernames with special chars)
      if (nameToCheck.startsWith('@')) {
        const atMentionRegex = new RegExp(`${escapeRegExp(nameToCheck)}`, 'i');
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

/**
 * Checks if a message contains the player's social media identifiers.
 *
 * @param {string} message - The message to check.
 * @param {string} userId - The user ID.
 * @returns {Promise<boolean>} - True if the message contains the player's social media identifiers, false otherwise.
 */
async function containsPlayerSocials(message, userId) {
  const userObj = await returnAuthObject(userId);
  const nameRegex = new RegExp(userObj.twitch_name, "i");
  return nameRegex.test(message);
}

/**
 * Enhanced containsAuxBotName function with better bot detection
 * Checks if a message contains any of the auxiliary bot names.
 *
 * @param {string} message - The message to check.
 * @param {string} userId - The user ID.
 * @returns {Promise<boolean>} - True if the message contains any of the auxiliary bot names, false otherwise.
 */
async function containsAuxBotName(message, userId) {
  try {
    const userObj = await returnAuthObject(userId);
    
    if (!message || typeof message !== 'string' || !Array.isArray(userObj.aux_bots)) {
      return false;
    }
    
    const normalizedMessage = message.toLowerCase();
    
    // Check each aux bot name
    for (const botName of userObj.aux_bots) {
      if (!botName || typeof botName !== 'string') continue;
      
      const normalizedBotName = botName.toLowerCase();
      
      // Check for exact word match
      const wordBoundaryRegex = new RegExp(`\\b${escapeRegExp(normalizedBotName)}\\b`, 'i');
      if (wordBoundaryRegex.test(normalizedMessage)) {
        logger.log("Twitch", `Aux bot name detected: "${botName}" in message, ignoring`);
        return true;
      }
      
      // Also check with @ prefix
      const atBotName = '@' + normalizedBotName;
      const atMentionRegex = new RegExp(`\\b${escapeRegExp(atBotName)}\\b`, 'i');
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
  containsCharacterName
};