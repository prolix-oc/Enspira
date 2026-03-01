/**
 * Prompt Builder module for Enspira
 * Handles template caching, placeholder replacement, and prompt assembly
 * @module core/prompt-builder
 */

import fs from 'fs-extra';
import moment from 'moment';
import { logger } from './logger.js';
import { retrieveConfigValue } from './config.js';
import { promptTokenizedFromRemote } from './tokenizer.js';
import { returnAuthObject } from './api-helper.js';
import { interpretEmotions } from './data-helper.js';
import {
  ChatRequestBody,
  ChatRequestBodyCoT,
  ToolRequestBody,
  QueryRequestBody,
  ModerationRequestBody,
  SummaryRequestBody,
} from './llm-requests.js';
import { utils } from '../utils/index.js';

// Cross-module imports
import { socialMedias } from '../integrations/twitch/helper.js';
import { returnRecentChats } from './rag-context.js';

import type {
  PromptFileContents,
  ContextPromptData,
  StructuredPromptData,
  BaseLLMRequestBody,
  ModerationCacheEntry,
} from '../types/index.js';

const { getTemplate } = utils.file;
const { replacePlaceholders } = utils.string;
const { withErrorHandling } = utils.error;

import type { ChatMessage as TypesChatMessage } from '../types/ai.types.js';

/**
 * Converts messages to format expected by tokenizer
 */
function convertMessagesForTokenizer(
  messages: TypesChatMessage[]
): Array<{ role: string; content: string }> {
  return messages.map((msg) => ({
    role: msg.role,
    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
  }));
}

// ============================================
// Template Cache Management
// ============================================

/** Maximum template cache size */
const MAX_TEMPLATE_CACHE_SIZE = 50;

/** Template cache storage */
const templateCache = new Map<string, string>();

/**
 * Adds an entry to the template cache with LRU eviction
 *
 * @param key - Cache key
 * @param value - Template content
 */
function addToTemplateCache(key: string, value: string): void {
  if (templateCache.size >= MAX_TEMPLATE_CACHE_SIZE) {
    // Remove oldest entry
    const firstKey = templateCache.keys().next().value;
    if (firstKey) {
      templateCache.delete(firstKey);
    }
  }
  templateCache.set(key, value);
}

/**
 * Gets a template from cache or null if not cached
 */
function getFromTemplateCache(key: string): string | undefined {
  return templateCache.get(key);
}

/**
 * Clears the template cache
 */
export function clearTemplateCache(): void {
  templateCache.clear();
  logger.log('System', 'Template cache cleared');
}

/**
 * Gets template cache statistics
 */
export function getTemplateCacheStats(): { size: number; maxSize: number } {
  return {
    size: templateCache.size,
    maxSize: MAX_TEMPLATE_CACHE_SIZE,
  };
}

// ============================================
// Moderation Cache Management
// ============================================

/** Maximum moderation prompt cache size */
const MAX_MODERATION_CACHE = 25;

/** Moderation prompt cache storage */
const moderationPromptCache = new Map<string, ModerationCacheEntry>();

/** Moderation cache TTL in milliseconds (5 minutes) */
const MODERATION_CACHE_TTL = 300000;

/**
 * Clears the moderation prompt cache
 */
export function clearModerationCache(): void {
  moderationPromptCache.clear();
  logger.log('System', 'Moderation prompt cache cleared');
}

// ============================================
// Social Media Replacements
// ============================================

/**
 * Helper function to extract all social media replacements for templates.
 * Gets both the full socials string and individual platform entries.
 *
 * @param userId - The user ID
 * @returns Object containing all social media replacements
 */
export async function getSocialMediaReplacements(
  userId: string
): Promise<Record<string, string>> {
  try {
    // Get the complete socials string for {{socials}} replacement
    const allSocials = (await socialMedias(userId)) as string;

    // Create the base replacements object
    const replacements: Record<string, string> = {
      '{{socials}}': allSocials || '',
    };

    // Get all available platforms for the user
    const socialPlatforms = (await socialMedias(userId, 'all')) as Record<string, string>;

    // Add individual platform replacements
    for (const [platform, value] of Object.entries(socialPlatforms)) {
      if (value && value.trim() !== '') {
        replacements[`{{socials.${platform}}}`] = value;
      }
    }

    // Add specific commonly used platform shortcuts
    // These are kept for backward compatibility
    replacements['{{soc_tiktok}}'] = ((await socialMedias(userId, 'tiktok')) as string) || '';
    replacements['{{soc_youtube}}'] = ((await socialMedias(userId, 'youtube')) as string) || '';
    replacements['{{soc_twitter}}'] = ((await socialMedias(userId, 'twitter')) as string) || '';
    replacements['{{soc_instagram}}'] = ((await socialMedias(userId, 'instagram')) as string) || '';

    return replacements;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.log('System', `Error getting social media replacements: ${errorMessage}`);
    return { '{{socials}}': '' };
  }
}

