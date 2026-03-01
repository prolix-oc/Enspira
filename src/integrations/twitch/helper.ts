/**
 * Twitch Helper Functions
 * Handles Twitch event formatting, chat processing, moderation, and social media utilities
 */

import fs from 'fs-extra';
import moment from 'moment';

import { logger } from '../../core/logger.js';
import { retrieveConfigValue } from '../../core/config.js';
import { funFact, returnAuthObject } from '../../core/api-helper.js';
import { sendChatCompletionRequest } from '../../core/llm-client.js';
import { moderatorPrompt } from '../../core/prompt-builder.js';
import { addChatMessageAsVector } from '../../core/rag-context.js';
import { containsCharacterName } from '../../core/message-utils.js';

import type {
  InternalTwitchEvent,
  EventMessageTemplates,
  NormalizedChatMessage,
  ChatProcessResult,
  CommandEventResult,
  ModerationActionResult,
  StrikeInfo,
  BanInfo,
  StrikesData,
  BansData,
  SocialMediaObject,
} from '../../types/twitch.types.js';
import type { User, UserSocials, AuxBot } from '../../types/user.types.js';

// ==================== CACHES ====================

/** Cache for last fun fact time per user */
const lastFunFactTime = new Map<string, number>();

/** Cache for event message templates */
const eventMessagesCache: Record<string, EventMessageTemplates> = {};

// ==================== EVENT MESSAGE HANDLERS ====================

type EventHandler = (event: InternalTwitchEvent) => Promise<string>;

interface EventTypeHandlers {
  [key: string]: EventHandler;
}

/**
 * Returns a formatted string for a Twitch event based on its type
 * @param eventThing - The event data
 * @param userId - The ID of the user associated with the event
 * @returns A formatted string describing the event
 */
export async function returnTwitchEvent(
  eventThing: InternalTwitchEvent,
  userId: string
): Promise<string> {
  const userObj = await returnAuthObject(userId);
  if (!userObj) {
    logger.log('Twitch', `User not found for event: ${userId}`);
    return '';
  }
  const event: InternalTwitchEvent = {
    ...eventThing,
    playerName: userObj.user_name,
    playerId: userObj.user_id,
  };

  const eventTypeHandlers: EventTypeHandlers = {
    sub: subMessage,
    dono: donoMessage,
    chat: chatMessage,
    raid: raidMessage,
    follow: followMessage,
    hype_start: hypeStartMessage,
    hype_update: hypeUpdateMessage,
    hype_end: hypeEndMessage,
    hype_up: hypeLevelUpMessage,
    trivia: triviaMessage,
    ad: adMessage,
    summary: summaryMessage,
    shoutout: shoutoutMessage,
  };

  const handler = eventTypeHandlers[event.eventType];
  if (handler) {
    return await handler(event);
  }
  return '';
}

/**
 * Processes command-driven events from chat
 * @param command - The command text
 * @param userId - The user ID
 * @returns Event object if command is valid, null otherwise
 */
export async function processCommandEvent(
  command: string,
  _userId: string
): Promise<CommandEventResult | null> {
  if (command.startsWith('!summary')) {
    return {
      eventType: 'summary',
      eventData: {},
    };
  } else if (command.startsWith('!trivia')) {
    return {
      eventType: 'trivia',
      eventData: {},
    };
  }

  return null;
}

/**
 * Processes real-time chat messages from any source
 * @param chatEvent - The chat event data
 * @param userId - The user ID
 * @returns The processing result
 */
