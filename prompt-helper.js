import fs from "fs-extra";
import moment from "moment";
import { socialMedias } from "./twitch-helper.js";
import { interpretEmotions } from "./data-helper.js";
import { returnAuthObject } from "./api-helper.js";
import { getPromptTokens, getOutputTokens, tokenizedFromRemote, promptTokenizedFromRemote } from "./token-helper.js";
import { retrieveConfigValue } from "./config-helper.js";
import { returnRecentChats } from "./ai-logic.js";
import { ChatRequestBody, ChatRequestBodyCoT, ToolRequestBody, QueryRequestBody, ModerationRequestBody, SummaryRequestBody } from "./oai-requests.js";
import { jsonrepair } from 'jsonrepair'
import OpenAI from "openai";
import { performance } from "node:perf_hooks";

const templateCache = {};

async function getTemplate(filePath) {
  if (templateCache[filePath]) {
    return templateCache[filePath];
  }
  try {
    const content = await fs.readFile(filePath, "utf-8");
    templateCache[filePath] = content;
    return content;
  } catch (error) {
    logger.log("Files", `Error reading template file ${filePath}: ${error}`);
    throw error;
  }
}

export async function sendChatCompletionRequest(requestBody, modelConfig) {
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
        fullResponse += content;
      }
    }

    // Calculate backend processing time in seconds
    const backendTimeElapsed = (performance.now() - backendStartTime) / 1000;

    // Tokenize the full response using the remote service
    const generatedTokens = await tokenizedFromRemote(fullResponse, modelConfig.modelType);
    let backendTokensPerSecond = 0;
    if (backendTimeElapsed > 0 && generatedTokens > 0) {
      backendTokensPerSecond = (generatedTokens / backendTimeElapsed).toFixed(2);
    }

    return {
      response: fullResponse,
      timeToFirstToken: firstTokenTimeElapsed ? firstTokenTimeElapsed.toFixed(3) : null,
      tokensPerSecond: backendTokensPerSecond,
    };
  } catch (error) {
    logger.log(
      "API",
      `OpenAI chat completion error: ${error}; Model Config: ${JSON.stringify(modelConfig)}`
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
    const stream = await openai.chat.completions.create(requestBody);

    for await (const part of stream) {
      const content = part.choices[0]?.delta?.content;
      if (content) {
        if (firstTokenTimeElapsed === null) {
          firstTokenTimeElapsed = (performance.now() - startTime) / 1000;
          backendStartTime = performance.now();
        }
        fullResponse += content;
      }
    }

    const backendTimeElapsed = (performance.now() - backendStartTime) / 1000;
    const generatedTokens = await tokenizedFromRemote(fullResponse, modelConfig.modelType);
    let backendTokensPerSecond = 0;
    if (backendTimeElapsed > 0 && generatedTokens > 0) {
      backendTokensPerSecond = (generatedTokens / backendTimeElapsed).toFixed(2);
    }

    let formattedResponse;
    let thoughtsArray = [];
    let fullOutput = null;
    try {
      const fixedResponse = jsonrepair(fullResponse);
      formattedResponse = JSON.parse(fixedResponse);
      if (formattedResponse.thoughts) {
        for (const thought of formattedResponse.thoughts) {
          if (thought !== "") thoughtsArray.push(thought);
        }
      }
      fullOutput = formattedResponse.final_response;
    } catch (parseError) {
      logger.log(
        "API",
        `Error parsing JSON response: ${parseError}; Response: ${fullResponse}`,
        "error"
      );
      return { error: `Error parsing JSON: ${parseError.message}`, rawResponse: fullResponse };
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
      `OpenAI chat completion error: ${error}; Model Config: ${JSON.stringify(modelConfig)}`
    );
    return { error: error.message };
  }
}