// ============================================
// File Reading
// ============================================

/** Maximum file size for prompt files (50KB) */
const MAX_PROMPT_FILE_SIZE = 50000;

/**
 * Reads multiple prompt files with batched processing and memory limits
 *
 * @param userId - User ID to load files for
 * @param fileNames - Array of file names to load
 * @returns Object with file contents keyed by file name
 */
export async function readPromptFiles(
  userId: string,
  fileNames: string[]
): Promise<PromptFileContents> {
  const fileContents: PromptFileContents = {};

  // Process files in smaller batches to reduce memory pressure
  const batchSize = 3;
  for (let i = 0; i < fileNames.length; i += batchSize) {
    const batch = fileNames.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async (fileName) => {
        const filePath = `./world_info/${userId}/${fileName}.txt`;
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          // Limit file size to prevent memory issues
          if (content.length > MAX_PROMPT_FILE_SIZE) {
            logger.log('Files', `File ${filePath} is large (${content.length} chars), truncating`);
            fileContents[fileName] = content.substring(0, MAX_PROMPT_FILE_SIZE) + '\n[Content truncated...]';
          } else {
            fileContents[fileName] = content;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.log('Files', `Error reading file ${filePath}: ${errorMessage}`);
          fileContents[fileName] = '';
        }
      })
    );
  }

  return fileContents;
}

// ============================================
// Moderation Prompt
// ============================================

/**
 * Builds a moderation prompt for content filtering
 *
 * @param message - The message to moderate
 * @param userId - The user ID
 * @returns Request body for moderation
 */
export async function moderatorPrompt(
  message: string,
  userId: string
): Promise<BaseLLMRequestBody> {
  const cacheKey = `${userId}_moderation`;

  // Check cache first
  const cached = moderationPromptCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < MODERATION_CACHE_TTL) {
    return {
      ...cached.prompt,
      messages: [...cached.prompt.messages, { role: 'user', content: message }],
    };
  }

  const userObject = await returnAuthObject(userId);
  if (!userObject) {
    throw new Error(`User not found: ${userId}`);
  }

  const instructTemplate = await withErrorHandling(
    () => getTemplate('./instructs/helpers/moderation.prompt'),
    {
      context: 'Templates',
      defaultValue: '',
      logError: true,
    }
  );

  const socialReplacements = await getSocialMediaReplacements(userId);

  const replacements: Record<string, string> = {
    '{{user}}': userObject.user_name || '',
    '{{char}}': userObject.bot_name || '',
    '{{twitch}}': userObject.twitch_name || '',
    '{{modlist}}': Array.isArray(userObject.mod_list) ? userObject.mod_list.join('\n- ') : '',
    '{{sites}}': Array.isArray(userObject.approved_sites) ? userObject.approved_sites.join('\n- ') : '',
    ...socialReplacements,
  };

  const instructionTemplate = replacePlaceholders(instructTemplate, replacements);
  const promptWithSamplers = await ModerationRequestBody.create(
    instructionTemplate,
    (await retrieveConfigValue<string>('models.moderator.model')) ?? 'gpt-4',
    message
  );

  // Cache management
  if (moderationPromptCache.size >= MAX_MODERATION_CACHE) {
    const firstKey = moderationPromptCache.keys().next().value;
    if (firstKey) {
      moderationPromptCache.delete(firstKey);
    }
  }

  moderationPromptCache.set(cacheKey, {
    prompt: promptWithSamplers,
    timestamp: Date.now(),
  });

  logger.log(
    'LLM',
    `Moderation prompt is using ${await promptTokenizedFromRemote(
      convertMessagesForTokenizer(promptWithSamplers.messages)
    )} of your available ${(await retrieveConfigValue('models.moderator.maxTokens')) ?? 4096} tokens.`
  );

  return promptWithSamplers;
}