export async function processChatMessage(
  chatEvent: Record<string, unknown>,
  userId: string
): Promise<ChatProcessResult> {
  try {
    const normalizedChat = normalizeMessageFormat(chatEvent);
    const user = await returnAuthObject(userId);
    if (!user) {
      return { success: false, error: 'User not found' };
    }

    // Skip messages from ignored bots
    const fromBot = await containsAuxBotName(normalizedChat.user, userId);
    if (fromBot) return { success: true, ignored: true, reason: 'bot_user' };

    // Check if message is a command
    const isCommand = await isCommandMatch(normalizedChat.message, userId);
    if (isCommand) return { success: true, ignored: true, reason: 'command' };

    // Check if message mentions the character
    const mentionsChar = await containsCharacterName(normalizedChat.message, userId);

    // Format date for context
    const formattedDate = new Date().toLocaleString();

    // Process first messages or character mentions
    if (normalizedChat.firstMessage || mentionsChar) {
      const summaryString = `On ${formattedDate} ${normalizedChat.user} said in ${user.twitch_name}'s Twitch chat: "${normalizedChat.message}"`;

      // Store asynchronously
      addChatMessageAsVector(
        summaryString,
        normalizedChat.message,
        normalizedChat.user,
        formattedDate,
        '',
        userId
      ).catch((err: Error) =>
        logger.log('Twitch', `Error storing chat vector: ${err.message}`)
      );

      return {
        success: true,
        processed: true,
        mentioned: mentionsChar,
        firstMessage: normalizedChat.firstMessage,
        requiresResponse: mentionsChar || normalizedChat.firstMessage,
        messageData: {
          message: normalizedChat.message,
          user: normalizedChat.user,
        },
      };
    }

    // For other messages, store if configured
    if (user.store_all_chat) {
      const summaryString = `On ${formattedDate} ${normalizedChat.user} said in ${user.twitch_name}'s Twitch chat: "${normalizedChat.message}"`;

      addChatMessageAsVector(
        summaryString,
        normalizedChat.message,
        normalizedChat.user,
        formattedDate,
        '',
        userId
      ).catch((err: Error) =>
        logger.log('Twitch', `Error storing regular chat: ${err.message}`)
      );
    }

    return {
      success: true,
      processed: false,
      requiresResponse: false,
    };
  } catch (error) {
    const err = error as Error;
    logger.log('Twitch', `Error processing chat: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ==================== TIME UTILITIES ====================

/**
 * Calculates the time difference between a given date and the current time
 * @param inputDate - The date string to compare with the current time
 * @returns A string describing the time difference
 */
function getTimeDifferenceFromNow(inputDate: string): string {
  const format = 'MM/DD/YYYY hh:mm:ss A';
  const momentDate = moment.utc(inputDate, format);
  const now = moment.utc();

  const diffInMinutes = momentDate.diff(now, 'minutes');
  const absDiff = Math.abs(diffInMinutes);

  if (diffInMinutes > 0) {
    return `in ${absDiff < 60 ? `${absDiff} minute${absDiff === 1 ? '' : 's'}` : `${Math.round(absDiff / 60)} hour${Math.round(absDiff / 60) === 1 ? '' : 's'}`}`;
  } else {
    return `${absDiff < 60 ? `${absDiff} minute${absDiff === 1 ? '' : 's'}` : `${Math.round(absDiff / 60)} hour${Math.round(absDiff / 60) === 1 ? '' : 's'}`} ago`;
  }
}

// ==================== EVENT MESSAGES ====================

/**
 * Reads event messages from file with caching
 * @param playerId - The player ID
 * @returns Event message templates
 */
async function readEventMessages(playerId: string): Promise<EventMessageTemplates> {
  if (eventMessagesCache[playerId]) {
    return eventMessagesCache[playerId];
  }
  try {
    const filePath = `./world_info/${playerId}/event_messages.txt`;
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(fileContent) as EventMessageTemplates;
    eventMessagesCache[playerId] = parsed;
    return parsed;
  } catch (error) {
    logger.log('Files', `Error reading event messages for player ${playerId}: ${error}`);
    return {};
  }
}

// ==================== CHAT MESSAGE NORMALIZATION ====================

/**
 * Normalizes chat messages from various sources into a standard format
 * @param messageData - Raw message from EventSub or API
 * @returns Standardized chat object
 */
export function normalizeMessageFormat(
  messageData: Record<string, unknown>
): NormalizedChatMessage {
  // From EventSub webhook
  const chatter = messageData.chatter as
    | { user_name: string; user_id: string; badges?: Array<{ set_id: string }> }
    | undefined;
  const message = messageData.message as
    | { text: string; is_first?: boolean; fragments?: Array<{ type: string; id?: string; text: string }> }
    | undefined;

  if (chatter && message?.text) {
    return {
      user: chatter.user_name,
      userId: chatter.user_id,
      message: message.text,
      firstMessage: message.is_first || false,
      badges: chatter.badges?.map((badge) => badge.set_id) || [],
      emotes:
        message.fragments
          ?.filter((f) => f.type === 'emote')
          .map((e) => ({ id: e.id || '', code: e.text })) || [],
      emoteCount: message.fragments?.filter((f) => f.type === 'emote').length || 0,
      color: (messageData.color as string) || null,
      source: 'eventsub',
    };
  }

  // From Enspira API
  return {
    user: messageData.user as string,
    userId: (messageData.userId as string) || null,
    message: messageData.message as string,
    firstMessage: (messageData.firstMessage as boolean) || false,
    badges: (messageData.badges as string[]) || [],
    emotes: (messageData.emotes as Array<{ id: string; code?: string; text?: string }>) || [],
    emoteCount: (messageData.emoteCount as number) || 0,
    color: (messageData.color as string) || null,
    source: 'api',
  };
}

// ==================== EVENT MESSAGE FORMATTERS ====================

const subValues: Record<string, string> = {
  prime: '$4.99',
  'tier 1': '$4.99',
  'tier 2': '$9.99',
  'tier 3': '$24.99',
};

const subValNum: Record<string, number> = {
  prime: 4.99,
  'tier 1': 4.99,
  'tier 2': 9.99,
  'tier 3': 24.99,
};

/**
 * Generates a formatted string for a subscription event
 */
const subMessage: EventHandler = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId || '');
  const eventData = event.eventData as Record<string, unknown>;
  let subString = '';

  switch (eventData.subType) {
    case 'sub':
      subString += `${eventData.user} just gave ${event.playerName} a ${eventData.subTier} sub! They spent ${subValues[eventData.subTier as string]} to give them a subscription. `;
      subString += eventData.multiMonth
        ? `They also decided to subscribe for ${eventData.monthLength} months, and have been subscribed for ${eventData.tenure} months so far! `
        : '';
      subString += eventData.primeUpgrade
        ? `They upgraded from their Twitch Prime subscription right into being a ${eventData.subTier} subscriber, paying ${subValues[eventData.subTier as string]} to do so! `
        : '';
      subString += eventData.paidForward
        ? 'They decided to pay their gifted subscription forward! '
        : '';
      subString += eventData.message
        ? `${eventData.user} said this in the Twitch chat afterward:\n${eventData.message}`
        : '';
      break;
    case 'resub':
      subString += `${eventData.user} just decided to resubscribe to ${event.playerName}'s Twitch channel! They resubscribed with a ${eventData.subTier} sub! `;
      subString += `They spent ${subValues[eventData.subTier as string]} to resubscribe. They're on a ${eventData.streak} month streak and have been a subscriber for ${eventData.tenure} months. `;
      subString += `${eventData.user} said the following in the Twitch chat afterward:\n${eventData.sharedChat}`;
      break;
    case 'gift_sub':
      if (eventData.anonymous) {
        subString += `Some generous person just gave ${eventData.recipientUserName} a ${eventData.subTier} sub to ${event.playerName}'s Twitch channel! `;
        subString += `They spent ${subValues[eventData.subTier as string]} to gift this sub. `;
      } else {
        subString += `${eventData.user} just gave ${eventData.recipientUserName} a ${eventData.subTier} sub to ${event.playerName}'s Twitch channel! They spent ${subValues[eventData.subTier as string]} to gift this sub. `;
      }
      subString += eventData.random
        ? `This sub was randomly given to ${eventData.recipientUserName}. `
        : `This sub was specifically given to ${eventData.recipientUserName}. `;
      subString += `They're on a ${eventData.streak} month streak with their own sub, and have been a subscriber for ${eventData.tenure} months so far. `;
      if (eventData.anonymous) {
        subString += `Though they wished to be anonymous, they said the following in the Twitch chat afterward:\n${eventData.message}`;
      } else {
        subString += `${eventData.user} said the following in the Twitch chat afterward:\n${eventData.message}`;
      }
      break;
    case 'gift_bomb':
      const tierValue = subValNum[eventData.subTier as string] ?? 0;
      if (eventData.anonymous) {
        subString += `Some generous person just gave out ${eventData.giftAmt} ${eventData.subTier} subs to ${event.playerName}'s channel! `;
        subString += eventData.sharedAmt
          ? `They spent $${(tierValue * (eventData.giftAmt as number)).toFixed(2)} on these subs. `
          : `Each sub was worth ${tierValue}. `;
      } else {
        subString += `${eventData.user} just gave out ${eventData.giftAmt} ${eventData.subTier} subs to ${event.playerName}'s channel! `;
        subString += eventData.sharedAmt
          ? `They spent $${(tierValue * (eventData.giftAmt as number)).toFixed(2)} on these subs. `
          : `Each sub was worth ${tierValue}. `;
      }
      subString +=
        (eventData.bonusGifts as number) > 0
          ? `Twitch themselves also decided to add subs towards ${event.playerName}'s channel too! `
          : '';
      subString += eventData.anonymous
        ? `They said this in the chat afterward:\n${eventData.systemMessage}`
        : `${eventData.user} said this in the chat afterward:\n${eventData.systemMessage}`;
      break;
    default:
      break;
  }
  subString += `\n${(parsedAddons.sub || '').replace('{{user}}', event.playerName || '')}`;
  return subString;
};

/**
 * Generates a formatted string for a donation event
 */
const donoMessage: EventHandler = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId || '');
  const eventData = event.eventData as Record<string, unknown>;
  let subString = '';

  switch (eventData.donoType) {
    case 'tip':
      subString += `A donation for ${eventData.donoAmt} just came through from ${eventData.donoFrom}! `;
      break;
    case 'charity':
      subString += `A donation towards our favorite charity ${eventData.forCharity} just came through, in the amount of $${eventData.donoAmt}! `;
      break;
    case 'bits':
      subString += `${eventData.donoFrom} just donated ${eventData.donoAmt} bits to ${event.playerName}'s channel! While each one of these is only worth a cent, they do stack up! `;
      break;
    default:
      break;
  }

  subString +=
    eventData.donoType === 'charity'
      ? `\n${(parsedAddons.charity || '').replace('{{user}}', event.playerName || '')}`
      : `They said this in a message:\n${eventData.donoMessage}\n${(parsedAddons.dono || '').replace('{{user}}', event.playerName || '')}`;

  return subString;
};

