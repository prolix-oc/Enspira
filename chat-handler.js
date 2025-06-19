// chat-handler.js - Optimized Version
import { respondToChat, respondToEvent, addChatMessageAsVector } from './ai-logic.js';
import { containsCharacterName, containsAuxBotName, isCommandMatch } from './prompt-helper.js';
import { logger } from './create-global-logger.js';
import { returnAuthObject } from './api-helper.js';
import { sendChatMessage } from './twitch-eventsub-manager.js';

// Response cache to prevent duplicate responses
const responseCache = new Map();
const RESPONSE_CACHE_TTL = 30000; // 30 seconds
const MAX_CACHE_SIZE = 1000;

// Rate limiting for chat responses
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_RESPONSES_PER_MINUTE = 10;

/**
 * Clean up old cache entries and rate limit data
 */
function cleanupCache() {
  const now = Date.now();
  
  // Clean response cache
  for (const [key, data] of responseCache.entries()) {
    if (now > data.expiresAt) {
      responseCache.delete(key);
    }
  }
  
  // Clean rate limit data
  for (const [userId, data] of rateLimitMap.entries()) {
    if (now > data.windowStart + RATE_LIMIT_WINDOW) {
      rateLimitMap.delete(userId);
    }
  }
  
  // Enforce max cache size
  if (responseCache.size > MAX_CACHE_SIZE) {
    const oldestKeys = Array.from(responseCache.keys()).slice(0, 100);
    oldestKeys.forEach(key => responseCache.delete(key));
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupCache, 5 * 60 * 1000);

/**
 * Check if user is within rate limits
 */
function checkRateLimit(userId) {
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
    return false;
  }
  
  userLimit.count++;
  return true;
}

/**
 * Generate cache key for responses
 */
function generateCacheKey(message, user, userId, type = 'chat') {
  return `${type}_${userId}_${user}_${message}`.toLowerCase();
}

/**
 * Check response cache
 */
function getCachedResponse(cacheKey) {
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.response;
  }
  return null;
}

/**
 * Store response in cache
 */
function setCachedResponse(cacheKey, response) {
  responseCache.set(cacheKey, {
    response,
    expiresAt: Date.now() + RESPONSE_CACHE_TTL,
  });
}

/**
 * Central handler for all chat messages from any source (API or EventSub)
 * @param {object} chatData - Normalized chat message data
 * @param {string} userId - The system user ID
 * @param {boolean} autoRespond - Whether to automatically send Twitch chat responses
 * @returns {Promise<object>} - Processing result with response if applicable
 */