// ============================================
// Context Chat Prompt
// ============================================

/**
 * Builds a context-aware chat prompt with all character and world information
 *
 * @param promptData - Context data including chat user and relevant context
 * @param message - The user's message
 * @param userID - The user ID
 * @returns Request body for chat completion
 */
export async function contextPromptChat(
  promptData: ContextPromptData,
  message: string,
  userID: string
): Promise<BaseLLMRequestBody> {
  const currentAuthObject = await returnAuthObject(userID);
  if (!currentAuthObject) {
    throw new Error(`User not found: ${userID}`);
  }

  // Use cache for templates
  const templateCacheKey = 'system_prompt';
  let instructTemplate = getFromTemplateCache(templateCacheKey);

  if (!instructTemplate) {
    instructTemplate = await withErrorHandling(
      () => getTemplate('./instructs/system.prompt'),
      {
        context: 'Templates',
        defaultValue: '',
        logError: true,
      }
    );
    addToTemplateCache(templateCacheKey, instructTemplate);
  }

  const timeStamp = moment().format('dddd, MMMM Do YYYY, [at] hh:mm A');

  // Load all necessary files in parallel for better performance
  const fileContents = await readPromptFiles(userID, [
    'character_personality',
    'world_lore',
    'scenario',
    'character_card',
    'weather',
    'twitch_chat',
    'player_info',
    'voice_messages',
  ]);

  const sentiment = await interpretEmotions(message);
  logger.log('LLM', `Analysis of emotions: ${sentiment}`);
  const user = promptData.chat_user;

  const socialReplacements = await getSocialMediaReplacements(userID);

  const commonReplacements: Record<string, string | number> = {
    '{{user}}': currentAuthObject.user_name || '',
    '{{char}}': currentAuthObject.bot_name || '',
    '{{char_limit}}': (await retrieveConfigValue<number>('twitch.maxCharLimit')) ?? 500,
    '{{chat_user}}': user,
    '{{model_author}}': (await retrieveConfigValue<string>('models.chat.author')) ?? '',
    '{{model_org}}': (await retrieveConfigValue<string>('models.chat.organization')) ?? '',
    ...socialReplacements,
  };

  const systemPrompt = replacePlaceholders(instructTemplate, commonReplacements);

  const structuredPromptData: StructuredPromptData = {
    systemPrompt: systemPrompt,
    characterDescription: fileContents.character_card
      ? `# ${currentAuthObject.bot_name}'s Description:\n${replacePlaceholders(fileContents.character_card, commonReplacements)}`
      : undefined,
    characterPersonality: fileContents.character_personality
      ? `# ${currentAuthObject.bot_name}'s Personality:\n${replacePlaceholders(fileContents.character_personality, commonReplacements)}`
      : undefined,
    worldInfo: fileContents.world_lore
      ? `# World Information:\nUse this information to reflect the world and context around ${currentAuthObject.bot_name}:\n${replacePlaceholders(fileContents.world_lore, commonReplacements)}`
      : undefined,
    scenario: fileContents.scenario
      ? `# Scenario:\n${replacePlaceholders(fileContents.scenario, commonReplacements)}`
      : undefined,
    playerInfo: fileContents.player_info
      ? `# Information about ${currentAuthObject.user_name}:\nThis is pertinent information regarding ${currentAuthObject.user_name} that you should always remember.\n${replacePlaceholders(fileContents.player_info, commonReplacements)}`
      : undefined,
    recentChat: `# Current Messages from Chat:\nUp to the last ${(await retrieveConfigValue('twitch.maxChatsToSave')) ?? 10} messages are provided to you from ${currentAuthObject.user_name}'s Twitch chat. Use these messages to keep up with the current conversation:\n${await returnRecentChats(userID)}`,
    weatherInfo:
      currentAuthObject.weather && fileContents.weather
        ? `# Current Weather:\n${replacePlaceholders(fileContents.weather, commonReplacements)}`
        : undefined,
    additionalContext: {
      contextResults: promptData.relContext
        ? `# Additional Information:\nExternal context relevant to the conversation:\n${promptData.relContext}`
        : undefined,
      chatHistory: promptData.relChats
        ? `# Other Relevant Chat Context:\nBelow are potentially relevant chat messages sent previously, that may be relevant to the conversation:\n${promptData.relChats}`
        : undefined,
      voiceInteractions: promptData.relVoice
        ? `# Previous Voice Interactions:\nNon-exhaustive list of prior vocal interactions you've had with ${currentAuthObject.user_name}:\n${promptData.relVoice}`
        : undefined,
      recentVoice: fileContents.voice_messages
        ? `# Current Voice Conversations with ${currentAuthObject.user_name}:\nUp to the last ${(await retrieveConfigValue('twitch.maxChatsToSave')) ?? 10} voice messages are provided to you. Use these voice messages to help you keep up with the current conversation:\n${fileContents.voice_messages}`
        : undefined,
      emotionalAssessment: sentiment ? `# Current Emotional Assessment of Message:\n- ${sentiment}` : undefined,
      dateTime: `# Current Date and Time:\n- The date and time where you and ${currentAuthObject.user_name} live is currently: ${timeStamp}`,
    },
    userMessage: `${promptData.chat_user} says: "${message}"`,
  };

  const promptWithSamplers = await ChatRequestBody.create(structuredPromptData);

  logger.log(
    'LLM',
    `Chat prompt is using ${await promptTokenizedFromRemote(
      convertMessagesForTokenizer(promptWithSamplers.messages)
    )} of your available ${(await retrieveConfigValue('models.chat.maxTokens')) ?? 4096} tokens.`
  );

  return promptWithSamplers;
}