/**
 * Generates a formatted string for a raid event
 */
const raidMessage: EventHandler = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId || '');
  const eventData = event.eventData as Record<string, unknown>;

  let subString = `${eventData.username} just raided ${event.playerName}'s Twitch channel! `;
  subString += `${eventData.username} has been streaming for ${eventData.accountAge} as well! `;
  subString += eventData.isFollowing
    ? `They are not currently a follower of ${event.playerName}'s channel. `
    : `They are a follower of ${event.playerName}'s channel! `;
  subString += `They were last seen playing the video game ${eventData.lastGame} to their viewers! `;
  subString += `Their raid brought along ${eventData.viewers} viewers with them, who will now be eagerly watching ${event.playerName} stream and game!\n`;
  subString += (parsedAddons.raid || '').replace('{{user}}', event.playerName || '');

  return subString;
};

/**
 * Generates a formatted string for a follow event
 */
const followMessage: EventHandler = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId || '');
  const eventData = event.eventData as Record<string, unknown>;

  return `${eventData.username} just followed ${event.playerName}'s Twitch channel!\n\n${(parsedAddons.follow || '').replace('{{user}}', event.playerName || '')}`;
};

/**
 * Generates a formatted string for a summary message during a break
 */
const summaryMessage: EventHandler = async (event) => {
  return `${event.playerName} is taking a small break from streaming. While ${event.playerName}'s away from their keyboard, briefly summarize the events in the stream using only the previous chat interactions and any other Twitch events that occured. Do not imagine any other details about the live stream, only use the provided context. Be creative in your summary and put a creative spin on things, but avoid responding with more than 500 characters.`;
};

