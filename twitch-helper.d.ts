/**
 * Type declarations for twitch-helper.js
 * This stub enables TypeScript imports during the migration.
 */

import type { NormalizedChatMessage } from './src/types/ai.types.js';

export interface TwitchEvent {
  eventType: string;
  eventData?: Record<string, unknown>;
  playerName?: string;
  playerId?: string;
  [key: string]: unknown;
}

export interface CommandEventResult {
  eventType: string;
  eventData: Record<string, unknown>;
}

export interface ChatProcessResult {
  success: boolean;
  ignored?: boolean;
  reason?: string;
  response?: string;
  [key: string]: unknown;
}

export interface SocialMediaObject {
  [platform: string]: string;
}

export interface ModerationResult {
  moderated: boolean;
  reason?: string;
  severity?: number;
}

export interface StrikeInfo {
  count: number;
  lastStrike?: Date;
  reasons?: string[];
}

/**
 * Returns a formatted string for a Twitch event based on its type
 * @param eventThing - The event data
 * @param userId - The ID of the user associated with the event
 * @returns A formatted string describing the event
 */
export function returnTwitchEvent(
  eventThing: TwitchEvent,
  userId: string
): Promise<string>;

/**
 * Processes command-driven events from chat
 * @param command - The command text
 * @param userId - The user ID
 * @returns Event object if command is valid, null otherwise
 */
export function processCommandEvent(
  command: string,
  userId: string
): Promise<CommandEventResult | null>;

/**
 * Processes real-time chat messages from any source
 * @param chatEvent - The chat event data
 * @param userId - The user ID
 * @returns The processing result
 */
export function processChatMessage(
  chatEvent: Record<string, unknown>,
  userId: string
): Promise<ChatProcessResult>;

/**
 * Normalizes message format from various sources
 * @param messageData - Raw message data
 * @returns Normalized message format
 */
export function normalizeMessageFormat(
  messageData: Record<string, unknown>
): NormalizedChatMessage;

/**
 * Checks if a fun fact should be generated for this user
 * @param userId - The user ID
 * @returns Whether to generate a fun fact
 */
export function shouldGenerateFunFact(userId: string): Promise<boolean>;

/**
 * Gets social media information for a user
 * @param userId - The user ID
 * @param platform - Platform name or 'all'
 * @returns Social media value(s)
 */
export function socialMedias(userId: string): Promise<string>;
export function socialMedias(userId: string, platform: 'all'): Promise<Record<string, string>>;
export function socialMedias(userId: string, platform: string): Promise<string>;

/**
 * Normalizes a platform name to standard format
 * @param platform - The platform name
 * @returns Normalized platform name
 */
export function normalizePlatformName(platform: string): string;

/**
 * Formats a social media value for display
 * @param platform - The platform name
 * @param value - The value to format
 * @returns Formatted value
 */
export function formatSocialMediaValue(
  platform: string,
  value: string
): string;

/**
 * Checks if a message is a command
 * @param message - The message to check
 * @param userId - The user ID
 * @returns Whether the message is a command
 */
export function isCommandMatch(
  message: string,
  userId: string
): Promise<boolean>;

/**
 * Prepares a moderation chat request
 * @param message - The message to moderate
 * @param userId - The user ID
 * @returns Moderation request body
 */
export function prepareModerationChatRequest(
  message: string,
  userId: string
): Promise<ModerationResult>;

/**
 * Increments strike count for a user
 * @param username - The username
 * @param userId - The channel user ID
 * @param reason - Reason for strike
 * @returns Updated strike count
 */
export function incrementStrikes(
  username: string,
  userId: string,
  reason?: string
): Promise<number>;

/**
 * Gets strikes for a user by username
 * @param username - The username
 * @param userId - The channel user ID
 * @returns Strike information
 */
export function getStrikesByUserName(
  username: string,
  userId: string
): Promise<StrikeInfo>;

/**
 * Checks if an input matches user's social media
 * @param input - Input string to check
 * @param userId - The user ID
 * @returns Whether a match was found
 */
export function checkForUser(
  input: string,
  userId: string
): Promise<boolean>;

/**
 * Checks if a username belongs to an auxiliary bot
 * @param username - The username to check
 * @param userId - The user ID
 * @returns Whether the user is a bot
 */
export function containsAuxBotName(
  username: string,
  userId: string
): Promise<boolean>;

/**
 * Checks if a user is banned
 * @param username - The username to check
 * @param userId - The channel user ID
 * @returns Whether the user is banned
 */
export function checkBanned(
  username: string,
  userId: string
): Promise<boolean>;

/**
 * Removes a ban from a user
 * @param username - The username to unban
 * @param userId - The channel user ID
 * @returns Whether the unban was successful
 */
export function undoBan(
  username: string,
  userId: string
): Promise<boolean>;
