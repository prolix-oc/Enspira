// chat-handler.js - Memory-Optimized Version
import { respondToChat, respondToEvent, addChatMessageAsVector } from './ai-logic.js';
import { containsCharacterName, containsAuxBotName } from './prompt-helper.js';
import { logger } from './create-global-logger.js';
import { returnAuthObject } from './api-helper.js';
import { sendChatMessage } from './twitch-eventsub-manager.js';

// FIXED: Bounded caches with proper size management and TTL
const MAX_RESPONSE_CACHE_SIZE = 200; // Reduced from 1000 to 200
const MAX_RATE_LIMIT_ENTRIES = 100; // Limit rate limit map size
const RESPONSE_CACHE_TTL = 30000; // 30 seconds
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_RESPONSES_PER_MINUTE = 10;

// FIXED: Use Maps with size management
const responseCache = new Map();
const rateLimitMap = new Map();

// FIXED: Track cache statistics for monitoring
let cacheStats = {
  hits: 0,
  misses: 0,
  evictions: 0,
  rateLimitHits: 0,
  lastCleanup: Date.now(),
};

/**
 * FIXED: Enhanced cleanup with better memory management
 */
function cleanupCache() {
  const now = Date.now();
  let cleanedResponses = 0;
  let cleanedRateLimit = 0;
  
  // Clean response cache
  for (const [key, data] of responseCache.entries()) {
    if (now > data.expiresAt) {
      responseCache.delete(key);
      cleanedResponses++;
    }
  }
  
  // FIXED: Enforce strict size limits on response cache
  if (responseCache.size > MAX_RESPONSE_CACHE_SIZE) {
    // Remove oldest 25% of entries
    const entriesToRemove = Math.floor(MAX_RESPONSE_CACHE_SIZE * 0.25);
    const sortedEntries = Array.from(responseCache.entries())
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    
    for (let i = 0; i < entriesToRemove && i < sortedEntries.length; i++) {
      responseCache.delete(sortedEntries[i][0]);
      cacheStats.evictions++;
    }
  }
  
  // Clean rate limit data
  for (const [userId, data] of rateLimitMap.entries()) {
    if (now > data.windowStart + RATE_LIMIT_WINDOW) {
      rateLimitMap.delete(userId);
      cleanedRateLimit++;
    }
  }
  
  // FIXED: Enforce strict size limits on rate limit map
  if (rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES) {
    // Remove oldest entries
    const entriesToRemove = rateLimitMap.size - MAX_RATE_LIMIT_ENTRIES;
    const sortedEntries = Array.from(rateLimitMap.entries())
      .sort((a, b) => a[1].windowStart - b[1].windowStart);
    
    for (let i = 0; i < entriesToRemove && i < sortedEntries.length; i++) {
      rateLimitMap.delete(sortedEntries[i][0]);
    }
  }
  
  cacheStats.lastCleanup = now;
  
  if (cleanedResponses > 0 || cleanedRateLimit > 0) {
    logger.log("Chat", `Cache cleanup: ${cleanedResponses} responses, ${cleanedRateLimit} rate limits removed`);
  }
}

// FIXED: More frequent cleanup to prevent memory buildup
setInterval(cleanupCache, 60000); // Every 1 minute instead of 5 minutes

/**
 * FIXED: Enhanced rate limiting with better memory management
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
    cacheStats.rateLimitHits++;
    return false;
  }
  
  userLimit.count++;
  return true;
}

/**
 * FIXED: Generate cache key with size limits to prevent massive keys
 */
function generateCacheKey(message, user, userId, type = 'chat') {
  // FIXED: Limit key size to prevent memory issues
  const truncatedMessage = message.substring(0, 100);
  const truncatedUser = user.substring(0, 20);
  return `${type}_${userId}_${truncatedUser}_${truncatedMessage}`.toLowerCase();
}

/**
 * FIXED: Check response cache with better statistics tracking
 */