/**
 * Generates a formatted string for a chat message event
 */
const chatMessage: EventHandler = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId || '');

  let subString = `${event.user} sent the following message in ${event.playerName}'s Twitch chat:\n${event.message}`;
  subString += event.firstMessage
    ? `\nThis is ${event.user}'s *first ever* chat message in ${event.playerName}'s Twitch channel as well!`
    : '';
  subString += `\n${(parsedAddons.firstchat || '').replace('{{user}}', event.playerName || '')}`;

  return subString;
};

/**
 * Generates a formatted string for a hype train start event
 */
const hypeStartMessage: EventHandler = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId || '');
  const eventData = event.eventData as Record<string, unknown>;

  let subString = `A hype train on ${event.playerName}'s channel just started!\n`;
  subString += `It is currently at level ${eventData.level}, started ${getTimeDifferenceFromNow(eventData.startedAt as string)}, and will expire ${getTimeDifferenceFromNow(eventData.expiresAt as string)}.\n`;
  subString += `We are ${(eventData.percent as number) * 100}% of the way to level ${parseInt(String(eventData.level)) + 1}!\n`;
  subString += `${eventData.topSubUser} has the most gifted subscriptions at ${eventData.topSubTotal} subs, and ${eventData.topBitsUser} has donated the most bits with ${eventData.topBitsAmt} bits donated!`;
  subString += '\n' + (parsedAddons.hype || '');

  return subString;
};

/**
 * Generates a formatted string for a hype train update event
 */
const hypeUpdateMessage: EventHandler = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId || '');
  const eventData = event.eventData as Record<string, unknown>;

  let subString = `Here's an update on the Hype Train ${event.playerName}'s channel has started:\n`;
  subString += `It is currently at level ${eventData.level}, started ${getTimeDifferenceFromNow(eventData.startedAt as string)}, and will expire ${getTimeDifferenceFromNow(eventData.expiresAt as string)}.\n`;
  subString += `There are ${eventData.contributors} contributors!\n`;
  subString += eventData.isGolden
    ? `This is now a Golden Kappa train, a rare event rewarding contributors with the Golden Kappa emote for 24 hours!\n`
    : '';
  subString += `We are ${(eventData.percent as number) * 100}% of the way to level ${parseInt(String(eventData.level)) + 1}!\n`;
  subString += `${eventData.topSubUser} has the most gifted subscriptions at ${eventData.topSubTotal} subs, and ${eventData.topBitsUser} has donated the most bits with ${eventData.topBitsAmt} bits donated!`;
  subString += '\n' + (parsedAddons.hype || '');

  return subString;
};

/**
 * Generates a formatted string for a hype train end event
 */
const hypeEndMessage: EventHandler = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId || '');
  const eventData = event.eventData as Record<string, unknown>;

  let subString = `The Hype Train on ${event.playerName}'s channel has just ended!\n`;
  subString += `It ended at level ${eventData.level}, started ${getTimeDifferenceFromNow(eventData.startedAt as string)}, and reached ${(eventData.percent as number) * 100}% towards level ${parseInt(String(eventData.level)) + 1}.\n`;
  subString += `There were ${eventData.contributors} contributors! `;
  subString += eventData.isGolden
    ? `This was a Golden Kappa train, a rare event rewarding contributors with the Golden Kappa emote for 24 hours.\n`
    : '';
  subString += `${eventData.topSubUser} gifted the most subscriptions at ${eventData.topSubTotal} subs, and ${eventData.topBitsUser} donated the most bits with ${eventData.topBitsAmt} bits donated!`;
  subString += '\n' + (parsedAddons.hype || '');

  return subString;
};