const moderatorPrompt = async (message, userId) => {
  const userObject = await returnAuthObject(userId);
  const instructTemplate = await getTemplate("./instructs/helpers/moderation.prompt");
  
  const replacements = {
    "{{player}}": userObject.player_name,
    "{{char}}": userObject.bot_name,
    "{{twitch}}": userObject.twitch_name,
    "{{socials}}": await socialMedias(userId),
    "{{modlist}}": userObject.mod_list.join("\n- "),
    "{{sites}}": userObject.approved_sites.join("\n- "),
  };

  const instructionTemplate = replacePlaceholders(instructTemplate, replacements);
  const promptWithSamplers = await ModerationRequestBody.create(
    instructionTemplate,
    await retrieveConfigValue("models.moderator.model"),
    message
  )
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
 *
 * @param {object} promptData - Data containing relevant context, chats, and voice interactions.
 * @param {string} message - The user message.
 * @param {string} userID - The user ID.
 * @returns {Promise<object>} - The chat completion body.
 */
const contextPromptChat = async (promptData, message, userID) => {
  const currentAuthObject = await returnAuthObject(userID);
  const instructTemplate = await getTemplate(`./instructs/system_cot.prompt`);
  const dynamicPrompt = await fs.readFile(
    `./instructs/dynamic.prompt`,
    "utf-8"
  );

  const timeStamp = moment().format("dddd, MMMM Do YYYY, [at] hh:mm A");

  const fileContents = await readPromptFiles(userID, [
    "character_personality",
    "world_lore",
    "scenario",
    "character_card",
    "weather",
    "twitch_chat",
    "rules",
    "player_info",
    "voice_messages",
  ]);

  const sentiment = await interpretEmotions(message);
  logger.log("LLM", `Analysis of emotions: ${sentiment}`);
  const user = promptData.user

  const replacements = {
    "{{datetime}}": `\n- The date and time where you and ${currentAuthObject.player_name} live is currently: ${timeStamp}`,
    "{{ctx}}": `\n\n## Additional Information:\nExternal context relevant to the conversation:\n${promptData.relContext}`,
    "{{ruleset}}": `\n\n# Guidelines\n${fileContents.rules}`,
    "{{chat}}": `\n## Other Relevant Chat Context:\nBelow are potentially relevant chat messages sent previously, that may be relevant to the conversation:\n${promptData.relChats}`,
    // Make sure character card is included:
    "{{card}}": `\n\n## ${currentAuthObject.bot_name}'s Description:\n${fileContents.character_card}`,
    "{{persona}}": `\n\n## ${currentAuthObject.bot_name}'s Personality:\n${fileContents.character_personality}`,
    "{{player_info}}": `\n\n## Information about ${currentAuthObject.player_name}:\nThis is pertinent information regarding ${currentAuthObject.player_name} that you should always remember.\n${fileContents.player_info}`,
    "{{lore}}": `\n\n## World Information:\nUse this information to reflect the world and context around ${currentAuthObject.bot_name}:\n${fileContents.world_lore}`,
    "{{scene}}": `\n\n## Scenario:\n${fileContents.scenario}`,
    "{{weather}}": `\n\n${currentAuthObject.weather ? fileContents.weather : ""
      }`,
    "{{voice}}": `\n## Previous Voice Interactions:\nNon-exhaustive list of prior vocal interactions you've had with ${currentAuthObject.player_name}:\n${promptData.relVoice}`,
    "{{recent_voice}}": `\n\n## Current Voice Conversations with ${currentAuthObject.player_name}:\nUp to the last ${await retrieveConfigValue(
      "twitch.maxChatsToSave"
    )} voice messages are provided to you. Use these voice messages to help you keep up with the current conversation:\n${fileContents.voice_messages
      }`,
    "{{recent_chat}}": `\n\n## Current Messages from Chat:\nUp to the last ${await retrieveConfigValue(
      "twitch.maxChatsToSave"
    )} messages are provided to you from ${currentAuthObject.player_name
      }'s Twitch chat. Use these messages to keep up with the current conversation:\n${await returnRecentChats(userID)
      }`,
    "{{emotion}}": `\n\n## Current Emotional Assessment of Message:\n- ${sentiment}`
  };

  const postProcessReplacements = {
    "{{player}}": currentAuthObject.player_name,
    "{{char}}": currentAuthObject.bot_name,
    "{{char_limit}}": await retrieveConfigValue("twitch.maxCharLimit"),
    "{{user}}": promptData.user,
    "{{socials}}": await socialMedias(userID),
    "{{soc_tiktok}}": await socialMedias(userID, "tt"),
  };

  const instructionTemplate = replacePlaceholders(instructTemplate, {
    ...replacements,
    ...postProcessReplacements,
  });
  const dynamicTemplate = replacePlaceholders(dynamicPrompt, {
    ...replacements,
    ...postProcessReplacements,
  });

  const promptWithSamplers = await ChatRequestBody.create(
    instructionTemplate,
    dynamicTemplate,
    message,
    user
  )

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
  const instructTemplate = await getTemplate(`./instructs/system_cot.prompt`);
  const dynamicPrompt = await getTemplate(`./instructs/dynamic.prompt`);

  const timeStamp = moment().format("dddd, MMMM Do YYYY, [at] hh:mm A");

  const fileContents = await readPromptFiles(userID, [
    "character_personality",
    "world_lore",
    "scenario",
    "character_card",
    "weather",
    "twitch_chat",
    "rules",
    "player_info",
    "voice_messages",
  ]);

  const sentiment = await interpretEmotions(message);
  logger.log("LLM", `Analysis of emotions: ${sentiment}`);
  const user = promptData.user

  const replacements = {
    "{{datetime}}": `\nThe current date and time where you and ${currentAuthObject.player_name} live is currently: ${timeStamp}`,
    "{{ctx}}": `\n\n## Additional Information:\nExternal context relevant to the conversation:\n${promptData.relContext}`,
    "{{ruleset}}": `\n\n# Guidelines\n${fileContents.rules}`,
    "{{chat}}": `\n## Other Relevant Chat Context:\nBelow are potentially relevant chat messages sent previously, that may be relevant to the conversation:\n${promptData.relChats}`,
    "{{card}}": `\n\n## ${currentAuthObject.bot_name}'s Description:\n${fileContents.character_card}`,
    "{{persona}}": `\n\n## ${currentAuthObject.bot_name}'s Personality:\n${fileContents.character_personality}`,
    "{{player_info}}": `\n\n## Information about ${currentAuthObject.player_name}:\nThis is pertinent information regarding ${currentAuthObject.player_name} that you should always remember.\n${fileContents.player_info}`,
    "{{lore}}": `\n\n## World Information:\nUse this information to reflect the world and context around ${currentAuthObject.bot_name}:\n${fileContents.world_lore}`,
    "{{scene}}": `\n\n## Scenario:\n${fileContents.scenario}`,
    "{{weather}}": `\n\n${currentAuthObject.weather ? fileContents.weather : ""
      }`,
    "{{voice}}": `\n## Previous Voice Interactions:\nNon-exhaustive list of prior vocal interactions you've had with ${currentAuthObject.player_name}:\n${promptData.relVoice}`,
    "{{recent_voice}}": `\n\n## Current Voice Conversations with ${currentAuthObject.player_name}:\nUp to the last ${await retrieveConfigValue(
      "twitch.maxChatsToSave"
    )} voice messages are provided to you. Use these voice messages to help you keep up with the current conversation:\n${fileContents.voice_messages
      }`,
    "{{recent_chat}}": `\n\n## Current Messages from Chat:\nUp to the last ${await retrieveConfigValue(
      "twitch.maxChatsToSave"
    )} messages are provided to you from ${currentAuthObject.player_name
      }'s Twitch chat. Use these messages to keep up with the current conversation:\n${await returnRecentChats(userID)
      }`,
    "{{emotion}}": `\n\n## Current Emotional Assessment of Message:\n- ${sentiment}`
  };

  const postProcessReplacements = {
    "{{player}}": currentAuthObject.player_name,
    "{{char}}": currentAuthObject.bot_name,
    "{{char_limit}}": await retrieveConfigValue("twitch.maxCharLimit"),
    "{{user}}": promptData.user,
    "{{socials}}": await socialMedias(userID),
    "{{soc_tiktok}}": await socialMedias(userID, "tt"),
  };

  const instructionTemplate = replacePlaceholders(instructTemplate, {
    ...replacements,
    ...postProcessReplacements,
  });
  const dynamicTemplate = replacePlaceholders(dynamicPrompt, {
    ...replacements,
    ...postProcessReplacements,
  });

  const promptWithSamplers = await ChatRequestBodyCoT.create(
    instructionTemplate,
    dynamicTemplate,
    message,
    user
  )

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
 *
 * @param {string} message - The event message.
 * @param {string} userId - The user ID.
 * @returns {Promise<object>} - The chat completion body.
 */
const eventPromptChat = async (message, userId) => {
  const userObject = await returnAuthObject(userId);
  logger.log(
    "System",
    `Doing eventing stuff for: ${userObject.player_name} and ${userId}`
  );

  const instructTemplate = await getTemplate(`./instructs/system.prompt`);
  const dynamicPrompt = await getTemplate("./instructs/dynamic.prompt");

  const timeStamp = moment().format("dddd, MMMM Do YYYY, [at] hh:mm A");

  const fileContents = await readPromptFiles(userId, [
    "character_personality",
    "world_lore",
    "scenario",
    "character_card",
    "weather",
    "twitch_chat",
    "rules",
    "player_info",
  ]);

  // **1. Corrected Replacements Object:**
  const replacements = {
    "{{datetime}}": `\n- The date and time where you and ${userObject.player_name} live is currently: ${timeStamp}`,
    "{{ruleset}}": `\n\n# Guidelines\n${fileContents.rules}`,
    "{{card}}": `\n\n## ${userObject.bot_name}'s Description:\n${fileContents.character_card}`,
    "{{persona}}": `\n\n## ${userObject.bot_name}'s Personality:\n${fileContents.character_personality}`,
    "{{lore}}": `\n\n## World Information:\nUse this information to reflect the world and context around ${userObject.bot_name}:\n${fileContents.world_lore}`,
    "{{scene}}": `\n\n## Scenario:\n${fileContents.scenario}`,
    "{{weather}}": `\n\n${userObject.weather ? fileContents.weather : ""
      }`,
    "{{recent_chat}}": `\n\n## Current Messages from Chat:\nUp to the last ${await retrieveConfigValue(
      "twitch.maxChatsToSave"
    )} messages are provided to you from ${userObject.player_name
      }'s Twitch chat. Use these messages to keep up with the current conversation:\n${await returnRecentChats(userId)
      }`,
    // Add the player info
    "{{player_info}}": `\n\n## Information about ${userObject.player_name}:\nThis is pertinent information regarding ${userObject.player_name} that you should always remember.\n${fileContents.player_info}`,
    // Remove the unused replacements that were causing duplication
    "{{emotion}}": "",
    "{{voice}}": "",
    "{{ctx}}": "",
    "{{chat}}": "",
    "{{recent_voice}}": "",
  };

  const postProcessReplacements = {
    "{{player}}": userObject.player_name,
    "{{char}}": userObject.bot_name,
    "{{char_limit}}": await retrieveConfigValue("twitch.maxCharLimit"),
    "{{socials}}": await socialMedias(userId),
  };

  const instructionTemplate = replacePlaceholders(
    instructTemplate,
    { ...replacements, ...postProcessReplacements } // Merge replacements for easier use
  );
  const dynamicTemplate = replacePlaceholders(
    dynamicPrompt,
    { ...replacements, ...postProcessReplacements } // Merge replacements for easier use
  );

  const promptWithSamplers = await ChatRequestBody.create(
    instructionTemplate,
    dynamicTemplate,
    message
  )

  await fs.writeJSON('./prompt-event.json', promptWithSamplers, { spaces: 2 })

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
  const instructTemplate = await getTemplate("./instructs/helpers/query.prompt");
  const timeStamp = moment().format("MM/DD/YY [at] HH:mm");
  const [dateString, timeString] = timeStamp.split(" at ");

  const replacements = {
    "{{datetime}}": `${dateString}. The current time is ${timeString}`,
    "{{query}}": message,
    "{{player}}": userObject.player_name,
    "{{socials}}": await socialMedias(userId),
    "{{char}}": userObject.bot_name
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
  const instructTemplate = await getTemplate("./instructs/helpers/rerank.prompt");

  const replacements = {
    "{{socials}}": await socialMedias(userId),
    "{{player}}": userObject.player_name,
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
  const instructTemplate = await getTemplate("./instructs/helpers/summary.prompt");

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
 * Replaces placeholders in a template string with corresponding values from a replacements object.
 *
 * @param {string} template - The template string containing placeholders.
 * @param {object} replacements - An object where keys are placeholders and values are their replacements.
 * @returns {string} - The template string with placeholders replaced by their corresponding values.
 */
function replacePlaceholders(template, replacements) {
  let result = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(placeholder, "g"), value);
  }
  return result;
}

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
    .replace(/\s+/g, " "); // Replace multiple spaces with a single space

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
 * Checks if a message contains the character's name or Twitch username.
 *
 * @param {string} message - The message to check.
 * @param {string} userId - The user ID.
 * @returns {Promise<boolean>} - True if the message contains the character's name or Twitch username, false otherwise.
 */
async function containsCharacterName(message, userId) {
  const userObj = await returnAuthObject(userId);
  const characterName = userObj.bot_name;
  const characterTwitchUser = userObj.bot_twitch;

  const nameRegex = new RegExp(characterName, "i");

  const twitchHandle = characterTwitchUser.startsWith("@")
    ? characterTwitchUser.slice(1)
    : characterTwitchUser;
  const twitchHandleRegex = new RegExp(twitchHandle, "i");

  return nameRegex.test(message) || twitchHandleRegex.test(message);
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
 * Checks if a message contains any of the auxiliary bot names.
 *
 * @param {string} message - The message to check.
 * @param {string} userId - The user ID.
 * @returns {Promise<boolean>} - True if the message contains any of the auxiliary bot names, false otherwise.
 */
async function containsAuxBotName(message, userId) {
  const userObj = await returnAuthObject(userId);
  const auxBots = [...userObj.aux_bots];
  if (typeof message !== "string" || !Array.isArray(auxBots)) {

  }

  const lowerCaseMessage = message.toLowerCase();
  for (const username of auxBots) {
    if (lowerCaseMessage.includes(username.toLowerCase())) {
      return true;
    }
  }
  return false;
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