/**
 * Chat message routing, caching, and rate limiting
 * Handles messages from Twitch EventSub and API sources
 * @module core/chat-handler
 */

import { respondToChat } from './ai-engine.js';
import { respondToEvent } from './response-generator.js';
import { addChatMessageAsVector } from './rag-context.js';
import { containsCharacterName, containsAuxBotName } from './message-utils.js';
import { logger } from './logger.js';
import { returnAuthObject } from './api-helper.js';
import { sendChatMessage } from '../integrations/twitch/eventsub.js';
import { getEventBus } from './event-bus.js';
import type {
  ChatData,
  ChatEmote,
  NormalizedChatMessage,
  RateLimitEntry,
  ResponseCacheEntry,
  ChatCacheStats,
  TwitchChatResponse,
  ChatHandlerResponse,
  ChatHandlerStats,
  MemoryPressureReliefResult,
  FirstTimeChatterEventData,
  EventSubMessageData,
} from '../types/ai.types.js';

// ============================================
// Constants
// ============================================

/** Maximum entries in the response cache */
const MAX_RESPONSE_CACHE_SIZE = 200;

/** Maximum entries in the rate limit map */
const MAX_RATE_LIMIT_ENTRIES = 100;

/** Response cache TTL in milliseconds */
const RESPONSE_CACHE_TTL = 30_000; // 30 seconds

/** Rate limit window in milliseconds */
const RATE_LIMIT_WINDOW = 60_000; // 1 minute

/** Maximum responses per minute per user */
const MAX_RESPONSES_PER_MINUTE = 10;

/** Maximum message size to process */
const MAX_MESSAGE_SIZE = 2000;

/** Maximum response size to cache (10KB) */
const MAX_CACHE_ENTRY_SIZE = 10_000;

// ============================================
// Cache Structures
// ============================================

/** Response cache with TTL and size tracking */
const responseCache = new Map<string, ResponseCacheEntry>();

/** Rate limit tracking per user */
const rateLimitMap = new Map<string, RateLimitEntry>();

/** Cache statistics for monitoring */
let cacheStats: ChatCacheStats = {
  hits: 0,
  misses: 0,
  evictions: 0,
  rateLimitHits: 0,
  lastCleanup: Date.now(),
};

// ============================================
// Cache Management
// ============================================

/**
 * Cleans up expired cache entries and enforces size limits
 */
function cleanupCache(): void {
  const now = Date.now();
  let cleanedResponses = 0;
  let cleanedRateLimit = 0;

  // Clean expired response cache entries
  for (const [key, data] of responseCache.entries()) {
    if (now > data.expiresAt) {
      responseCache.delete(key);
      cleanedResponses++;
    }
  }

  // Enforce strict size limits on response cache (remove oldest 25%)
  if (responseCache.size > MAX_RESPONSE_CACHE_SIZE) {
    const entriesToRemove = Math.floor(MAX_RESPONSE_CACHE_SIZE * 0.25);
    const sortedEntries = Array.from(responseCache.entries()).sort(
      (a, b) => a[1].expiresAt - b[1].expiresAt
    );

    for (let i = 0; i < entriesToRemove && i < sortedEntries.length; i++) {
      const entry = sortedEntries[i];
      if (entry) {
        responseCache.delete(entry[0]);
        cacheStats.evictions++;
      }
    }
  }

  // Clean expired rate limit entries
  for (const [userId, data] of rateLimitMap.entries()) {
    if (now > data.windowStart + RATE_LIMIT_WINDOW) {
      rateLimitMap.delete(userId);
      cleanedRateLimit++;
    }
  }

  // Enforce strict size limits on rate limit map
  if (rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES) {
    const entriesToRemove = rateLimitMap.size - MAX_RATE_LIMIT_ENTRIES;
    const sortedEntries = Array.from(rateLimitMap.entries()).sort(
      (a, b) => a[1].windowStart - b[1].windowStart
    );

    for (let i = 0; i < entriesToRemove && i < sortedEntries.length; i++) {
      const entry = sortedEntries[i];
      if (entry) {
        rateLimitMap.delete(entry[0]);
      }
    }
  }

  cacheStats.lastCleanup = now;

  if (cleanedResponses > 0 || cleanedRateLimit > 0) {
    logger.log(
      'Chat',
      `Cache cleanup: ${cleanedResponses} responses, ${cleanedRateLimit} rate limits removed`
    );
  }
}