/**
 * Generates a formatted string for a hype train level up event
 */
const hypeLevelUpMessage: EventHandler = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId || '');
  const eventData = event.eventData as Record<string, unknown>;

  let subString = `The hype train on ${event.playerName}'s channel has just leveled up!\n`;
  subString += `It is now at level ${eventData.level}, started ${getTimeDifferenceFromNow(eventData.startedAt as string)}, and will expire ${getTimeDifferenceFromNow(eventData.expiresAt as string)}.\n`;
  subString += `There are ${eventData.contributors} contributors!\n`;
  subString += eventData.isGolden
    ? `This is now a Golden Kappa train, a rare event rewarding contributors with the Golden Kappa emote for 24 hours!\n`
    : '';
  subString += `We are ${(eventData.percent as number) * 100}% of the way to level ${parseInt(String(eventData.level)) + 1}!\n`;
  subString += `${eventData.topSubUser} has the most gifted subscriptions at ${eventData.topSubTotal} subs, and ${eventData.topBitsUser} has donated the most bits with ${eventData.topBitsAmt} bits donated!`;
  subString += '\n' + (parsedAddons.hype || '');

  return subString;
};

/**
 * Generates a formatted string for a trivia message event
 */
const triviaMessage: EventHandler = async (event) => {
  return `You're about to receive a fun fact to tell all of the viewers of ${event.playerName}'s channel. Share the entirety of this fact, and your thoughts about it, to all of the viewers. Here is the fun fact:\n${await funFact()}`;
};

/**
 * Generates a formatted string for a shoutout message event
 */
const shoutoutMessage: EventHandler = async (event) => {
  const eventData = event.eventData as Record<string, unknown>;

  let subString = `${event.playerName} wants you to give ${eventData.user} a shoutout in their Twitch channel! Here is some information regarding ${eventData.user} to consider when shouting them out!\n`;
  subString += `${eventData.user} started their streaming career ${getTimeDifferenceFromNow(eventData.accountAge as string)}!\n`;
  subString += `The last time ${eventData.user} was live, they were streaming ${eventData.game} for their viewers! `;
  subString += `${eventData.user} was last active ${getTimeDifferenceFromNow(eventData.lastActive as string)} on their channel! The title of their last stream was '${eventData.streamTitle}'. `;
  subString += eventData.isMod ? `They are also a moderator in ${event.playerName}'s Twitch channel!\n` : '';
  subString += eventData.isAffiliate ? `They are also a Twitch affiliate!\n` : '';
  subString += eventData.isPartner ? `They are also an official Twitch partner!\n` : '';
  subString += eventData.isSubbed ? `They are also currently subscribed to ${event.playerName}'s Twitch channel!\n` : '';
  subString += `Make sure you give ${eventData.user} the type of hype-up you can only get from ${event.playerName}'s Twitch channel!`;

  return subString;
};

/**
 * Generates a formatted string for an ad message event
 */
const adMessage: EventHandler = async (event) => {
  return `Give a heads up to the viewers of ${event.playerName}'s channel that ads will be coming in ${event.minutesLeft} minutes. Playfully hint towards avoiding the ads by subscribing to ${event.playerName}'s channel, and how much it would mean to you.`;
};

// ==================== SOCIAL MEDIA FUNCTIONS ====================

/** Platform name normalization map */
const platformMap: Record<string, string> = {
  tt: 'tiktok',
  tik: 'tiktok',
  tiktok: 'tiktok',
  yt: 'youtube',
  youtube: 'youtube',
  twitter: 'twitter',
  x: 'twitter',
  tweet: 'twitter',
  twitch: 'twitch',
  ig: 'instagram',
  insta: 'instagram',
  instagram: 'instagram',
  discord: 'discord',
  kick: 'kick',
  fb: 'facebook',
  facebook: 'facebook',
  linkedin: 'linkedin',
  github: 'github',
  reddit: 'reddit',
};

/**
 * Retrieves and formats social media information for a user
 * @param userId - The ID of the user
 * @param platform - If provided, returns information for a specific platform
 * @returns A formatted string, specific platform value, or object containing social media information
 */