function getCachedResponse(cacheKey) {
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
 * FIXED: Store response in cache with size validation
 */
function setCachedResponse(cacheKey, response) {
  // FIXED: Don't cache responses that are too large
  const responseSize = JSON.stringify(response).length;
  if (responseSize > 10000) { // 10KB limit per cache entry
    logger.log("Chat", `Response too large to cache (${responseSize} bytes)`);
    return;
  }

  // FIXED: Implement preemptive eviction if cache is getting full
  if (responseCache.size >= MAX_RESPONSE_CACHE_SIZE) {
    const oldestKey = responseCache.keys().next().value;
    responseCache.delete(oldestKey);
    cacheStats.evictions++;
  }

  responseCache.set(cacheKey, {
    response,
    expiresAt: Date.now() + RESPONSE_CACHE_TTL,
    cachedAt: Date.now(),
    size: responseSize,
  });
}

/**
 * FIXED: Check for command match with input validation
 */
async function isCommandMatch(message, userId) {
  // FIXED: Add input validation and size limits
  if (!message || typeof message !== 'string' || message.length > 500) {
    return false;
  }

  try {
    const userObj = await returnAuthObject(userId);
    if (!userObj || !Array.isArray(userObj.command_prefix)) {
      return false;
    }

    const trimmedMessage = message.trim().toLowerCase();
    return userObj.command_prefix.some(prefix => 
      prefix && trimmedMessage.startsWith(prefix.toLowerCase())
    );
  } catch (error) {
    logger.log("Chat", `Error checking command match: ${error.message}`);
    return false;
  }
}

/**
 * Central handler for all chat messages from any source (API or EventSub)
 * FIXED: Enhanced error handling and memory management
 * @param {object} chatData - Normalized chat message data
 * @param {string} userId - The system user ID
 * @param {boolean} autoRespond - Whether to automatically send Twitch chat responses
 * @returns {Promise<object>} - Processing result with response if applicable
 */
export async function handleChatMessage(chatData, userId, autoRespond = false) {
  try {
    // FIXED: Input validation with size limits
    if (!chatData || !chatData.message || !chatData.user || !userId) {
      return { success: false, error: "Invalid input parameters" };
    }

    // FIXED: Limit message size early to prevent memory issues
    if (chatData.message.length > 2000) {
      chatData.message = chatData.message.substring(0, 2000);
      logger.log("Chat", `Message truncated for processing (user: ${chatData.user})`);
    }

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
      logger.log("Chat", `Ignoring command message: ${message.substring(0, 50)}...`);
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
 * FIXED: Handle character mentions with enhanced error recovery and timeout
 */
async function handleCharacterMention(chatData, userId, autoRespond, formattedDate) {
  const { message, user: chatUser } = chatData;
  
  // Check cache first
  const cacheKey = generateCacheKey(message, chatUser, userId, 'mention');
  const cachedResponse = getCachedResponse(cacheKey);
  
  if (cachedResponse) {
    logger.log("Chat", `Using cached response for mention from ${chatUser}`);
    
    // Still send to chat if autoRespond is enabled
    if (autoRespond && cachedResponse.response) {
      try {
        const chatResponse = await Promise.race([
          sendChatMessage(cachedResponse.response, userId),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Chat timeout')), 10000))
        ]);
        return { ...cachedResponse, chatResponse };
      } catch (chatError) {
        logger.error("Chat", `Error sending cached response: ${chatError.message}`);
        return { ...cachedResponse, chatResponse: { success: false, error: chatError.message } };
      }
    }
    
    return cachedResponse;
  }

  logger.log("Chat", `Processing mention from ${chatUser}: ${message.substring(0, 100)}...`);

  try {
    // FIXED: Get AI response with aggressive timeout
    const aiResponsePromise = respondToChat({ message, user: chatUser }, userId);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Response timeout')), 20000) // Reduced from 30s to 20s
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

    // FIXED: Store conversation in vector memory with better error handling
    const summaryString = `On ${formattedDate}, ${chatUser} said: "${message.substring(0, 200)}". You responded by saying: ${aiResponse.text.substring(0, 200)}`;
    
    // Store asynchronously without blocking the response
    addChatMessageAsVector(
      summaryString,
      message,
      chatUser,
      formattedDate,
      aiResponse.text,
      userId
    ).catch(err => {
      logger.error("Chat", `Error storing chat vector: ${err.message}`);
      // Don't fail the main response
    });

    // Send to Twitch chat if autoRespond is enabled
    if (autoRespond && aiResponse.text) {
      try {
        const chatResponsePromise = sendChatMessage(aiResponse.text, userId);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Chat send timeout')), 5000)
        );
        
        const chatResponse = await Promise.race([chatResponsePromise, timeoutPromise]);
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
 * FIXED: Handle first-time chatters with better timeout and error handling
 */
async function handleFirstTimeChatter(chatData, userId, autoRespond, formattedDate) {
  const { message, user: chatUser } = chatData;
  
  // Check cache for first-time chatter responses
  const cacheKey = generateCacheKey(message, chatUser, userId, 'first_time');
  const cachedResponse = getCachedResponse(cacheKey);
  
  if (cachedResponse) {
    logger.log("Chat", `Using cached first-time chatter response for ${chatUser}`);
    
    if (autoRespond && cachedResponse.response) {
      try {
        const chatResponse = await Promise.race([
          sendChatMessage(cachedResponse.response, userId),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Chat timeout')), 5000))
        ]);
        return { ...cachedResponse, chatResponse };
      } catch (chatError) {
        logger.error("Chat", `Error sending cached first-time response: ${chatError.message}`);
        return { ...cachedResponse, chatResponse: { success: false, error: chatError.message } };
      }
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
        message: message.substring(0, 500), // FIXED: Limit event message size
        firstMessage: true
      }
    };

    // FIXED: Process through event system with aggressive timeout
    const eventResponsePromise = respondToEvent(eventData, userId);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Event response timeout')), 15000) // Reduced from 25s to 15s
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

    // FIXED: Store in vector memory with size limits
    const summaryString = `On ${formattedDate} ${chatUser} sent their first message: "${message.substring(0, 200)}". You responded by saying: ${eventResponse.response.substring(0, 200)}`;
    
    addChatMessageAsVector(
      summaryString,
      message,
      chatUser,
      formattedDate,
      eventResponse.response,
      userId
    ).catch(err => {
      logger.error("Chat", `Error storing first-time chat vector: ${err.message}`);
      // Don't fail the main response
    });

    // Send to Twitch chat if autoRespond is enabled
    if (autoRespond) {
      try {
        const chatResponsePromise = sendChatMessage(eventResponse.response, userId);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Chat send timeout')), 5000)
        );
        
        const chatResponse = await Promise.race([chatResponsePromise, timeoutPromise]);
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
 * FIXED: Handle regular messages with better error handling
 */
async function handleRegularMessage(chatData, userId, formattedDate) {
  const { message, user: chatUser } = chatData;
  
  try {
    const user = await returnAuthObject(userId);
    
    // Only store if user has this setting enabled
    if (user.store_all_chat) {
      const summaryString = `On ${formattedDate} ${chatUser} said: "${message.substring(0, 500)}"`;
      
      // FIXED: Store asynchronously without blocking and with size limits
      addChatMessageAsVector(
        summaryString,
        message.substring(0, 1000), // Limit message size
        chatUser,
        formattedDate,
        "", // No response
        userId
      ).catch(err => {
        logger.error("Chat", `Error storing regular chat: ${err.message}`);
        // Don't fail the main response
      });
    }

    return {
      success: true,
      processed: false,
      requiresResponse: false,
      summaryString: `On ${formattedDate} ${chatUser} said: "${message.substring(0, 200)}"`,
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
 * FIXED: Helper function to send response and store data with better error handling
 */
async function sendResponseAndStore(responseText, chatData, userId, autoRespond, formattedDate, type) {
  const { message, user: chatUser } = chatData;
  
  // FIXED: Validate and limit response text
  if (!responseText || typeof responseText !== 'string') {
    responseText = "I'm having trouble right now. Please try again.";
  }
  
  if (responseText.length > 500) {
    responseText = responseText.substring(0, 500) + "...";
  }
  
  const response = {
    success: true,
    processed: true,
    response: responseText,
    type: type,
  };

  // FIXED: Store in vector memory with size limits
  const summaryString = `On ${formattedDate}, ${chatUser} said: "${message.substring(0, 200)}". You responded by saying: ${responseText.substring(0, 200)}`;
  
  addChatMessageAsVector(
    summaryString,
    message,
    chatUser,
    formattedDate,
    responseText,
    userId
  ).catch(err => {
    logger.error("Chat", `Error storing ${type} vector: ${err.message}`);
    // Don't fail the main response
  });

  // Send to chat if autoRespond is enabled
  if (autoRespond) {
    try {
      const chatResponsePromise = sendChatMessage(responseText, userId);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Chat send timeout')), 5000)
      );
      
      const chatResponse = await Promise.race([chatResponsePromise, timeoutPromise]);
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
 * FIXED: Added input validation and size limits
 */
export function normalizeMessageFormat(messageData) {
  // FIXED: Input validation
  if (!messageData || typeof messageData !== 'object') {
    return null;
  }

  // From EventSub webhook
  if (messageData.chatter && messageData.message && messageData.message.text) {
    return {
      user: messageData.chatter.user_name?.substring(0, 50) || 'unknown', // FIXED: Limit username size
      userId: messageData.chatter.user_id,
      message: messageData.message.text.substring(0, 2000), // FIXED: Limit message size
      firstMessage: messageData.message.is_first || false,
      badges: messageData.chatter.badges?.slice(0, 10).map(badge => badge.set_id) || [], // FIXED: Limit badges
      emotes: messageData.message.fragments
        ?.filter(f => f.type === 'emote')
        .slice(0, 20) // FIXED: Limit emotes
        .map(e => ({ id: e.id, code: e.text?.substring(0, 50) })) || [],
      emoteCount: Math.min(messageData.message.fragments?.filter(f => f.type === 'emote').length || 0, 20),
      color: messageData.chatter.color,
      source: 'eventsub'
    };
  }
  
  // From API or other sources
  return {
    user: messageData.user?.substring(0, 50) || 'unknown',
    userId: messageData.userId || null,
    message: messageData.message?.substring(0, 2000) || '',
    firstMessage: messageData.firstMessage || false,
    badges: Array.isArray(messageData.badges) ? messageData.badges.slice(0, 10) : [],
    emotes: Array.isArray(messageData.emotes) ? messageData.emotes.slice(0, 20) : [],
    emoteCount: Math.min(messageData.emoteCount || 0, 20),
    color: messageData.color || null,
    source: messageData.source || 'api'
  };
}

/**
 * FIXED: Process batch of chat messages efficiently with concurrency control
 */
export async function handleChatMessageBatch(messages, userId, autoRespond = false) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  // FIXED: Limit batch size to prevent memory overload
  const maxBatchSize = 10;
  if (messages.length > maxBatchSize) {
    logger.log("Chat", `Batch size limited from ${messages.length} to ${maxBatchSize} messages`);
    messages = messages.slice(0, maxBatchSize);
  }

  // FIXED: Process messages with strict concurrency limit
  const batchSize = 2; // Reduced from 3 to 2 for better memory management
  const results = [];

  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    
    const batchPromises = batch.map(async (messageData, index) => {
      try {
        const normalized = normalizeMessageFormat(messageData);
        if (!normalized) {
          return { success: false, error: "Invalid message format" };
        }
        
        // FIXED: Add timeout for individual message processing
        const processPromise = handleChatMessage(normalized, userId, autoRespond);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Message processing timeout')), 30000)
        );
        
        return await Promise.race([processPromise, timeoutPromise]);
      } catch (error) {
        logger.error("Chat", `Error processing batch message ${i + index}: ${error.message}`);
        return { success: false, error: error.message };
      }
    });

    const batchResults = await Promise.allSettled(batchPromises);
    
    // Convert Promise.allSettled results to actual results
    const processedResults = batchResults.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        logger.error("Chat", `Batch message ${i + index} failed: ${result.reason.message}`);
        return { success: false, error: result.reason.message };
      }
    });
    
    results.push(...processedResults);

    // FIXED: Longer delay between batches to reduce system load
    if (i + batchSize < messages.length) {
      await new Promise(resolve => setTimeout(resolve, 500)); // Increased from 100ms to 500ms
    }
  }

  return results;
}

/**
 * FIXED: Get chat handler statistics with detailed cache information
 */
export function getChatHandlerStats() {
  const now = Date.now();
  
  // Calculate cache efficiency
  const totalCacheOperations = cacheStats.hits + cacheStats.misses;
  const hitRate = totalCacheOperations > 0 ? (cacheStats.hits / totalCacheOperations * 100).toFixed(2) : 0;
  
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
    }
  };
}

/**
 * FIXED: Clear all caches with statistics tracking
 */
export function clearChatHandlerCache() {
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
  
  logger.log("Chat", "Chat handler caches cleared", stats);
  return stats;
}

/**
 * FIXED: Add memory pressure relief function
 */
export function relieveMemoryPressure() {
  const before = getChatHandlerStats();
  
  // Aggressively clean caches
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
  
  logger.log("Chat", `Memory pressure relief: removed ${removedResponses} cache entries, ${removedRateLimit} rate limit entries`);
  
  return { before, after, removedResponses, removedRateLimit };
}

// FIXED: Add automatic memory pressure relief
setInterval(() => {
  const stats = getChatHandlerStats();
  
  // If cache is over 80% full or average entry size is large, relieve pressure
  if (responseCache.size > MAX_RESPONSE_CACHE_SIZE * 0.8 || 
      stats.responseCache.avgEntrySize > 5000) {
    relieveMemoryPressure();
  }
}, 120000); // Every 2 minutes