// ============================================
// Context Chat Prompt (Chain of Thought)
// ============================================

/**
 * Builds a context-aware chat prompt with chain-of-thought formatting
 *
 * @param promptData - Context data including chat user and relevant context
 * @param message - The user's message
 * @param userID - The user ID
 * @returns Request body for chain-of-thought chat completion
 */
export async function contextPromptChatCoT(
  promptData: ContextPromptData,
  message: string,
  userID: string
): Promise<BaseLLMRequestBody> {
  const currentAuthObject = await returnAuthObject(userID);
  if (!currentAuthObject) {
    throw new Error(`User not found: ${userID}`);
  }

  const templateCacheKey = 'system_cot_prompt';
  let instructTemplate = getFromTemplateCache(templateCacheKey);

  if (!instructTemplate) {
    instructTemplate = await withErrorHandling(
      () => getTemplate('./instructs/system_cot.prompt'),
      {
        context: 'Templates',
        defaultValue: '',
        logError: true,
      }
    );
    addToTemplateCache(templateCacheKey, instructTemplate);
  }

  const timeStamp = moment().format('dddd, MMMM Do YYYY, [at] hh:mm A');

  const fileContents = await readPromptFiles(userID, [
    'character_personality',
    'world_lore',
    'scenario',
    'character_card',
    'weather',
    'twitch_chat',
    'player_info',
    'voice_messages',
  ]);

  const sentiment = await interpretEmotions(message);
  logger.log('LLM', `Analysis of emotions: ${sentiment}`);

  const socialReplacements = await getSocialMediaReplacements(userID);

  const commonReplacements: Record<string, string | number> = {
    '{{user}}': currentAuthObject.user_name || '',
    '{{char}}': currentAuthObject.bot_name || '',
    '{{char_limit}}': (await retrieveConfigValue<number>('twitch.maxCharLimit')) ?? 500,
    '{{chat_user}}': promptData.user || promptData.chat_user,
    '{{model_author}}': (await retrieveConfigValue<string>('models.chat.author')) ?? '',
    '{{model_org}}': (await retrieveConfigValue<string>('models.chat.organization')) ?? '',
    ...socialReplacements,
  };

  const systemPrompt = replacePlaceholders(instructTemplate, commonReplacements);

  const structuredPromptData: StructuredPromptData = {
    systemPrompt: systemPrompt,
    characterDescription: fileContents.character_card
      ? `# ${currentAuthObject.bot_name}'s Description:\n${replacePlaceholders(fileContents.character_card, commonReplacements)}`
      : undefined,
    characterPersonality: fileContents.character_personality
      ? `# ${currentAuthObject.bot_name}'s Personality:\n${replacePlaceholders(fileContents.character_personality, commonReplacements)}`
      : undefined,
    worldInfo: fileContents.world_lore
      ? `# World Information:\nUse this information to reflect the world and context around ${currentAuthObject.bot_name}:\n${replacePlaceholders(fileContents.world_lore, commonReplacements)}`
      : undefined,
    scenario: fileContents.scenario
      ? `# Scenario:\n${replacePlaceholders(fileContents.scenario, commonReplacements)}`
      : undefined,
    playerInfo: fileContents.player_info
      ? `# Information about ${currentAuthObject.user_name}:\nThis is pertinent information regarding ${currentAuthObject.user_name} that you should always remember.\n${replacePlaceholders(fileContents.player_info, commonReplacements)}`
      : undefined,
    recentChat: `# Current Messages from Chat:\nUp to the last ${(await retrieveConfigValue('twitch.maxChatsToSave')) ?? 10} messages are provided to you from ${currentAuthObject.user_name}'s Twitch chat. Use these messages to keep up with the current conversation:\n${await returnRecentChats(userID)}`,
    weatherInfo:
      currentAuthObject.weather && fileContents.weather
        ? `# Current Weather:\n${replacePlaceholders(fileContents.weather, commonReplacements)}`
        : undefined,
    additionalContext: {
      contextResults: promptData.relContext
        ? `# Additional Information:\nExternal context relevant to the conversation:\n${promptData.relContext}`
        : undefined,
      chatHistory: promptData.relChats
        ? `# Other Relevant Chat Context:\nBelow are potentially relevant chat messages sent previously, that may be relevant to the conversation:\n${promptData.relChats}`
        : undefined,
      voiceInteractions: promptData.relVoice
        ? `# Previous Voice Interactions:\nNon-exhaustive list of prior vocal interactions you've had with ${currentAuthObject.user_name}:\n${promptData.relVoice}`
        : undefined,
      recentVoice: fileContents.voice_messages
        ? `# Current Voice Conversations with ${currentAuthObject.user_name}:\nUp to the last ${(await retrieveConfigValue('twitch.maxChatsToSave')) ?? 10} voice messages are provided to you. Use these voice messages to help you keep up with the current conversation:\n${fileContents.voice_messages}`
        : undefined,
      emotionalAssessment: sentiment ? `# Current Emotional Assessment of Message:\n- ${sentiment}` : undefined,
      dateTime: `# Current Date and Time:\n- The date and time where you and ${currentAuthObject.user_name} live is currently: ${timeStamp}`,
    },
    userMessage: `${promptData.chat_user} says: "message"`,
    isChainOfThought: true,
  };

  const promptWithSamplers = await ChatRequestBodyCoT.create(structuredPromptData);

  logger.log(
    'LLM',
    `Thoughtful chat prompt is using ${await promptTokenizedFromRemote(
      convertMessagesForTokenizer(promptWithSamplers.messages)
    )} of your available ${(await retrieveConfigValue('models.chat.maxTokens')) ?? 4096} tokens.`
  );

  return promptWithSamplers;
}