export async function socialMedias(userId: string): Promise<string>;
export async function socialMedias(userId: string, platform: 'all'): Promise<SocialMediaObject>;
export async function socialMedias(userId: string, platform: string): Promise<string>;
export async function socialMedias(
  userId: string,
  platform: string = ''
): Promise<string | SocialMediaObject> {
  try {
    const currentUser = await returnAuthObject(userId);

    if (!currentUser?.socials) {
      return platform ? '' : '';
    }

    // Return all social media as an object if requested
    if (platform === 'all') {
      return { ...currentUser.socials };
    }

    // Normalize platform name and return specific value if requested
    const normalizedPlatform = normalizePlatformName(platform);
    if (normalizedPlatform && normalizedPlatform in currentUser.socials) {
      return currentUser.socials[normalizedPlatform as keyof UserSocials] || '';
    }

    // Format all available platforms for template use
    const formatted = Object.entries(currentUser.socials)
      .filter(([_, value]) => value?.trim())
      .map(([key, value]) => formatSocialMediaValue(key, value))
      .filter(Boolean)
      .join(', ');

    return formatted ? `(${formatted})` : '';
  } catch (error) {
    const err = error as Error;
    logger.log('System', `Error retrieving social media: ${err.message}`);
    return platform ? '' : '';
  }
}

/**
 * Normalizes platform names to consistent keys
 * @param platform - The platform identifier to normalize
 * @returns The normalized platform key
 */
export function normalizePlatformName(platform: string): string {
  if (!platform) return '';
  return platformMap[platform.toLowerCase()] || platform.toLowerCase();
}

/**
 * Formats a social media value for display
 * @param platform - The platform name
 * @param value - The social media handle or URL
 * @returns Formatted social media value
 */
export function formatSocialMediaValue(platform: string, value: string): string {
  if (!value || value.trim() === '') return '';

  let formattedValue = value.trim();

  // Add @ prefix for handles if not present
  const handlePlatforms = ['twitter', 'tiktok', 'instagram'];
  if (handlePlatforms.includes(platform.toLowerCase()) && !formattedValue.startsWith('@')) {
    formattedValue = `@${formattedValue}`;
  }

  return formattedValue;
}

/**
 * Checks if an input string matches any of a user's social media identifiers
 * @param input - The input string to check
 * @param userId - The ID of the user
 * @returns True if a match is found, false otherwise
 */
export async function checkForUser(input: string, userId: string): Promise<boolean> {
  const socialMediaObj = await socialMedias(userId, 'all');

  if (Object.keys(socialMediaObj).length === 0) {
    logger.log('System', 'socialMediaObj is empty.');
    return false;
  }

  const normalizedInput = input.trim().toLowerCase();
  return Object.values(socialMediaObj).some((value) => {
    const normalizedValue = value.trim().toLowerCase();
    return normalizedValue === normalizedInput;
  });
}

// ==================== COMMAND MATCHING ====================

/**
 * Checks if a message matches any command in the user's command list
 * @param message - The message to check
 * @param userId - The ID of the user
 * @returns True if the message matches a command, false otherwise
 */
export async function isCommandMatch(message: string, userId: string): Promise<boolean> {
  const userObj = await returnAuthObject(userId);
  if (!userObj) return false;
  const commandsList = userObj.commands_list || [];

  if (commandsList.length === 0) return false;

  const commandRegex = new RegExp(`^(${commandsList.join('|')})$`, 'i');
  return commandRegex.test(message);
}

// ==================== MODERATION FUNCTIONS ====================

/**
 * Prepares a moderation chat request
 * @param userName - The name of the user being moderated
 * @param userMessage - The message from the user
 * @param emoteCount - The number of emotes in the message
 * @param userId - The ID of the user associated with the moderation
 * @returns The moderation action to take
 */