// Run cleanup every minute
const cleanupInterval = setInterval(cleanupCache, 60_000);

// ============================================
// Rate Limiting
// ============================================

/**
 * Checks and updates rate limit for a user
 *
 * @param userId - The user ID to check
 * @returns true if request is allowed, false if rate limited
 */
function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const userLimit = rateLimitMap.get(userId);

  if (!userLimit) {
    rateLimitMap.set(userId, {
      count: 1,
      windowStart: now,
    });
    return true;
  }

  // Reset window if expired
  if (now > userLimit.windowStart + RATE_LIMIT_WINDOW) {
    userLimit.count = 1;
    userLimit.windowStart = now;
    return true;
  }

  // Check if within limits
  if (userLimit.count >= MAX_RESPONSES_PER_MINUTE) {
    cacheStats.rateLimitHits++;
    return false;
  }

  userLimit.count++;
  return true;
}

// ============================================
// Cache Operations
// ============================================

/**
 * Generates a cache key with size limits
 *
 * @param message - The message content
 * @param user - The username
 * @param userId - The user ID
 * @param type - The message type (chat, mention, first_time)
 * @returns The cache key
 */
function generateCacheKey(
  message: string,
  user: string,
  userId: string,
  type: string = 'chat'
): string {
  // Limit key size to prevent memory issues
  const truncatedMessage = message.substring(0, 100);
  const truncatedUser = user.substring(0, 20);
  return `${type}_${userId}_${truncatedUser}_${truncatedMessage}`.toLowerCase();
}

/**
 * Gets a cached response if valid
 *
 * @param cacheKey - The cache key to lookup
 * @returns The cached response or null
 */
function getCachedResponse(cacheKey: string): ChatHandlerResponse | null {
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    cacheStats.hits++;
    return cached.response;
  }

  if (cached) {
    // Remove expired entry immediately
    responseCache.delete(cacheKey);
  }

  cacheStats.misses++;
  return null;
}

/**
 * Stores a response in the cache with size validation
 *
 * @param cacheKey - The cache key
 * @param response - The response to cache
 */
function setCachedResponse(cacheKey: string, response: ChatHandlerResponse): void {
  // Don't cache responses that are too large
  const responseSize = JSON.stringify(response).length;
  if (responseSize > MAX_CACHE_ENTRY_SIZE) {
    logger.log('Chat', `Response too large to cache (${responseSize} bytes)`);
    return;
  }

  // Preemptive eviction if cache is getting full
  if (responseCache.size >= MAX_RESPONSE_CACHE_SIZE) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey) {
      responseCache.delete(oldestKey);
      cacheStats.evictions++;
    }
  }

  responseCache.set(cacheKey, {
    response,
    expiresAt: Date.now() + RESPONSE_CACHE_TTL,
    cachedAt: Date.now(),
    size: responseSize,
  });
}

// ============================================
// Message Validation
// ============================================

/**
 * Checks if a message matches a command prefix
 *
 * @param message - The message to check
 * @param userId - The user ID for command lookup
 * @returns true if the message is a command
 */