// ============================================
// Event Prompt
// ============================================

/**
 * Builds a prompt for Twitch event responses
 *
 * @param message - The event message/description
 * @param userId - The user ID
 * @returns Request body for event response
 */
export async function eventPromptChat(
  message: string,
  userId: string
): Promise<BaseLLMRequestBody> {
  const userObject = await returnAuthObject(userId);
  if (!userObject) {
    throw new Error(`No user found for userId: ${userId}`);
  }
  logger.log('System', `Doing eventing stuff for: ${userObject.user_name} and ${userId}`);

  const templateCacheKey = 'event_system_prompt';
  let instructTemplate = getFromTemplateCache(templateCacheKey);

  if (!instructTemplate) {
    instructTemplate = await withErrorHandling(
      () => getTemplate('./instructs/system.prompt'),
      {
        context: 'Templates',
        defaultValue: '',
        logError: true,
      }
    );
    addToTemplateCache(templateCacheKey, instructTemplate);
  }

  const timeStamp = moment().format('dddd, MMMM Do YYYY, [at] hh:mm A');

  const fileContents = await readPromptFiles(userId, [
    'character_personality',
    'world_lore',
    'scenario',
    'character_card',
    'weather',
    'player_info',
  ]);

  const socialReplacements = await getSocialMediaReplacements(userId);

  const commonReplacements: Record<string, string | number> = {
    '{{user}}': userObject.user_name || '',
    '{{char}}': userObject.bot_name || '',
    '{{char_limit}}': (await retrieveConfigValue<number>('twitch.maxCharLimit')) ?? 400,
    '{{model_author}}': (await retrieveConfigValue<string>('models.chat.author')) ?? '',
    '{{model_org}}': (await retrieveConfigValue<string>('models.chat.organization')) ?? '',
    ...socialReplacements,
  };

  const systemPrompt = replacePlaceholders(instructTemplate, commonReplacements);

  const structuredPromptData: StructuredPromptData = {
    systemPrompt: systemPrompt,
    characterDescription: fileContents.character_card
      ? `# ${userObject.bot_name}'s Description:\n${replacePlaceholders(fileContents.character_card, commonReplacements)}`
      : undefined,
    characterPersonality: fileContents.character_personality
      ? `# ${userObject.bot_name}'s Personality:\n${replacePlaceholders(fileContents.character_personality, commonReplacements)}`
      : undefined,
    worldInfo: fileContents.world_lore
      ? `# World Information:\nUse this information to reflect the world and context around ${userObject.bot_name}:\n${replacePlaceholders(fileContents.world_lore, commonReplacements)}`
      : undefined,
    scenario: fileContents.scenario
      ? `# Scenario:\n${replacePlaceholders(fileContents.scenario, commonReplacements)}`
      : undefined,
    playerInfo: fileContents.player_info
      ? `# Information about ${userObject.user_name}:\nThis is pertinent information regarding ${userObject.user_name} that you should always remember.\n${replacePlaceholders(fileContents.player_info, commonReplacements)}`
      : undefined,
    recentChat: `# Current Messages from Chat:\nUp to the last ${(await retrieveConfigValue('twitch.maxChatsToSave')) ?? 50} messages are provided to you from ${userObject.user_name}'s Twitch chat. Use these messages to keep up with the current conversation:\n${await returnRecentChats(userId)}`,
    weatherInfo:
      userObject.weather && fileContents.weather
        ? `# Current Weather:\n${replacePlaceholders(fileContents.weather, commonReplacements)}`
        : undefined,
    additionalContext: {
      dateTime: `# Current Date and Time:\n- The date and time where you and ${userObject.user_name} live is currently: ${timeStamp}`,
    },
    userMessage: message,
  };

  const promptWithSamplers = await ChatRequestBody.create(structuredPromptData);

  logger.log(
    'LLM',
    `Event handler prompt is using ${await promptTokenizedFromRemote(
      convertMessagesForTokenizer(promptWithSamplers.messages)
    )} of your available ${(await retrieveConfigValue('models.chat.maxTokens')) ?? 8192} tokens.`
  );

  return promptWithSamplers;
}