export async function prepareModerationChatRequest(
  userName: string,
  userMessage: string,
  emoteCount: number,
  userId: string
): Promise<ModerationActionResult | 'safe' | 'error'> {
  try {
    const strikeInfo = await getStrikesByUserName(userName, userId);
    const banInfo = await checkBanned(userName, userId);
    const userStrikes = strikeInfo.strikes;
    const userObject = await returnAuthObject(userId);
    if (!userObject) {
      logger.log('Moderation', `User not found for moderation: ${userId}`);
      return 'error';
    }

    let userMessageFormatted = `${userName} sent the following message:\n\`${userMessage}\`\nThey have ${userStrikes} strikes currently.\nThey sent ${emoteCount} emotes.`;

    if (userStrikes === 2) {
      userMessageFormatted += userObject.global_strikes
        ? `\n${userName} has ${userStrikes} strikes across all users platforms. This is their last strike. If they commit another offense, apply a ban.`
        : `\nThis is ${userName}'s last strike on ${userObject.user_name}'s channel. If they commit another offense, apply a ban.`;
    } else if (userStrikes >= 3) {
      userMessageFormatted += userObject.global_bans
        ? `\n${userName} has surpassed their max strikes on all user platforms. Apply a ban immediately regardless of their offense.`
        : `\n${userName} has surpassed their max strikes on ${userObject.user_name}'s channel. Apply a ban immediately regardless of their offense.`;
    }

    if (banInfo.banned) {
      userMessageFormatted += `\n${userName} has been banned in ${banInfo.banCount} other communities. Per ${userObject.user_name}'s request, apply a ban immediately regardless of their offense.`;
    }

    const moderationPromptResult = await moderatorPrompt(userMessageFormatted, userId);
    const moderatorModelConfig = await retrieveConfigValue<{ model: string; endpoint: string; apiKey: string }>('models.moderator');

    if (!moderatorModelConfig) {
      logger.log('Moderation', 'Moderator model configuration is missing');
      return 'error';
    }

    const completion = await sendChatCompletionRequest(moderationPromptResult, moderatorModelConfig);
    if (!completion.response) {
      logger.log('Moderation', 'No response from moderator model');
      return 'error';
    }
    const formattedCompletion = JSON.parse(completion.response) as {
      actionNeeded: boolean;
      reason: string;
      actionType: string;
    };

    if (formattedCompletion.actionNeeded === true) {
      const reason = formattedCompletion.reason;
      const action = formattedCompletion.actionType;

      if (action === 'strike') {
        logger.log(
          'Moderation',
          `${userName} earned a strike in ${userObject.twitch_name}'s channel. Reason: ${reason}'`
        );
        const newStrikes = await incrementStrikes(userName, userId);
        return {
          action: 'strike',
          reason,
          user: userName,
          userMsg: userMessage,
          strikeCount: newStrikes.strikes,
        };
      } else if (action === 'ban') {
        logger.log(
          'Moderation',
          `${userName} received a ${action} in ${userObject.twitch_name}'s channel. Reason: '${reason}'`
        );
        await addBanToUser(userName, userObject.twitch_name || '');
        return {
          action: 'ban',
          reason,
          user: userName,
          userMsg: userMessage,
        };
      }
    }

    return 'safe';
  } catch (error) {
    logger.log('Moderation', `Error creating mod chat completion: ${error}`);
    return 'error';
  }
}

/**
 * Retrieves the number of strikes for a given user
 * @param userName - The name of the user
 * @param userId - The ID of the user associated with the strikes
 * @returns An object containing the user name and their number of strikes
 */
export async function getStrikesByUserName(
  userName: string,
  userId: string
): Promise<StrikeInfo> {
  const userObject = await returnAuthObject(userId);
  if (!userObject) {
    return { userName, strikes: 0 };
  }
  try {
    const data = await fs.readFile('./data/global/strikes.json', 'utf8');

    if (!data.trim()) {
      logger.log('Moderation', 'The strike list is currently empty.');
      return { userName, strikes: 0 };
    }

    const strikes = JSON.parse(data) as StrikesData;

    if (userObject.global_strikes && Object.prototype.hasOwnProperty.call(strikes, userName)) {
      const userStrikes = strikes[userName];
      if (userStrikes) {
        const sumOfAllStrikes = Object.values(userStrikes).reduce(
          (sum, count) => sum + count,
          0
        );
        return { userName, strikes: sumOfAllStrikes };
      }
    } else if (Object.prototype.hasOwnProperty.call(strikes, userName)) {
      const userStrikes = strikes[userName];
      return {
        userName,
        strikes: userStrikes?.[userObject.twitch_name || ''] || 0,
      };
    }
    return { userName, strikes: 0 };
  } catch (error) {
    logger.log('Moderation', `Error reading or parsing the JSON file: ${error}`);
    return { userName, strikes: 0 };
  }
}

/**
 * Increments the strike count for a given user
 * @param userName - The name of the user
 * @param userId - The ID of the user associated with the strikes
 * @returns An object containing the user name and their updated number of strikes
 */
export async function incrementStrikes(
  userName: string,
  userId: string
): Promise<StrikeInfo> {
  const userObject = await returnAuthObject(userId);
  if (!userObject) {
    return { userName, strikes: 0 };
  }
  const strikesFilePath = './data/global/strikes.json';

  try {
    await fs.ensureFile(strikesFilePath);
    let strikes: StrikesData = {};

    const data = await fs.readFile(strikesFilePath, 'utf8');
    if (data.trim()) {
      strikes = JSON.parse(data) as StrikesData;
    }

    if (!Object.prototype.hasOwnProperty.call(strikes, userName)) {
      strikes[userName] = {};
    }

    const twitchName = userObject.twitch_name || '';
    const userStrikes = strikes[userName]!;
    userStrikes[twitchName] = (userStrikes[twitchName] || 0) + 1;

    await fs.writeFile(strikesFilePath, JSON.stringify(strikes, null, 2), 'utf8');

    return { userName, strikes: userStrikes[twitchName]! };
  } catch (error) {
    logger.log('Moderation', `Error updating strikes: ${error}`);
    return { userName, strikes: 0 };
  }
}

/**
 * Checks if a user is banned and retrieves their ban information
 * @param userName - The name of the user to check
 * @param userId - The ID of the user associated with the ban list
 * @returns An object containing ban information
 */
