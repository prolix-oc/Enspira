import fs from "fs-extra";
import moment from "moment";
import { socialMedias, returnTwitchEvent } from "./twitch_helper.js";
import { interpretEmotions } from "./data-helper.js";
import { returnAuthObject } from "./api-helper.js";
import { getPromptCount } from "./token-helper.js";
import { retrieveConfigValue } from "./config-helper.js";

/**
 * Generates a prompt for model moderation based on a message and user ID.
 *
 * @param {string} message - The message to moderate.
 * @param {string} userId - The ID of the user.
 * @returns {Promise<object>} - The prompt with samplers for moderation.
 */
const moderatorPrompt = async (message, userId) => {
  const userObject = await returnAuthObject(userId);
  const instructTemplate = await fs.readFile(
    `./instructs/helpers/moderation.prompt`,
    "utf-8"
  );

  const replacements = {
    "{{player}}": userObject.player_name,
    "{{char}}": userObject.bot_name,
    "{{twitch}}": userObject.twitch_name,
    "{{socials}}": await socialMedias(userId),
    "{{modlist}}": userObject.mod_list.join("\n- "),
    "{{sites}}": userObject.approved_sites.join("\n- "),
  };

  const instructionTemplate = replacePlaceholders(instructTemplate, replacements);
  const promptWithSamplers = await formToolRequestBody(
    instructionTemplate,
    await retrieveConfigValue("models.moderator.model"),
    message
  );

  logger.log(
    "LLM",
    `Prompt is using ${await getPromptCount(
      instructionTemplate,
      message,
      await retrieveConfigValue("models.moderator.modelType")
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
  const instructTemplate = await fs.readFile(
    `./instructs/system.prompt`,
    "utf-8"
  );
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

  let userInfoString = `\n\n## Information about Who Messaged You\n`;
  if (promptData.user) {
    const user = promptData.user;
    if (user.gender) {
      userInfoString += `- The user's gender is ${user.gender}.\n`;
    }
    if (user.age) {
      userInfoString += `- The user is ${user.age} years old.\n`;
    }
    if (user.residence) {
      userInfoString += `- The user's residence is ${user.residence}.\n`;
    }
  } else {
    userInfoString += "- No additional user information available.\n";
  }

  // **1. Corrected Replacements Object (Including Character Card):**
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
    "{{weather}}": `\n\n${
      currentAuthObject.weather ? fileContents.weather : ""
    }`,
    "{{voice}}": `\n## Previous Voice Interactions:\nNon-exhaustive list of prior vocal interactions you've had with ${currentAuthObject.player_name}:\n${promptData.relVoice}`,
    "{{recent_voice}}": `\n\n## Current Voice Conversations with ${currentAuthObject.player_name}:\nUp to the last ${await retrieveConfigValue(
      "twitch.maxChatsToSave"
    )} voice messages are provided to you. Use these voice messages to help you keep up with the current conversation:\n${
      fileContents.voice_messages
    }`,
    "{{recent_chat}}": `\n\n## Current Messages from Chat:\nUp to the last ${await retrieveConfigValue(
      "twitch.maxChatsToSave"
    )} messages are provided to you from ${
      currentAuthObject.player_name
    }'s Twitch chat. Use these messages to keep up with the current conversation:\n${
      fileContents.twitch_chat
    }`,
    "{{emotion}}": `\n\n## Current Emotional Assessment of Message:\n- ${sentiment}`,
    // ** Include user information string, be sure that your template includes this tag:
    "{{user_info}}": userInfoString, 
  };

  const postProcessReplacements = {
    "{{player}}": currentAuthObject.player_name,
    "{{char}}": currentAuthObject.bot_name,
    "{{char_limit}}": await retrieveConfigValue("twitch.maxCharLimit"),
    "{{user}}": promptData.user, // This should probably be JSON.stringify(promptData.user) to include all user fields, or you can customize it
    "{{socials}}": await socialMedias(userID),
    "{{soc_tiktok}}": await socialMedias(userID, "tiktok"),
  };

  // 2. Properly use replacePlaceholders on both templates:
  const instructionTemplate = replacePlaceholders(instructTemplate, {
    ...replacements,
    ...postProcessReplacements,
  });
  const dynamicTemplate = replacePlaceholders(dynamicPrompt, {
    ...replacements,
    ...postProcessReplacements,
  });

  const promptWithSamplers = await formChatRequestBody(
    instructionTemplate,
    dynamicTemplate,
    message,
    promptData.user
  );

  logger.log(
    "LLM",
    `Prompt is using ${await getPromptCount(
      instructTemplate,
      message,
      await retrieveConfigValue("models.chat.modelType"),
      dynamicTemplate
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

  const instructTemplate = await fs.readFile(
    `./instructs/system.prompt`,
    "utf-8"
  );
  const dynamicPrompt = await fs.readFile(
    "./instructs/dynamic.prompt",
    "utf-8"
  );

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
    "{{weather}}": `\n\n${
      userObject.weather ? fileContents.weather : ""
    }`,
    "{{recent_chat}}": `\n\n## Current Messages from Chat:\nUp to the last ${await retrieveConfigValue(
      "twitch.maxChatsToSave"
    )} messages are provided to you from ${
      userObject.player_name
    }'s Twitch chat. Use these messages to keep up with the current conversation:\n${
      fileContents.twitch_chat
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

  // 3. Properly use replacePlaceholders:
  // Apply replacements to both templates
  const instructionTemplate = replacePlaceholders(
    instructTemplate,
    {...replacements, ...postProcessReplacements} // Merge replacements for easier use
  );
  const dynamicTemplate = replacePlaceholders(
    dynamicPrompt,
    {...replacements, ...postProcessReplacements} // Merge replacements for easier use
  );

  const promptWithSamplers = await formChatRequestBody(
    instructionTemplate,
    dynamicTemplate,
    message
  );

  logger.log(
    "LLM",
    `Prompt is using ${await getPromptCount(
      instructionTemplate,
      message,
      await retrieveConfigValue("models.chat.modelType"),
      dynamicTemplate
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
  const instructTemplate = await fs.readFile(
    "./instructs/helpers/query.prompt",
    "utf-8"
  );
  const timeStamp = moment().format("MM/DD/YY [at] HH:mm");
  const [dateString, timeString] = timeStamp.split(" at ");

  const replacements = {
    "{{datetime}}": `${dateString}. The current time is ${timeString}`,
    "{{query}}": message,
    "{{player}}": userObject.player_name,
    "{{socials}}": await socialMedias(userId),
  };

  const instructionTemplate = replacePlaceholders(instructTemplate, replacements);
  const promptWithSamplers = await formToolRequestBody(
    instructionTemplate,
    await retrieveConfigValue("models.query.model"),
    message
  );

  logger.log(
    "LLM",
    `Prompt is using ${await getPromptCount(
      instructionTemplate,
      message,
      await retrieveConfigValue("models.query.modelType")
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
  const instructTemplate = await fs.readFile(
    "./instructs/helpers/rerank.prompt",
    "utf-8"
  );

  const replacements = {
    "{{socials}}": await socialMedias(userId),
    "{{player}}": userObject.player_name,
  };

  const instructionTemplate = replacePlaceholders(instructTemplate, replacements);
  const promptWithSamplers = await formToolRequestBody(
    instructionTemplate,
    await retrieveConfigValue("models.rerank.model"),
    message
  );

  logger.log(
    "LLM",
    `Prompt is using ${await getPromptCount(
      instructionTemplate,
      message,
      await retrieveConfigValue("models.rerank.modelType")
    )} of your available ${await retrieveConfigValue("models.rerank.maxTokens")} tokens.`
  );
  return promptWithSamplers;
};

const summaryPrompt = async (textContent) => {
  const instructTemplate = await fs.readFile(
    "./instructs/helpers/summary.prompt",
    "utf-8"
  );

  const promptWithSamplers = await formToolRequestBody(
    instructTemplate,
    await retrieveConfigValue("models.summary.model"),
    textContent,
    1.0,
    1.0
  );
  logger.log(
    "LLM",
    `Prompt is using ${await getPromptCount(
      instructTemplate,
      textContent,
      await retrieveConfigValue("models.summary.modelType")
    )} of your available ${await retrieveConfigValue("models.query.maxTokens")} tokens.`
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
 * Forms a request body for tool-related operations with specific parameters.
 *
 * @param {string} prompt - The prompt for the tool.
 * @param {string} model - The model to be used.
 * @param {string} message - The message for the tool.
 * @param {number} [temp=0.6] - The temperature parameter.
 * @param {number} [top_p=0.9] - The top-p parameter.
 * @returns {Promise<object>} - The request body for the tool operation.
 */
async function formToolRequestBody(
  prompt,
  model,
  message,
  temp = 0.6,
  top_p = 0.9
) {
  return {
    model: model,
    messages: [
      {
        role: "system",
        content: prompt,
      },
      {
        role: "user",
        content: message,
      },
    ],
    temperature: temp,
    top_p: top_p,
  };
}

/**
 * Forms a request body for chat completion with specific parameters.
 *
 * @param {string} prompt - The prompt for the chat completion.
 * @param {string} context - Additional context for the chat.
 * @param {string} message - The user message.
 * @param {string} [user=""] - The user identifier.
 * @returns {Promise<object>} - The request body for chat completion.
 */
async function formChatRequestBody(prompt, context, message, user = "") {
  const userFrom =
    user === "" ? message : `${user} sends the following message: ${message}`;

  const messages = [
    {
      role: "system",
      content: prompt,
    },
  ];

  if (context) {
    messages.push({
      role: "user",
      content: context,
    });
  }

  messages.push({
    role: "assistant",
    content:
      "I understand. I'll keep the provided rules, character information, and given context in mind when responding to the next user message.",
  });

  messages.push({
    role: "user",
    content: userFrom,
  });

  return {
    model: await retrieveConfigValue("models.chat.model"),
    messages: messages,
    max_tokens: await retrieveConfigValue("samplers.maxTokens"),
    generate_window: await retrieveConfigValue("samplers.generateWindow"),
    stream: false,
    speculative_ngram: await retrieveConfigValue("samplers.speculativeNgram"),
    token_healing: true,
    top_k: await retrieveConfigValue("samplers.topK"),
    min_p: await retrieveConfigValue("samplers.minP"),
    xtc_threshold: await retrieveConfigValue("samplers.xtcThreshold"),
    xtc_probability: await retrieveConfigValue("samplers.xtcProbabilty"),
    top_p: await retrieveConfigValue("samplers.topP"),
    typical_p: await retrieveConfigValue("samplers.typicalP"),
    dry_base: await retrieveConfigValue("samplers.dryBase"),
    dry_allowed_length: await retrieveConfigValue("samplers.dryLength"),
    dry_multiplier: await retrieveConfigValue("samplers.dryMultiplier"),
    min_tokens: await retrieveConfigValue("samplers.minTokens"),
    repetition_penalty: await retrieveConfigValue("samplers.repetitionPenalty"),
    temperature: await retrieveConfigValue("samplers.temperature"),
  };
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
  return message
    .replace(/(\r\n|\n|\r)/gm, " ")
    .replace(new RegExp(`${userObj.bot_name}:\\s?`, "g"), "")
    .replace(/\(500 characters\)/g, "")
    .replace(/\\/g, "")
    .replace(/\*[^*]*\*/g, "")
    .replace(/\s+/g, " ")
    .replace(/^["']|["']$/g, "")
    .trim();
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

  let acronymCount = 0;
  let jsCount = 0;

  let transformedString = inputString.replace(acronymRegex, (match) => {
    acronymCount++;
    let transformed =
      match.slice(0, -1).split("").join(".") + "." + match.slice(-1);
    if (match.endsWith("S")) {
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
  fixTTSString,
  rerankPrompt,
  eventPromptChat,
  containsCharacterName,
};