async function isCommandMatch(message: string, userId: string): Promise<boolean> {
  // Input validation and size limits
  if (!message || typeof message !== 'string' || message.length > 500) {
    return false;
  }

  try {
    const userObj = await returnAuthObject(userId) as { command_prefix?: string[]; [key: string]: unknown } | null;
    if (!userObj || !Array.isArray(userObj.command_prefix)) {
      return false;
    }

    const trimmedMessage = message.trim().toLowerCase();
    return userObj.command_prefix.some(
      (prefix: string) => prefix && trimmedMessage.startsWith(prefix.toLowerCase())
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.log('Chat', `Error checking command match: ${errorMessage}`);
    return false;
  }
}

// ============================================
// Response Helpers
// ============================================

/**
 * Creates a promise that rejects after a timeout
 *
 * @param ms - Timeout in milliseconds
 * @param message - Error message for timeout
 * @returns Promise that rejects after timeout
 */
function createTimeout<T>(ms: number, message: string): Promise<T> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

/**
 * Sends a response and stores it in vector memory
 *
 * @param responseText - The response text to send
 * @param chatData - The original chat data
 * @param userId - The user ID
 * @param autoRespond - Whether to send to Twitch chat
 * @param formattedDate - Formatted date string
 * @param type - Response type for logging
 * @returns The chat handler response
 */
async function sendResponseAndStore(
  responseText: string,
  chatData: ChatData,
  userId: string,
  autoRespond: boolean,
  formattedDate: string,
  type: string
): Promise<ChatHandlerResponse> {
  const { message, user: chatUser } = chatData;

  // Validate and limit response text
  let validatedResponse = responseText;
  if (!validatedResponse || typeof validatedResponse !== 'string') {
    validatedResponse = "I'm having trouble right now. Please try again.";
  }

  if (validatedResponse.length > 500) {
    validatedResponse = validatedResponse.substring(0, 500) + '...';
  }

  const response: ChatHandlerResponse = {
    success: true,
    processed: true,
    response: validatedResponse,
    type: type,
  };

  // Store in vector memory with size limits
  const summaryString = `On ${formattedDate}, ${chatUser} said: "${message.substring(0, 200)}". You responded by saying: ${validatedResponse.substring(0, 200)}`;

  addChatMessageAsVector(summaryString, message, chatUser, formattedDate, validatedResponse, userId).catch(
    (err: Error) => {
      logger.error('Chat', `Error storing ${type} vector: ${err.message}`);
      // Don't fail the main response
    }
  );

  // Send to chat if autoRespond is enabled
  if (autoRespond) {
    try {
      const chatResponse = (await Promise.race([
        sendChatMessage(validatedResponse, userId),
        createTimeout<TwitchChatResponse>(5000, 'Chat send timeout'),
      ])) as TwitchChatResponse;
      response.chatResponse = chatResponse;
    } catch (chatError) {
      const errorMessage = chatError instanceof Error ? chatError.message : String(chatError);
      logger.error('Chat', `Error sending ${type} message: ${errorMessage}`);
      response.chatResponse = { success: false, error: errorMessage };
    }
  }

  response.summaryString = summaryString;
  return response;
}

// ============================================
// Message Handlers
// ============================================

/**
 * Handles messages that mention the character
 */
async function handleCharacterMention(
  chatData: ChatData,
  userId: string,
  autoRespond: boolean,
  formattedDate: string
): Promise<ChatHandlerResponse> {
  const { message, user: chatUser } = chatData;

  // Check cache first
  const cacheKey = generateCacheKey(message, chatUser, userId, 'mention');
  const cachedResponse = getCachedResponse(cacheKey);

  if (cachedResponse) {
    logger.log('Chat', `Using cached response for mention from ${chatUser}`);

    // Still send to chat if autoRespond is enabled
    if (autoRespond && cachedResponse.response) {
      try {
        const chatResponse = (await Promise.race([
          sendChatMessage(cachedResponse.response, userId),
          createTimeout<TwitchChatResponse>(10000, 'Chat timeout'),
        ])) as TwitchChatResponse;
        return { ...cachedResponse, chatResponse };
      } catch (chatError) {
        const errorMessage = chatError instanceof Error ? chatError.message : String(chatError);
        logger.error('Chat', `Error sending cached response: ${errorMessage}`);
        return { ...cachedResponse, chatResponse: { success: false, error: errorMessage } };
      }
    }

    return cachedResponse;
  }

  logger.log('Chat', `Processing mention from ${chatUser}: ${message.substring(0, 100)}...`);

  try {
    // Get AI response with timeout
    const aiResponse = await Promise.race([
      respondToChat({ message, user: chatUser }, userId),
      createTimeout<{ success: boolean; text?: string; thoughtProcess?: string; error?: string }>(
        20000,
        'Response timeout'
      ),
    ]);

    if (!aiResponse.success) {
      logger.error('Chat', `Error getting AI response: ${aiResponse.error}`);

      // Return fallback response
      const fallbackResponse = "I'm having trouble processing that right now. Could you try again?";
      return await sendResponseAndStore(
        fallbackResponse,
        chatData,
        userId,
        autoRespond,
        formattedDate,
        'mention_fallback'
      );
    }

    const response: ChatHandlerResponse = {
      success: true,
      processed: true,
      response: aiResponse.text,
      thoughtProcess: Array.isArray(aiResponse.thoughtProcess)
        ? aiResponse.thoughtProcess.join('\n')
        : aiResponse.thoughtProcess ?? null,
    };

    // Publish AI response event for extensions
    const eventBus = getEventBus();
    const responseEvent = eventBus.createEvent(
      'ai:response.generated',
      'internal',
      {
        user: chatUser,
        originalMessage: message,
        response: aiResponse.text,
        type: 'mention',
        userId,
      }
    );
    eventBus.publish(responseEvent).catch((err) => {
      logger.error('Chat', `Error publishing response event: ${err}`);
    });

    // Cache the successful response
    setCachedResponse(cacheKey, response);

    // Store conversation in vector memory
    const summaryString = `On ${formattedDate}, ${chatUser} said: "${message.substring(0, 200)}". You responded by saying: ${(aiResponse.text ?? '').substring(0, 200)}`;

    // Store asynchronously without blocking the response
    addChatMessageAsVector(
      summaryString,
      message,
      chatUser,
      formattedDate,
      aiResponse.text ?? '',
      userId
    ).catch((err: Error) => {
      logger.error('Chat', `Error storing chat vector: ${err.message}`);
    });

    // Send to Twitch chat if autoRespond is enabled
    if (autoRespond && aiResponse.text) {
      try {
        const chatResponse = (await Promise.race([
          sendChatMessage(aiResponse.text, userId),
          createTimeout<TwitchChatResponse>(5000, 'Chat send timeout'),
        ])) as TwitchChatResponse;
        response.chatResponse = chatResponse;

        if (!chatResponse.success) {
          logger.error('Chat', `Failed to send chat response: ${chatResponse.error}`);
        }
      } catch (chatError) {
        const errorMessage = chatError instanceof Error ? chatError.message : String(chatError);
        logger.error('Chat', `Error sending chat message: ${errorMessage}`);
        response.chatResponse = { success: false, error: errorMessage };
      }
    }

    response.summaryString = summaryString;
    return response;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Chat', `Error processing character mention: ${errorMessage}`);

    // Return error response
    const fallbackResponse = "I'm experiencing some technical difficulties. Please try again later.";
    return await sendResponseAndStore(
      fallbackResponse,
      chatData,
      userId,
      autoRespond,
      formattedDate,
      'mention_error'
    );
  }
}

/**
 * Handles first-time chatters
 */
async function handleFirstTimeChatter(
  chatData: ChatData,
  userId: string,
  autoRespond: boolean,
  formattedDate: string
): Promise<ChatHandlerResponse> {
  const { message, user: chatUser } = chatData;

  // Check cache for first-time chatter responses
  const cacheKey = generateCacheKey(message, chatUser, userId, 'first_time');
  const cachedResponse = getCachedResponse(cacheKey);

  if (cachedResponse) {
    logger.log('Chat', `Using cached first-time chatter response for ${chatUser}`);

    if (autoRespond && cachedResponse.response) {
      try {
        const chatResponse = (await Promise.race([
          sendChatMessage(cachedResponse.response, userId),
          createTimeout<TwitchChatResponse>(5000, 'Chat timeout'),
        ])) as TwitchChatResponse;
        return { ...cachedResponse, chatResponse };
      } catch (chatError) {
        const errorMessage = chatError instanceof Error ? chatError.message : String(chatError);
        logger.error('Chat', `Error sending cached first-time response: ${errorMessage}`);
        return { ...cachedResponse, chatResponse: { success: false, error: errorMessage } };
      }
    }

    return cachedResponse;
  }

  logger.log('Chat', `Processing first-time chatter event from ${chatUser}`);

  try {
    // Create event data for first-time chatter
    const eventData: FirstTimeChatterEventData = {
      eventType: 'chat',
      eventData: {
        user: chatUser,
        message: message.substring(0, 500), // Limit event message size
        firstMessage: true,
      },
    };

    // Process through event system with timeout
    const eventResponse = await Promise.race([
      respondToEvent(eventData as unknown as { eventType: string; [key: string]: unknown }, userId),
      createTimeout<{ response?: string; thoughtProcess?: string }>(15000, 'Event response timeout'),
    ]);

    if (!eventResponse?.response) {
      logger.error('Chat', `Error getting event response for first-time chatter`);

      // Fallback to generic welcome
      const fallbackResponse = `Welcome to the stream, ${chatUser}! Thanks for saying hello!`;
      return await sendResponseAndStore(
        fallbackResponse,
        chatData,
        userId,
        autoRespond,
        formattedDate,
        'first_time_fallback'
      );
    }

    const response: ChatHandlerResponse = {
      success: true,
      processed: true,
      firstTimeChatter: true,
      response: eventResponse.response,
      thoughtProcess: Array.isArray(eventResponse.thoughtProcess)
        ? eventResponse.thoughtProcess.join('\n')
        : eventResponse.thoughtProcess ?? null,
    };

    // Cache the response
    setCachedResponse(cacheKey, response);

    // Store in vector memory with size limits
    const summaryString = `On ${formattedDate} ${chatUser} sent their first message: "${message.substring(0, 200)}". You responded by saying: ${eventResponse.response.substring(0, 200)}`;

    addChatMessageAsVector(
      summaryString,
      message,
      chatUser,
      formattedDate,
      eventResponse.response,
      userId
    ).catch((err: Error) => {
      logger.error('Chat', `Error storing first-time chat vector: ${err.message}`);
    });

    // Send to Twitch chat if autoRespond is enabled
    if (autoRespond) {
      try {
        const chatResponse = (await Promise.race([
          sendChatMessage(eventResponse.response, userId),
          createTimeout<TwitchChatResponse>(5000, 'Chat send timeout'),
        ])) as TwitchChatResponse;
        response.chatResponse = chatResponse;

        if (!chatResponse.success) {
          logger.error('Chat', `Failed to send first-time chatter response: ${chatResponse.error}`);
        }
      } catch (chatError) {
        const errorMessage = chatError instanceof Error ? chatError.message : String(chatError);
        logger.error('Chat', `Error sending first-time chatter message: ${errorMessage}`);
        response.chatResponse = { success: false, error: errorMessage };
      }
    }

    response.summaryString = summaryString;
    return response;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Chat', `Error processing first-time chatter: ${errorMessage}`);

    // Fallback response
    const fallbackResponse = `Welcome to the stream, ${chatUser}! Great to have you here!`;
    return await sendResponseAndStore(
      fallbackResponse,
      chatData,
      userId,
      autoRespond,
      formattedDate,
      'first_time_error'
    );
  }
}

/**
 * Handles regular messages (store for context if enabled)
 */
async function handleRegularMessage(
  chatData: ChatData,
  userId: string,
  formattedDate: string
): Promise<ChatHandlerResponse> {
  const { message, user: chatUser } = chatData;

  try {
    const user = await returnAuthObject(userId) as { store_all_chat?: boolean; [key: string]: unknown } | null;

    // Only store if user has this setting enabled
    if (user?.store_all_chat) {
      const summaryString = `On ${formattedDate} ${chatUser} said: "${message.substring(0, 500)}"`;

      // Store asynchronously without blocking
      addChatMessageAsVector(
        summaryString,
        message.substring(0, 1000), // Limit message size
        chatUser,
        formattedDate,
        '', // No response
        userId
      ).catch((err: Error) => {
        logger.error('Chat', `Error storing regular chat: ${err.message}`);
      });
    }

    return {
      success: true,
      processed: false,
      requiresResponse: false,
      summaryString: `On ${formattedDate} ${chatUser} said: "${message.substring(0, 200)}"`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Chat', `Error handling regular message: ${errorMessage}`);
    return {
      success: true,
      processed: false,
      requiresResponse: false,
      error: errorMessage,
    };
  }
}

// ============================================
// Main Entry Points
// ============================================

/**
 * Central handler for all chat messages from any source (API or EventSub)
 *
 * @param chatData - Normalized chat message data
 * @param userId - The system user ID
 * @param autoRespond - Whether to automatically send Twitch chat responses
 * @returns Processing result with response if applicable
 */
export async function handleChatMessage(
  chatData: ChatData,
  userId: string,
  autoRespond: boolean = false
): Promise<ChatHandlerResponse> {
  try {
    // Input validation with size limits
    if (!chatData || !chatData.message || !chatData.user || !userId) {
      return { success: false, error: 'Invalid input parameters' };
    }

    // Limit message size early to prevent memory issues
    if (chatData.message.length > MAX_MESSAGE_SIZE) {
      chatData.message = chatData.message.substring(0, MAX_MESSAGE_SIZE);
      logger.log('Chat', `Message truncated for processing (user: ${chatData.user})`);
    }

    const user = await returnAuthObject(userId);
    if (!user) {
      logger.error('Chat', `User ${userId} not found`);
      return { success: false, error: 'User not found' };
    }

    const { message, user: chatUser, firstMessage = false } = chatData;
    const formattedDate = new Date().toLocaleString();

    // Pre-processing checks with early returns
    const fromBot = await containsAuxBotName(chatUser, userId);
    if (fromBot) {
      logger.log('Chat', `Ignoring message from bot: ${chatUser}`);
      return { success: true, ignored: true, reason: 'bot_user' };
    }

    const isCommand = await isCommandMatch(message, userId);
    if (isCommand) {
      logger.log('Chat', `Ignoring command message: ${message.substring(0, 50)}...`);
      return { success: true, ignored: true, reason: 'command' };
    }

    // Check rate limits early
    if (!checkRateLimit(userId)) {
      logger.warn('Chat', `Rate limit exceeded for user ${userId}`);
      return { success: true, ignored: true, reason: 'rate_limited' };
    }

    // Publish chat event to extensions
    const eventBus = getEventBus();
    const chatEvent = eventBus.createEvent(
      'twitch:chat',
      'twitch',
      {
        user: chatUser,
        userId: chatData.userId,
        message,
        firstMessage,
        badges: chatData.badges,
        emotes: chatData.emotes,
        color: chatData.color,
        source: chatData.source || 'api',
      },
      chatData.userId ? { id: chatData.userId, name: chatUser, roles: chatData.badges || [] } : undefined
    );

    // Publish event to extensions (non-blocking)
    eventBus.publish(chatEvent).catch((err) => {
      logger.error('Chat', `Error publishing chat event to extensions: ${err}`);
    });

    // Check for character mentions
    const mentionsChar = await containsCharacterName(message, userId);

    // Handle character mentions
    if (mentionsChar) {
      return await handleCharacterMention(chatData, userId, autoRespond, formattedDate);
    }

    // Handle first-time chatters
    if (firstMessage) {
      return await handleFirstTimeChatter(chatData, userId, autoRespond, formattedDate);
    }

    // Handle regular messages (store for context if enabled)
    return await handleRegularMessage(chatData, userId, formattedDate);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Chat', `Error in chat handler: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

/**
 * Normalizes chat messages from various sources into a standard format
 *
 * @param messageData - Raw message data from EventSub or API
 * @returns Normalized message format or null if invalid
 */
export function normalizeMessageFormat(
  messageData: EventSubMessageData | ChatData | null | undefined
): NormalizedChatMessage | null {
  // Input validation
  if (!messageData || typeof messageData !== 'object') {
    return null;
  }

  // From EventSub webhook
  const eventSubData = messageData as EventSubMessageData;
  if (eventSubData.chatter && eventSubData.message && eventSubData.message.text) {
    return {
      user: eventSubData.chatter.user_name?.substring(0, 50) || 'unknown',
      userId: eventSubData.chatter.user_id,
      message: eventSubData.message.text.substring(0, MAX_MESSAGE_SIZE),
      firstMessage: eventSubData.message.is_first || false,
      badges:
        eventSubData.chatter.badges?.slice(0, 10).map((badge) => badge.set_id) || [],
      emotes:
        eventSubData.message.fragments
          ?.filter((f) => f.type === 'emote')
          .slice(0, 20)
          .map((e) => ({ id: e.id ?? '', code: e.text?.substring(0, 50) ?? '' })) || [],
      emoteCount: Math.min(
        eventSubData.message.fragments?.filter((f) => f.type === 'emote').length || 0,
        20
      ),
      color: eventSubData.chatter.color,
      source: 'eventsub',
    };
  }

  // From API or other sources
  const chatData = messageData as ChatData;
  return {
    user: chatData.user?.substring(0, 50) || 'unknown',
    userId: chatData.userId,
    message: chatData.message?.substring(0, MAX_MESSAGE_SIZE) || '',
    firstMessage: chatData.firstMessage || false,
    badges: Array.isArray(chatData.badges) ? chatData.badges.slice(0, 10) : [],
    emotes: Array.isArray(chatData.emotes) ? chatData.emotes.slice(0, 20) : [],
    emoteCount: Math.min(chatData.emoteCount || 0, 20),
    color: chatData.color,
    source: chatData.source || 'api',
  };
}

/**
 * Processes a batch of chat messages with concurrency control
 *
 * @param messages - Array of raw message data
 * @param userId - The system user ID
 * @param autoRespond - Whether to auto-respond to Twitch chat
 * @returns Array of processing results
 */
export async function handleChatMessageBatch(
  messages: Array<EventSubMessageData | ChatData>,
  userId: string,
  autoRespond: boolean = false
): Promise<ChatHandlerResponse[]> {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  // Limit batch size to prevent memory overload
  const maxBatchSize = 10;
  let processMessages = messages;
  if (messages.length > maxBatchSize) {
    logger.log('Chat', `Batch size limited from ${messages.length} to ${maxBatchSize} messages`);
    processMessages = messages.slice(0, maxBatchSize);
  }

  // Process messages with strict concurrency limit
  const batchSize = 2; // Reduced for better memory management
  const results: ChatHandlerResponse[] = [];

  for (let i = 0; i < processMessages.length; i += batchSize) {
    const batch = processMessages.slice(i, i + batchSize);

    const batchPromises = batch.map(async (messageData, index) => {
      try {
        const normalized = normalizeMessageFormat(messageData);
        if (!normalized) {
          return { success: false, error: 'Invalid message format' };
        }

        // Add timeout for individual message processing
        return await Promise.race([
          handleChatMessage(normalized, userId, autoRespond),
          createTimeout<ChatHandlerResponse>(30000, 'Message processing timeout'),
        ]);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Chat', `Error processing batch message ${i + index}: ${errorMessage}`);
        return { success: false, error: errorMessage };
      }
    });

    const batchResults = await Promise.allSettled(batchPromises);

    // Convert Promise.allSettled results to actual results
    const processedResults = batchResults.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        logger.error('Chat', `Batch message ${i + index} failed: ${reason}`);
        return { success: false, error: reason };
      }
    });

    results.push(...processedResults);

    // Delay between batches to reduce system load
    if (i + batchSize < processMessages.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return results;
}

// ============================================
// Statistics & Management
// ============================================

/**
 * Gets detailed chat handler statistics
 *
 * @returns Statistics object with cache and rate limit info
 */
export function getChatHandlerStats(): ChatHandlerStats {
  const now = Date.now();

  // Calculate cache efficiency
  const totalCacheOperations = cacheStats.hits + cacheStats.misses;
  const hitRate =
    totalCacheOperations > 0
      ? ((cacheStats.hits / totalCacheOperations) * 100).toFixed(2)
      : '0';

  // Calculate average cache entry size
  let totalCacheSize = 0;
  let entriesWithSize = 0;
  for (const entry of responseCache.values()) {
    if (entry.size) {
      totalCacheSize += entry.size;
      entriesWithSize++;
    }
  }
  const avgCacheEntrySize = entriesWithSize > 0 ? Math.round(totalCacheSize / entriesWithSize) : 0;

  return {
    responseCache: {
      size: responseCache.size,
      maxSize: MAX_RESPONSE_CACHE_SIZE,
      totalSize: totalCacheSize,
      avgEntrySize: avgCacheEntrySize,
      hitRate: hitRate + '%',
      hits: cacheStats.hits,
      misses: cacheStats.misses,
      evictions: cacheStats.evictions,
    },
    rateLimits: {
      activeUsers: rateLimitMap.size,
      maxUsers: MAX_RATE_LIMIT_ENTRIES,
      windowMs: RATE_LIMIT_WINDOW,
      maxPerWindow: MAX_RESPONSES_PER_MINUTE,
      rateLimitHits: cacheStats.rateLimitHits,
    },
    cacheTtl: RESPONSE_CACHE_TTL,
    lastCleanup: new Date(cacheStats.lastCleanup).toISOString(),
    memoryEstimate: {
      responseCacheBytes: totalCacheSize,
      rateLimitMapBytes: rateLimitMap.size * 50, // Rough estimate
    },
  };
}

/**
 * Clears all caches and resets statistics
 *
 * @returns The stats before clearing
 */
export function clearChatHandlerCache(): ChatHandlerStats {
  const stats = getChatHandlerStats();

  responseCache.clear();
  rateLimitMap.clear();

  // Reset statistics
  cacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    rateLimitHits: 0,
    lastCleanup: Date.now(),
  };

  logger.log('Chat', 'Chat handler caches cleared');
  return stats;
}

/**
 * Aggressively clears old cache entries to relieve memory pressure
 *
 * @returns Before/after stats and removal counts
 */
export function relieveMemoryPressure(): MemoryPressureReliefResult {
  const before = getChatHandlerStats();
  const now = Date.now();

  // Remove all cache entries older than 15 seconds
  let removedResponses = 0;
  for (const [key, data] of responseCache.entries()) {
    if (now - data.cachedAt > 15000) {
      responseCache.delete(key);
      removedResponses++;
    }
  }

  // Remove rate limit entries older than 30 seconds
  let removedRateLimit = 0;
  for (const [userId, data] of rateLimitMap.entries()) {
    if (now - data.windowStart > 30000) {
      rateLimitMap.delete(userId);
      removedRateLimit++;
    }
  }

  const after = getChatHandlerStats();

  logger.log(
    'Chat',
    `Memory pressure relief: removed ${removedResponses} cache entries, ${removedRateLimit} rate limit entries`
  );

  return { before, after, removedResponses, removedRateLimit };
}

/**
 * Stops the cleanup interval (for graceful shutdown)
 */
export function stopCleanupInterval(): void {
  clearInterval(cleanupInterval);
}

// Automatic memory pressure relief every 2 minutes
const memoryReliefInterval = setInterval(() => {
  const stats = getChatHandlerStats();

  // If cache is over 80% full or average entry size is large, relieve pressure
  if (
    responseCache.size > MAX_RESPONSE_CACHE_SIZE * 0.8 ||
    stats.responseCache.avgEntrySize > 5000
  ) {
    relieveMemoryPressure();
  }
}, 120_000);

/**
 * Stops the memory relief interval (for graceful shutdown)
 */
export function stopMemoryReliefInterval(): void {
  clearInterval(memoryReliefInterval);
}

// ============================================
// Default Export
// ============================================

export default {
  handleChatMessage,
  handleChatMessageBatch,
  normalizeMessageFormat,
  getChatHandlerStats,
  clearChatHandlerCache,
  relieveMemoryPressure,
  stopCleanupInterval,
  stopMemoryReliefInterval,
};