export async function handleChatMessage(chatData, userId, autoRespond = false) {
  try {
    const user = await returnAuthObject(userId);
    if (!user) {
      logger.error("Chat", `User ${userId} not found`);
      return { success: false, error: "User not found" };
    }

    const { message, user: chatUser, firstMessage = false } = chatData;
    const formattedDate = new Date().toLocaleString();

    // Pre-processing checks with early returns
    const fromBot = await containsAuxBotName(chatUser, userId);
    if (fromBot) {
      logger.log("Chat", `Ignoring message from bot: ${chatUser}`);
      return { success: true, ignored: true, reason: "bot_user" };
    }

    const isCommand = await isCommandMatch(message, userId);
    if (isCommand) {
      logger.log("Chat", `Ignoring command message: ${message}`);
      return { success: true, ignored: true, reason: "command" };
    }

    // Check rate limits early
    if (!checkRateLimit(userId)) {
      logger.warn("Chat", `Rate limit exceeded for user ${userId}`);
      return { success: true, ignored: true, reason: "rate_limited" };
    }

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
    logger.error("Chat", `Error in chat handler: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Handle character mentions with caching and error recovery
 */
async function handleCharacterMention(chatData, userId, autoRespond, formattedDate) {
  const { message, user: chatUser } = chatData;
  
  // Check cache first
  const cacheKey = generateCacheKey(message, chatUser, userId, 'mention');
  const cachedResponse = getCachedResponse(cacheKey);
  
  if (cachedResponse) {
    logger.log("Chat", `Using cached response for mention from ${chatUser}`);
    
    // Still send to chat if autoRespond is enabled
    if (autoRespond) {
      const chatResponse = await sendChatMessage(cachedResponse.response, userId);
      return { ...cachedResponse, chatResponse };
    }
    
    return cachedResponse;
  }

  logger.log("Chat", `Processing mention from ${chatUser}: ${message}`);

  try {
    // Get AI response with timeout
    const aiResponsePromise = respondToChat({ message, user: chatUser }, userId);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Response timeout')), 30000)
    );

    const aiResponse = await Promise.race([aiResponsePromise, timeoutPromise]);

    if (!aiResponse.success) {
      logger.error("Chat", `Error getting AI response: ${aiResponse.error}`);
      
      // Return fallback response
      const fallbackResponse = "I'm having trouble processing that right now. Could you try again?";
      return await sendResponseAndStore(fallbackResponse, chatData, userId, autoRespond, formattedDate, 'mention_fallback');
    }

    const response = {
      success: true,
      processed: true,
      response: aiResponse.text,
      thoughtProcess: aiResponse.thoughtProcess || null,
    };

    // Cache the successful response
    setCachedResponse(cacheKey, response);

    // Store conversation in vector memory (async)
    const summaryString = `On ${formattedDate}, ${chatUser} said: "${message}". You responded by saying: ${aiResponse.text}`;
    
    addChatMessageAsVector(
      summaryString,
      message,
      chatUser,
      formattedDate,
      aiResponse.text,
      userId
    ).catch(err => logger.error("Chat", `Error storing chat vector: ${err.message}`));

    // Send to Twitch chat if autoRespond is enabled
    if (autoRespond && aiResponse.text) {
      try {
        const chatResponse = await sendChatMessage(aiResponse.text, userId);
        response.chatResponse = chatResponse;
        
        if (!chatResponse.success) {
          logger.error("Chat", `Failed to send chat response: ${chatResponse.error}`);
        }
      } catch (chatError) {
        logger.error("Chat", `Error sending chat message: ${chatError.message}`);
        response.chatResponse = { success: false, error: chatError.message };
      }
    }

    response.summaryString = summaryString;
    return response;

  } catch (error) {
    logger.error("Chat", `Error processing character mention: ${error.message}`);
    
    // Return error response
    const fallbackResponse = "I'm experiencing some technical difficulties. Please try again later.";
    return await sendResponseAndStore(fallbackResponse, chatData, userId, autoRespond, formattedDate, 'mention_error');
  }
}

/**
 * Handle first-time chatters with event processing
 */
async function handleFirstTimeChatter(chatData, userId, autoRespond, formattedDate) {
  const { message, user: chatUser } = chatData;
  
  // Check cache for first-time chatter responses
  const cacheKey = generateCacheKey(message, chatUser, userId, 'first_time');
  const cachedResponse = getCachedResponse(cacheKey);
  
  if (cachedResponse) {
    logger.log("Chat", `Using cached first-time chatter response for ${chatUser}`);
    
    if (autoRespond) {
      const chatResponse = await sendChatMessage(cachedResponse.response, userId);
      return { ...cachedResponse, chatResponse };
    }
    
    return cachedResponse;
  }

  logger.log("Chat", `Processing first-time chatter event from ${chatUser}`);

  try {
    // Create event data for first-time chatter
    const eventData = {
      eventType: 'chat',
      eventData: {
        user: chatUser,
        message: message,
        firstMessage: true
      }
    };

    // Process through event system with timeout
    const eventResponsePromise = respondToEvent(eventData, userId);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Event response timeout')), 25000)
    );

    const eventResponse = await Promise.race([eventResponsePromise, timeoutPromise]);

    if (!eventResponse?.response) {
      logger.error("Chat", `Error getting event response for first-time chatter`);
      
      // Fallback to generic welcome
      const fallbackResponse = `Welcome to the stream, ${chatUser}! Thanks for saying hello!`;
      return await sendResponseAndStore(fallbackResponse, chatData, userId, autoRespond, formattedDate, 'first_time_fallback');
    }

    const response = {
      success: true,
      processed: true,
      firstTimeChatter: true,
      response: eventResponse.response,
      thoughtProcess: eventResponse.thoughtProcess,
    };

    // Cache the response
    setCachedResponse(cacheKey, response);

    // Store in vector memory (async)
    const summaryString = `On ${formattedDate} ${chatUser} sent their first message: "${message}". You responded by saying: ${eventResponse.response}`;
    
    addChatMessageAsVector(
      summaryString,
      message,
      chatUser,
      formattedDate,
      eventResponse.response,
      userId
    ).catch(err => logger.error("Chat", `Error storing first-time chat vector: ${err.message}`));

    // Send to Twitch chat if autoRespond is enabled
    if (autoRespond) {
      try {
        const chatResponse = await sendChatMessage(eventResponse.response, userId);
        response.chatResponse = chatResponse;
        
        if (!chatResponse.success) {
          logger.error("Chat", `Failed to send first-time chatter response: ${chatResponse.error}`);
        }
      } catch (chatError) {
        logger.error("Chat", `Error sending first-time chatter message: ${chatError.message}`);
        response.chatResponse = { success: false, error: chatError.message };
      }
    }

    response.summaryString = summaryString;
    return response;

  } catch (error) {
    logger.error("Chat", `Error processing first-time chatter: ${error.message}`);
    
    // Fallback response
    const fallbackResponse = `Welcome to the stream, ${chatUser}! Great to have you here!`;
    return await sendResponseAndStore(fallbackResponse, chatData, userId, autoRespond, formattedDate, 'first_time_error');
  }
}

/**
 * Handle regular messages (no mention, not first time)
 */
async function handleRegularMessage(chatData, userId, formattedDate) {
  const { message, user: chatUser } = chatData;
  
  try {
    const user = await returnAuthObject(userId);
    
    // Only store if user has this setting enabled
    if (user.store_all_chat) {
      const summaryString = `On ${formattedDate} ${chatUser} said: "${message}"`;
      
      // Store asynchronously without blocking
      addChatMessageAsVector(
        summaryString,
        message,
        chatUser,
        formattedDate,
        "", // No response
        userId
      ).catch(err => logger.error("Chat", `Error storing regular chat: ${err.message}`));
    }

    return {
      success: true,
      processed: false,
      requiresResponse: false,
      summaryString: `On ${formattedDate} ${chatUser} said: "${message}"`,
    };
    
  } catch (error) {
    logger.error("Chat", `Error handling regular message: ${error.message}`);
    return {
      success: true,
      processed: false,
      requiresResponse: false,
      error: error.message,
    };
  }
}

/**
 * Helper function to send response and store data
 */
async function sendResponseAndStore(responseText, chatData, userId, autoRespond, formattedDate, type) {
  const { message, user: chatUser } = chatData;
  
  const response = {
    success: true,
    processed: true,
    response: responseText,
    type: type,
  };

  // Store in vector memory (async)
  const summaryString = `On ${formattedDate}, ${chatUser} said: "${message}". You responded by saying: ${responseText}`;
  
  addChatMessageAsVector(
    summaryString,
    message,
    chatUser,
    formattedDate,
    responseText,
    userId
  ).catch(err => logger.error("Chat", `Error storing ${type} vector: ${err.message}`));

  // Send to chat if autoRespond is enabled
  if (autoRespond) {
    try {
      const chatResponse = await sendChatMessage(responseText, userId);
      response.chatResponse = chatResponse;
    } catch (chatError) {
      logger.error("Chat", `Error sending ${type} message: ${chatError.message}`);
      response.chatResponse = { success: false, error: chatError.message };
    }
  }

  response.summaryString = summaryString;
  return response;
}

/**
 * Normalizes chat messages from various sources into a standard format
 * @param {object} messageData - Raw message from EventSub or API
 * @returns {object} - Standardized chat object
 */
export function normalizeMessageFormat(messageData) {
  // From EventSub webhook
  if (messageData.chatter && messageData.message && messageData.message.text) {
    return {
      user: messageData.chatter.user_name,
      userId: messageData.chatter.user_id,
      message: messageData.message.text,
      firstMessage: messageData.message.is_first || false,
      badges: messageData.chatter.badges?.map(badge => badge.set_id) || [],
      emotes: messageData.message.fragments
        ?.filter(f => f.type === 'emote')
        .map(e => ({ id: e.id, code: e.text })) || [],
      emoteCount: messageData.message.fragments?.filter(f => f.type === 'emote').length || 0,
      color: messageData.chatter.color,
      source: 'eventsub'
    };
  }
  
  // From API or other sources
  return {
    user: messageData.user,
    userId: messageData.userId || null,
    message: messageData.message,
    firstMessage: messageData.firstMessage || false,
    badges: messageData.badges || [],
    emotes: messageData.emotes || [],
    emoteCount: messageData.emoteCount || 0,
    color: messageData.color || null,
    source: messageData.source || 'api'
  };
}

/**
 * Process batch of chat messages efficiently
 * @param {Array} messages - Array of chat messages to process
 * @param {string} userId - User ID
 * @param {boolean} autoRespond - Whether to auto-respond
 * @returns {Promise<Array>} - Array of processing results
 */
export async function handleChatMessageBatch(messages, userId, autoRespond = false) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  // Process messages with concurrency limit
  const batchSize = 3;
  const results = [];

  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    
    const batchPromises = batch.map(async (messageData) => {
      try {
        const normalized = normalizeMessageFormat(messageData);
        return await handleChatMessage(normalized, userId, autoRespond);
      } catch (error) {
        logger.error("Chat", `Error processing batch message: ${error.message}`);
        return { success: false, error: error.message };
      }
    });

    const batchResults = await Promise.allSettled(batchPromises);
    
    // Convert Promise.allSettled results to actual results
    const processedResults = batchResults.map(result => 
      result.status === 'fulfilled' ? result.value : { success: false, error: result.reason.message }
    );
    
    results.push(...processedResults);

    // Small delay between batches to avoid overwhelming the system
    if (i + batchSize < messages.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return results;
}

/**
 * Get chat handler statistics
 */
export function getChatHandlerStats() {
  return {
    responseCache: {
      size: responseCache.size,
      maxSize: MAX_CACHE_SIZE,
    },
    rateLimits: {
      activeUsers: rateLimitMap.size,
      windowMs: RATE_LIMIT_WINDOW,
      maxPerWindow: MAX_RESPONSES_PER_MINUTE,
    },
    cacheTtl: RESPONSE_CACHE_TTL,
  };
}

/**
 * Clear all caches (useful for testing or troubleshooting)
 */
export function clearChatHandlerCache() {
  responseCache.clear();
  rateLimitMap.clear();
  logger.log("Chat", "Chat handler caches cleared");
}