// ============================================
// Query Prompt
// ============================================

/**
 * Builds a prompt for search query generation
 *
 * @param message - The user's message to generate a query for
 * @param userId - The user ID
 * @returns Request body for query generation
 */
export async function queryPrompt(
  message: string,
  userId: string
): Promise<BaseLLMRequestBody> {
  const userObject = await returnAuthObject(userId);
  if (!userObject) {
    throw new Error(`No user found for userId: ${userId}`);
  }

  const templateCacheKey = 'query_prompt';
  let instructTemplate = getFromTemplateCache(templateCacheKey);

  if (!instructTemplate) {
    instructTemplate = await withErrorHandling(
      () => getTemplate('./instructs/helpers/query.prompt'),
      {
        context: 'Templates',
        defaultValue: '',
        logError: true,
      }
    );
    addToTemplateCache(templateCacheKey, instructTemplate);
  }

  const timeStamp = moment().format('MM/DD/YY [at] HH:mm');
  const [dateString, timeString] = timeStamp.split(' at ');

  const socialReplacements = await getSocialMediaReplacements(userId);

  const replacements: Record<string, string> = {
    '{{datetime}}': `${dateString}. The current time is ${timeString}`,
    '{{query}}': message,
    '{{user}}': userObject.user_name || '',
    '{{char}}': userObject.bot_name || '',
    ...socialReplacements,
  };

  const instructionTemplate = replacePlaceholders(instructTemplate, replacements);
  const promptWithSamplers = await QueryRequestBody.create(
    instructionTemplate,
    (await retrieveConfigValue<string>('models.query.model')) ?? 'gpt-4',
    message + '\n/no_think'
  );

  logger.log(
    'LLM',
    `Search query prompt is using ${await promptTokenizedFromRemote(
      convertMessagesForTokenizer(promptWithSamplers.messages)
    )} of your available ${(await retrieveConfigValue('models.query.maxTokens')) ?? 4096} tokens.`
  );

  return promptWithSamplers;
}

