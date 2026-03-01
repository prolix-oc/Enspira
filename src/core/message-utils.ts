/**
 * Message Utilities module for Enspira
 * Handles message processing, filtering, and TTS string manipulation
 * @module core/message-utils
 */

import { logger } from './logger.js';
import { returnAuthObject } from './api-helper.js';
import type { TTSFixResult, User, AuxBot } from '../types/index.js';

// ============================================
// String Escaping
// ============================================

/**
 * Escapes special regex characters in a string
 *
 * @param string - The string to escape
 * @returns Escaped string safe for use in RegExp
 */
export function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================
// Reply Processing
// ============================================

/** Maximum message length for processing */
const MAX_MESSAGE_LENGTH = 10000;

/**
 * Strips formatting and unwanted characters from a reply
 *
 * @param message - The message to process
 * @param userId - The user ID
 * @returns Cleaned message string
 */
export async function replyStripped(message: string, userId: string): Promise<string> {
  // Limit input size
  let processedMessage = message;
  if (processedMessage.length > MAX_MESSAGE_LENGTH) {
    processedMessage = processedMessage.substring(0, MAX_MESSAGE_LENGTH);
    logger.log('System', 'Message truncated for processing');
  }

  const userObj = await returnAuthObject(userId);
  const botName = userObj?.bot_name || '';
  let formatted = processedMessage
    .replace(/(\r\n|\n|\r)/gm, ' ')
    .replace(new RegExp(`${botName}:\\s?`, 'g'), '')
    .replace(/\(500 characters\)/g, '')
    .replace(/\\/g, '')
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .replace('shoutout', 'shout out');

  formatted = formatted.replace(/^['"]|['"]$/g, '');
  return formatted.trim();
}

// ============================================
// TTS String Processing
// ============================================

/** Maximum TTS string length */
const MAX_TTS_LENGTH = 5000;

/** Acronyms to exclude from processing */
const TTS_EXCEPTIONS = ['GOATs', 'LOL', 'LMAO'];

/**
 * Fixes acronyms and special strings for TTS pronunciation
 *
 * @param inputString - The string to process
 * @returns Object with fixed string and counts
 */
export async function fixTTSString(inputString: string): Promise<TTSFixResult> {
  // Limit input size
  let processedInput = inputString;
  if (processedInput.length > MAX_TTS_LENGTH) {
    processedInput = processedInput.substring(0, MAX_TTS_LENGTH);
  }

  const acronymRegex = /\b([A-Z]{2,})(?!\w)/g;
  const jsRegex = /\.js\b/gi;

  let acronymCount = 0;
  let jsCount = 0;

  let transformedString = processedInput.replace(acronymRegex, (match) => {
    if (TTS_EXCEPTIONS.includes(match)) {
      return match;
    }
    acronymCount++;
    let transformed = match.slice(0, -1).split('').join('.') + '.' + match.slice(-1);
    if (match.endsWith('S') && match.length > 2) {
      const base = match.slice(0, -1).split('').join('.');
      transformed = `${base}'s`;
    }
    return transformed;
  });

  transformedString = transformedString.replace(jsRegex, () => {
    jsCount++;
    return '.J.S';
  });

  return { fixedString: transformedString, acronymCount, jsCount };
}

// ============================================
// Character Name Filtering
// ============================================

/** Maximum filter input length */
const MAX_FILTER_LENGTH = 2000;

/**
 * Filters out character name mentions from a message
 *
 * @param str - The string to filter
 * @param userId - The user ID
 * @returns Filtered string
 */
export async function filterCharacterFromMessage(
  str: string,
  userId: string
): Promise<string> {
  // Limit input size
  let processedStr = str;
  if (processedStr.length > MAX_FILTER_LENGTH) {
    processedStr = processedStr.substring(0, MAX_FILTER_LENGTH);
  }

  const userObject = await returnAuthObject(userId);
  const botTwitch = userObject?.bot_twitch || '';
  const botName = userObject?.bot_name || '';
  const twitchRegex = new RegExp(`@?${botTwitch}`, 'i');
  const nameRegex = new RegExp(
    `,?\\s*\\b(?:${botName}|hey ${botName})\\b,?\\s*`,
    'i'
  );

  let result = processedStr.replace(twitchRegex, '').trim();
  result = result.replace(nameRegex, '').trim();
  return result;
}

// ============================================
// Character Name Detection
// ============================================

/**
 * Checks if a message contains the character's name
 *
 * @param message - The message to check
 * @param userId - The user ID
 * @returns True if character name is found
 */
export async function containsCharacterName(
  message: string,
  userId: string
): Promise<boolean> {
  try {
    const userObj = await returnAuthObject(userId);

    if (!message || typeof message !== 'string' || !userObj) {
      return false;
    }

    const normalizedMessage = message.toLowerCase().trim();
    const namesToCheck = new Set<string>();

    if (userObj.bot_name) {
      namesToCheck.add(userObj.bot_name.toLowerCase());
    }

    if (userObj.bot_twitch) {
      const botTwitch = userObj.bot_twitch.toLowerCase();
      namesToCheck.add(botTwitch);
      const cleanBotTwitch = botTwitch.startsWith('@') ? botTwitch.slice(1) : botTwitch;
      namesToCheck.add(cleanBotTwitch);
      namesToCheck.add('@' + cleanBotTwitch);
    }

    const twitchTokens = userObj.twitch_tokens;
    if (twitchTokens?.bot?.twitch_login) {
      const botLogin = twitchTokens.bot.twitch_login.toLowerCase();
      namesToCheck.add(botLogin);
      namesToCheck.add('@' + botLogin);
    }

    if (twitchTokens?.bot?.twitch_display_name) {
      const botDisplayName = twitchTokens.bot.twitch_display_name.toLowerCase();
      namesToCheck.add(botDisplayName);
      namesToCheck.add('@' + botDisplayName);
    }

    if (twitchTokens?.streamer?.twitch_login) {
      const streamerLogin = twitchTokens.streamer.twitch_login.toLowerCase();
      namesToCheck.add(streamerLogin);
      namesToCheck.add('@' + streamerLogin);
    }

    const validNames = Array.from(namesToCheck).filter((name) => name && name.length > 0);

    if (validNames.length === 0) {
      logger.warn('Twitch', `No valid bot names found for user ${userId} when checking mentions`);
      return false;
    }

    for (const nameToCheck of validNames) {
      const wordBoundaryRegex = new RegExp(`\\b${escapeRegExp(nameToCheck)}\\b`, 'i');
      if (wordBoundaryRegex.test(normalizedMessage)) {
        logger.log('Twitch', `Character name detected: "${nameToCheck}" in message: "${message}"`);
        return true;
      }

      if (nameToCheck.startsWith('@')) {
        const atMentionRegex = new RegExp(`${escapeRegExp(nameToCheck)}`, 'i');
        if (atMentionRegex.test(normalizedMessage)) {
          logger.log('Twitch', `@ mention detected: "${nameToCheck}" in message: "${message}"`);
          return true;
        }
      }
    }

    return false;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Twitch', `Error checking character name in message: ${errorMessage}`);
    return false;
  }
}

/**
 * Checks if a message contains the player's social media handles
 *
 * @param message - The message to check
 * @param userId - The user ID
 * @returns True if player socials are found
 */
export async function containsPlayerSocials(
  message: string,
  userId: string
): Promise<boolean> {
  const userObj = await returnAuthObject(userId);
  if (!userObj?.twitch_name) {
    return false;
  }
  const nameRegex = new RegExp(userObj.twitch_name, 'i');
  return nameRegex.test(message);
}

/**
 * Checks if a message contains an auxiliary bot's name
 *
 * @param message - The message to check
 * @param userId - The user ID
 * @returns True if aux bot name is found
 */
export async function containsAuxBotName(
  message: string,
  userId: string
): Promise<boolean> {
  try {
    const userObj = await returnAuthObject(userId);

    if (!message || typeof message !== 'string' || !userObj || !Array.isArray(userObj.aux_bots)) {
      return false;
    }

    const normalizedMessage = message.toLowerCase();

    for (const auxBot of userObj.aux_bots) {
      // Handle both string and AuxBot object formats
      const botName = typeof auxBot === 'string' ? auxBot : (auxBot as AuxBot)?.name;
      if (!botName || typeof botName !== 'string') continue;

      const normalizedBotName = botName.toLowerCase();
      const wordBoundaryRegex = new RegExp(`\\b${escapeRegExp(normalizedBotName)}\\b`, 'i');
      if (wordBoundaryRegex.test(normalizedMessage)) {
        logger.log('Twitch', `Aux bot name detected: "${botName}" in message, ignoring`);
        return true;
      }

      const atBotName = '@' + normalizedBotName;
      const atMentionRegex = new RegExp(`\\b${escapeRegExp(atBotName)}\\b`, 'i');
      if (atMentionRegex.test(normalizedMessage)) {
        logger.log('Twitch', `Aux bot @ mention detected: "${atBotName}" in message, ignoring`);
        return true;
      }
    }

    return false;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Twitch', `Error checking aux bot names: ${errorMessage}`);
    return false;
  }
}