export async function checkBanned(userName: string, userId: string): Promise<BanInfo> {
  try {
    const bansData = JSON.parse(
      await fs.readFile('./data/global/bans.json', 'utf-8')
    ) as BansData;
    const userObject = await returnAuthObject(userId);
    if (!userObject) {
      return { banned: false, streamerBans: [], banCount: 0 };
    }

    if (userObject.global_bans && Object.prototype.hasOwnProperty.call(bansData, userName)) {
      const streamerBans = bansData[userName] ?? [];
      return {
        banned: true,
        streamerBans,
        banCount: streamerBans.length,
      };
    } else {
      return {
        banned: false,
        streamerBans: [],
        banCount: 0,
      };
    }
  } catch (error) {
    logger.log('Moderator', `Error reading or processing bans.json: ${error}`);
    return { banned: false, streamerBans: [], banCount: 0 };
  }
}

/**
 * Adds a ban for a user in a specific streamer's context
 * @param userName - The name of the user to ban
 * @param streamerName - The name of the streamer banning the user
 */
async function addBanToUser(userName: string, streamerName: string): Promise<void> {
  try {
    const bansFilePath = './data/global/bans.json';
    await fs.ensureFile(bansFilePath);

    let bansData: BansData = {};
    const data = await fs.readFile(bansFilePath, 'utf8');
    if (data.trim()) {
      bansData = JSON.parse(data) as BansData;
    }

    if (!Object.prototype.hasOwnProperty.call(bansData, userName)) {
      bansData[userName] = [];
    }

    const userBans = bansData[userName]!;
    if (!userBans.includes(streamerName)) {
      userBans.push(streamerName);
      await fs.writeFile(bansFilePath, JSON.stringify(bansData, null, 2), 'utf8');
      logger.log('System', `Banned ${userName} from ${streamerName}'s channel.`);
    } else {
      logger.log('Moderator', `${streamerName} is already in ${userName}'s ban list.`);
    }
  } catch (error) {
    logger.log('Moderator', `Error reading or updating bans.json: ${error}`);
  }
}

/**
 * Checks if it's time to generate a fun fact based on the user's settings
 * @param userId - The user ID
 * @returns True if it's time for a fun fact, false otherwise
 */
export async function shouldGenerateFunFact(userId: string): Promise<boolean> {
  try {
    const user = await returnAuthObject(userId);
    if (!user) {
      return false;
    }

    // If fun facts are disabled, return false
    if (!user.funFacts) {
      return false;
    }

    const now = Date.now();
    const lastTime = lastFunFactTime.get(userId) || 0;
    const interval = (user.funFactsInterval || 30) * 60 * 1000;

    if (now - lastTime >= interval) {
      lastFunFactTime.set(userId, now);
      return true;
    }

    return false;
  } catch (error) {
    const err = error as Error;
    logger.log('Twitch', `Error checking fun fact timing: ${err.message}`);
    return false;
  }
}

/**
 * Removes a ban for a user in a specific streamer's context
 * @param userName - The name of the user to unban
 * @param streamerName - The name of the streamer unbanning the user
 * @returns True if successful
 */
export async function undoBan(userName: string, streamerName: string): Promise<boolean> {
  try {
    const bansFilePath = './data/global/bans.json';
    await fs.ensureFile(bansFilePath);

    let bansData: BansData = {};
    const data = await fs.readFile(bansFilePath, 'utf8');
    if (data.trim()) {
      bansData = JSON.parse(data) as BansData;
    }

    if (!Object.prototype.hasOwnProperty.call(bansData, userName)) {
      logger.log('Moderator', `User ${userName} does not exist in the ban list.`);
      return false;
    }

    const userBans = bansData[userName]!;
    const index = userBans.indexOf(streamerName);

    if (index !== -1) {
      userBans.splice(index, 1);
      if (userBans.length === 0) {
        delete bansData[userName];
      }
      await fs.writeFile(bansFilePath, JSON.stringify(bansData, null, 2), 'utf8');
      logger.log('System', `Removed ${streamerName} from ${userName}'s ban list.`);
      return true;
    } else {
      logger.log('Moderator', `${streamerName} is not in ${userName}'s ban list.`);
      return false;
    }
  } catch (error) {
    logger.log('Moderator', `Error reading or updating bans.json: ${error}`);
    return false;
  }
}

/**
 * Checks if a message contains any of the auxiliary bot names associated with a user
 * @param message - The message to check
 * @param userId - The ID of the user associated with the auxiliary bots
 * @returns True if the message contains any of the auxiliary bot names
 */
export async function containsAuxBotName(message: string, userId: string): Promise<boolean> {
  const userObj = await returnAuthObject(userId);
  if (!userObj) {
    return false;
  }
  const auxBots = userObj.aux_bots || [];

  if (typeof message !== 'string' || !Array.isArray(auxBots)) {
    return false;
  }

  const lowerCaseMessage = message.toLowerCase();
  return auxBots.some((bot: AuxBot) => lowerCaseMessage.includes(bot.name.toLowerCase()));
}