// ============================================
// Rerank Prompt
// ============================================

/**
 * Builds a prompt for content reranking
 *
 * @param message - The content to rerank
 * @param userId - The user ID
 * @returns Request body for reranking
 */
export async function rerankPrompt(
  message: string,
  userId: string
): Promise<BaseLLMRequestBody> {
  logger.log('Rerank', `Received message ${message.substring(0, 100)}...`);
  const userObject = await returnAuthObject(userId);
  if (!userObject) {
    throw new Error(`No user found for userId: ${userId}`);
  }

  const templateCacheKey = 'rerank_prompt';
  let instructTemplate = getFromTemplateCache(templateCacheKey);

  if (!instructTemplate) {
    instructTemplate = await withErrorHandling(
      () => getTemplate('./instructs/helpers/rerank.prompt'),
      {
        context: 'Templates',
        defaultValue: '',
        logError: true,
      }
    );
    addToTemplateCache(templateCacheKey, instructTemplate);
  }

  const socialReplacements = await getSocialMediaReplacements(userId);

  const replacements: Record<string, string> = {
    '{{user}}': userObject.user_name || '',
    ...socialReplacements,
  };

  const instructionTemplate = replacePlaceholders(instructTemplate, replacements);
  const promptWithSamplers = await ToolRequestBody.create(
    instructionTemplate,
    (await retrieveConfigValue<string>('models.rerankTransform.model')) ?? 'gpt-4',
    message
  );

  logger.log(
    'LLM',
    `Reranking prompt is using ${await promptTokenizedFromRemote(
      convertMessagesForTokenizer(promptWithSamplers.messages)
    )} of your available ${(await retrieveConfigValue('models.rerankTransform.maxTokens')) ?? 4096} tokens.`
  );

  return promptWithSamplers;
}

// ============================================
// Summary Prompt
// ============================================

/**
 * Builds a prompt for text summarization
 *
 * @param textContent - The text to summarize
 * @returns Request body for summarization
 */
export async function summaryPrompt(textContent: string): Promise<BaseLLMRequestBody> {
  const templateCacheKey = 'summary_prompt';
  let instructTemplate = getFromTemplateCache(templateCacheKey);

  if (!instructTemplate) {
    instructTemplate = await withErrorHandling(
      () => getTemplate('./instructs/helpers/summary.prompt'),
      {
        context: 'Templates',
        defaultValue: '',
        logError: true,
      }
    );
    addToTemplateCache(templateCacheKey, instructTemplate);
  }

  const promptWithSamplers = await SummaryRequestBody.create(
    instructTemplate,
    (await retrieveConfigValue<string>('models.summary.model')) ?? 'gpt-4',
    textContent
  );

  logger.log(
    'LLM',
    `Summary prompt is using ${await promptTokenizedFromRemote(
      convertMessagesForTokenizer(promptWithSamplers.messages)
    )} of your available ${(await retrieveConfigValue('models.summary.maxTokens')) ?? 4096} tokens.`
  );

  return promptWithSamplers;
}

// ============================================
// Cache Cleanup
// ============================================

/**
 * Clears all prompt helper caches
 */
export function clearPromptHelperCaches(): void {
  clearTemplateCache();
  clearModerationCache();
  logger.log('System', 'All prompt helper caches cleared');
}

/**
 * Runs periodic cache cleanup
 * Should be called on an interval (e.g., every 5 minutes)
 */
export function runCacheCleanup(): void {
  // Clear template cache if it gets too large
  if (templateCache.size > MAX_TEMPLATE_CACHE_SIZE) {
    const excess = templateCache.size - MAX_TEMPLATE_CACHE_SIZE;
    const keysToDelete = Array.from(templateCache.keys()).slice(0, excess);
    keysToDelete.forEach((key) => templateCache.delete(key));
  }

  // Clear old moderation cache entries
  const now = Date.now();
  for (const [key, value] of moderationPromptCache.entries()) {
    if (now - value.timestamp > MODERATION_CACHE_TTL) {
      moderationPromptCache.delete(key);
    }
  }
}

// Set up periodic cleanup (every 5 minutes)
setInterval(runCacheCleanup, 300000);
