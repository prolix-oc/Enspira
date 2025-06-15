// ==========================================
// ENHANCED TWITCH-EVENTSUB-MANAGER.JS
// ==========================================

import crypto from "crypto";
import axios from "axios";
import {
  returnAPIKeys,
  returnAuthObject,
  updateUserParameter,
  ensureParameterPath,
} from "./api-helper.js";
import { retrieveConfigValue } from "./config-helper.js";
import { logger } from "./create-global-logger.js";
import cron from "node-cron";

class TwitchAPIManager {
  constructor() {
    // Enhanced rate limit buckets with better tracking
    this.buckets = {
      helix: {
        points: 800,
        remaining: 800,
        resetAt: Date.now() + 60000,
        perMinute: 800,
        violations: 0, // Track rate limit violations
        lastViolation: null
      },
      auth: {
        points: 120,
        remaining: 120,
        resetAt: Date.now() + 60000,
        perMinute: 120,
        violations: 0,
        lastViolation: null
      },
    };

    // Enhanced endpoint tracking with timing metrics
    this.endpointMetrics = new Map();
    
    // Circuit breaker pattern for failing endpoints
    this.circuitBreakers = new Map();

    // Retry configuration with adaptive backoff
    this.defaultRetryConfig = {
      maxRetries: 3,
      initialDelay: 500,
      maxDelay: 30000, // Increased max delay
      factor: 2,
      jitter: true,
      adaptiveBackoff: true
    };

    // Health monitoring
    this.healthMetrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      lastHealthCheck: Date.now()
    };
  }

  /**
   * Enhanced API call with circuit breaker pattern and better monitoring
   */
  async makeRequest(config, bucketType = "helix", retryOptions = {}) {
    const startTime = Date.now();
    const endpoint = this.getEndpointFromUrl(config.url);
    
    // Check circuit breaker
    if (this.isCircuitBreakerOpen(endpoint)) {
      throw new Error(`Circuit breaker open for endpoint: ${endpoint}`);
    }

    // Track request
    this.healthMetrics.totalRequests++;
    this.trackEndpointUsage(endpoint, startTime);

    const retryConfig = { ...this.defaultRetryConfig, ...retryOptions };
    let lastError;
    let delay = retryConfig.initialDelay;

    // Enhanced rate limit check with better prediction
    await this.intelligentRateLimitCheck(bucketType, endpoint);

    for (let attempt = 0; attempt < retryConfig.maxRetries; attempt++) {
      try {
        const response = await axios(config);
        
        // Update metrics on success
        this.healthMetrics.successfulRequests++;
        this.updateResponseTimeMetrics(endpoint, Date.now() - startTime);
        this.updateRateLimits(bucketType, response.headers);
        this.resetCircuitBreaker(endpoint);

        return response;
      } catch (error) {
        lastError = error;
        this.healthMetrics.failedRequests++;

        // Enhanced error classification
        const errorType = this.classifyError(error);
        
        if (errorType.isRateLimited) {
          this.handleRateLimitViolation(bucketType, error);
          delay = this.calculateRateLimitDelay(error, retryConfig);
        } else if (errorType.isRetryable && attempt < retryConfig.maxRetries - 1) {
          delay = this.calculateAdaptiveBackoff(attempt, retryConfig, endpoint);
          
          logger.warn(
            "Twitch",
            `Retryable error on ${endpoint}: ${error.message}. Retry ${attempt + 1}/${retryConfig.maxRetries} in ${delay}ms`
          );
        } else if (errorType.isCircuitBreakerCandidate) {
          this.updateCircuitBreaker(endpoint, false);
          throw error;
        } else {
          // Non-retryable error
          this.updateCircuitBreaker(endpoint, false);
          throw error;
        }

        // Wait before retry with jitter to prevent thundering herd
        if (attempt < retryConfig.maxRetries - 1) {
          await this.delayWithJitter(delay, retryConfig.jitter);
        }
      }
    }

    // Mark circuit breaker if all retries failed
    this.updateCircuitBreaker(endpoint, false);
    throw lastError;
  }

  /**
   * Intelligent rate limit checking with predictive throttling
   */
  async intelligentRateLimitCheck(bucketType, endpoint) {
    const bucket = this.buckets[bucketType];
    const now = Date.now();

    // Reset bucket if time has passed
    if (now > bucket.resetAt) {
      bucket.remaining = bucket.points;
      bucket.resetAt = now + 60000;
      return;
    }

    // Calculate usage velocity to predict rate limit violations
    const timeUntilReset = bucket.resetAt - now;
    const requestVelocity = (bucket.points - bucket.remaining) / (60000 - timeUntilReset);
    const predictedUsage = requestVelocity * timeUntilReset;

    // Aggressive throttling if we're likely to hit limits
    if (bucket.remaining < Math.max(10, bucket.points * 0.1) || predictedUsage > bucket.remaining * 0.8) {
      const throttleDelay = Math.min(timeUntilReset, 5000); // Max 5 second throttle
      
      logger.warn(
        "Twitch",
        `Proactive throttling for ${bucketType}: ${bucket.remaining} requests remaining, delaying ${throttleDelay}ms`
      );

      await new Promise(resolve => setTimeout(resolve, throttleDelay));
      
      // Reset if time passed during throttle
      if (Date.now() > bucket.resetAt) {
        bucket.remaining = bucket.points;
        bucket.resetAt = Date.now() + 60000;
      }
    }

    bucket.remaining = Math.max(0, bucket.remaining - 1);
  }

  /**
   * Enhanced error classification
   */
  classifyError(error) {
    const status = error.response?.status;
    const code = error.code;

    return {
      isRateLimited: status === 429,
      isRetryable: (
        status >= 500 || 
        status === 502 || 
        status === 503 || 
        status === 504 ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        code === "ECONNABORTED" ||
        code === "ENOTFOUND"
      ),
      isCircuitBreakerCandidate: (
        status >= 500 ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT"
      ),
      isClientError: status >= 400 && status < 500 && status !== 429,
      isNetworkError: !status && !!code
    };
  }

  /**
   * Handle rate limit violations with better tracking
   */
  handleRateLimitViolation(bucketType, error) {
    const bucket = this.buckets[bucketType];
    bucket.violations++;
    bucket.lastViolation = Date.now();
    bucket.remaining = 0;

    const retryAfter = parseInt(error.response?.headers?.["retry-after"] || "60");
    bucket.resetAt = Date.now() + (retryAfter * 1000);

    logger.error(
      "Twitch",
      `Rate limit violation #${bucket.violations} for ${bucketType}. Reset in ${retryAfter}s`
    );
  }

  /**
   * Calculate adaptive backoff based on endpoint performance
   */
  calculateAdaptiveBackoff(attempt, config, endpoint) {
    let delay = config.initialDelay * Math.pow(config.factor, attempt);
    
    // Adaptive component based on endpoint health
    const endpointMetrics = this.endpointMetrics.get(endpoint);
    if (endpointMetrics?.averageResponseTime > 5000) {
      delay *= 1.5; // Slower endpoints get longer delays
    }

    return Math.min(config.maxDelay, delay);
  }

  /**
   * Calculate rate limit specific delay
   */
  calculateRateLimitDelay(error, config) {
    const retryAfter = parseInt(error.response?.headers?.["retry-after"] || "60");
    return Math.min(retryAfter * 1000, config.maxDelay);
  }

  /**
   * Delay with optional jitter
   */
  async delayWithJitter(delay, useJitter = true) {
    if (useJitter) {
      delay = delay * (0.5 + Math.random() * 0.5); // 50-100% of original delay
    }
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * Circuit breaker implementation
   */
  isCircuitBreakerOpen(endpoint) {
    const breaker = this.circuitBreakers.get(endpoint);
    if (!breaker) return false;

    if (breaker.state === "open") {
      const now = Date.now();
      if (now > breaker.nextAttempt) {
        breaker.state = "half-open";
        logger.log("Twitch", `Circuit breaker for ${endpoint} moving to half-open`);
        return false;
      }
      return true;
    }

    return false;
  }

  updateCircuitBreaker(endpoint, success) {
    let breaker = this.circuitBreakers.get(endpoint) || {
      failureCount: 0,
      successCount: 0,
      lastFailure: null,
      state: "closed",
      nextAttempt: null
    };

    if (success) {
      breaker.successCount++;
      breaker.failureCount = Math.max(0, breaker.failureCount - 1);
      
      if (breaker.state === "half-open" && breaker.successCount >= 3) {
        breaker.state = "closed";
        logger.log("Twitch", `Circuit breaker for ${endpoint} closed (recovered)`);
      }
    } else {
      breaker.failureCount++;
      breaker.successCount = 0;
      breaker.lastFailure = Date.now();

      // Open circuit after 5 consecutive failures
      if (breaker.failureCount >= 5 && breaker.state === "closed") {
        breaker.state = "open";
        breaker.nextAttempt = Date.now() + 30000; // 30 second timeout
        logger.error("Twitch", `Circuit breaker for ${endpoint} opened due to failures`);
      }
    }

    this.circuitBreakers.set(endpoint, breaker);
  }

  resetCircuitBreaker(endpoint) {
    this.updateCircuitBreaker(endpoint, true);
  }

  /**
   * Enhanced endpoint metrics tracking
   */
  trackEndpointUsage(endpoint, startTime) {
    let metrics = this.endpointMetrics.get(endpoint) || {
      count: 0,
      totalResponseTime: 0,
      averageResponseTime: 0,
      lastUsed: Date.now(),
      errors: 0
    };

    metrics.count++;
    metrics.lastUsed = Date.now();
    this.endpointMetrics.set(endpoint, metrics);
  }

  updateResponseTimeMetrics(endpoint, responseTime) {
    let metrics = this.endpointMetrics.get(endpoint);
    if (metrics) {
      metrics.totalResponseTime += responseTime;
      metrics.averageResponseTime = metrics.totalResponseTime / metrics.count;
    }
  }

  /**
   * Get comprehensive API health status
   */
  getHealthStatus() {
    const now = Date.now();
    const successRate = this.healthMetrics.totalRequests > 0 
      ? (this.healthMetrics.successfulRequests / this.healthMetrics.totalRequests) * 100 
      : 100;

    return {
      timestamp: now,
      totalRequests: this.healthMetrics.totalRequests,
      successRate: successRate.toFixed(2) + "%",
      rateLimitViolations: {
        helix: this.buckets.helix.violations,
        auth: this.buckets.auth.violations
      },
      circuitBreakers: Array.from(this.circuitBreakers.entries()).map(([endpoint, breaker]) => ({
        endpoint,
        state: breaker.state,
        failureCount: breaker.failureCount
      })),
      endpointMetrics: Array.from(this.endpointMetrics.entries()).map(([endpoint, metrics]) => ({
        endpoint,
        averageResponseTime: Math.round(metrics.averageResponseTime),
        requestCount: metrics.count,
        lastUsed: new Date(metrics.lastUsed).toISOString()
      }))
    };
  }
}

// ==========================================
// ENHANCED CHAT HANDLER
// ==========================================

/**
 * Enhanced central handler for chat messages with better error handling and monitoring
 */
export async function handleChatMessage(chatData, userId, autoRespond = false) {
  const startTime = Date.now();
  
  try {
    const user = await returnAuthObject(userId);
    if (!user) {
      logger.error("Chat", `User ${userId} not found`);
      return { success: false, error: "User not found" };
    }

    const { message, user: chatUser, firstMessage = false } = chatData;
    
    // Enhanced logging with timing
    logger.log("Chat", `Processing message from ${chatUser}: "${message.substring(0, 50)}..." (firstMessage: ${firstMessage})`);
    
    // Rate limiting check for chat processing
    if (await isUserRateLimited(userId, chatUser)) {
      logger.warn("Chat", `Rate limited message from ${chatUser} for user ${userId}`);
      return { success: true, ignored: true, reason: "rate_limited" };
    }

    // Enhanced bot detection
    const fromBot = await containsAuxBotName(chatUser, userId);
    if (fromBot) {
      logger.log("Chat", `Ignoring message from bot: ${chatUser}`);
      return { success: true, ignored: true, reason: "bot_user" };
    }
    
    // Enhanced command detection
    const isCommand = await isCommandMatch(message, userId);
    if (isCommand) {
      logger.log("Chat", `Ignoring command message: ${message.substring(0, 30)}...`);
      return { success: true, ignored: true, reason: "command" };
    }
    
    // Check for character mention with timeout
    const mentionCheckPromise = containsCharacterName(message, userId);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Mention check timeout")), 5000)
    );
    
    let mentionsChar;
    try {
      mentionsChar = await Promise.race([mentionCheckPromise, timeoutPromise]);
    } catch (error) {
      logger.error("Chat", `Mention check failed: ${error.message}`);
      mentionsChar = false; // Default to no mention if check fails
    }
    
    logger.log("Chat", `Character mention check result: ${mentionsChar ? 'YES' : 'NO'} (${Date.now() - startTime}ms)`);
    
    // Format date for context
    const formattedDate = new Date().toLocaleString();
    
    if (mentionsChar) {
      return await handleMentionedMessage(message, chatUser, userId, formattedDate, autoRespond, user);
    } else if (firstMessage) {
      return await handleFirstTimeChatter(message, chatUser, userId, formattedDate, autoRespond, user);
    } else {
      return await handleRegularMessage(message, chatUser, userId, formattedDate, user);
    }
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error("Chat", `Error in chat handler (${processingTime}ms): ${error.message}`);
    
    // Return a structured error response
    return { 
      success: false, 
      error: error.message,
      processingTime,
      context: {
        userId,
        message: chatData.message?.substring(0, 50) + "...",
        user: chatData.user
      }
    };
  }
}

/**
 * Enhanced message handlers with better error recovery
 */
async function handleMentionedMessage(message, chatUser, userId, formattedDate, autoRespond, user) {
  try {
    logger.log("Chat", `Processing mention from ${chatUser}`);
    
    const messageData = { message, user: chatUser };
    
    // Set timeout for AI response generation
    const responsePromise = respondToChat(messageData, userId);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("AI response timeout")), 30000)
    );
    
    const aiResponse = await Promise.race([responsePromise, timeoutPromise]);
    
    if (!aiResponse.success) {
      logger.error("Chat", `Error getting AI response: ${aiResponse.error}`);
      return { 
        success: false, 
        error: aiResponse.error || "Failed to generate response" 
      };
    }
    
    logger.log("Chat", `AI response generated: "${aiResponse.text.substring(0, 100)}..."`);
    
    // Create enhanced summary for vector storage
    const summaryString = `On ${formattedDate} ${chatUser} said in ${user.user_name || user.twitch_name}'s Twitch chat: "${message}". You responded by saying: ${aiResponse.text}`;
    
    // Store in vector memory with error handling
    try {
      await addChatMessageAsVector(
        summaryString,
        message,
        chatUser,
        formattedDate,
        aiResponse.text,
        userId
      );
    } catch (vectorError) {
      logger.error("Chat", `Error storing chat vector: ${vectorError.message}`);
      // Don't fail the whole operation if vector storage fails
    }
    
    // Send to Twitch chat with enhanced error handling
    let chatResponse = null;
    if (autoRespond) {
      if (user.twitch_tokens?.bot?.access_token) {
        try {
          logger.log("Chat", `Sending response to Twitch chat`);
          chatResponse = await sendChatMessage(aiResponse.text, userId);
          
          if (chatResponse.success) {
            logger.log("Chat", `Successfully sent response to Twitch chat`);
          } else {
            logger.error("Chat", `Failed to send response to Twitch chat: ${chatResponse.error}`);
          }
        } catch (sendError) {
          logger.error("Chat", `Exception sending chat message: ${sendError.message}`);
          chatResponse = { success: false, error: sendError.message };
        }
      } else {
        logger.warn("Chat", `AutoRespond enabled but no bot token available for user ${userId}`);
        chatResponse = { success: false, error: "No bot token available" };
      }
    }
    
    return {
      success: true,
      processed: true,
      response: aiResponse.text,
      thoughtProcess: aiResponse.thoughtProcess,
      chatResponse,
      summaryString,
      processingTime: Date.now() - Date.now() // Will be updated by caller
    };
    
  } catch (error) {
    logger.error("Chat", `Error handling mentioned message: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function handleFirstTimeChatter(message, chatUser, userId, formattedDate, autoRespond, user) {
  try {
    logger.log("Chat", `Processing first-time chatter event from ${chatUser}`);
    
    const eventData = {
      eventType: 'chat',
      user: chatUser,
      message: message,
      firstMessage: true
    };
    
    const eventResponse = await respondToEvent(eventData, userId);
    
    if (!eventResponse || !eventResponse.response) {
      logger.error("Chat", `Error getting event response for first-time chatter`);
      return { 
        success: false, 
        error: "Failed to generate first-time chatter response" 
      };
    }
    
    const summaryString = `On ${formattedDate} ${chatUser} sent their first message in ${user.user_name || user.twitch_name}'s Twitch chat: "${message}". You responded by saying: ${eventResponse.response}`;
    
    // Store in vector memory with error handling
    try {
      await addChatMessageAsVector(
        summaryString,
        message,
        chatUser,
        formattedDate,
        eventResponse.response,
        userId
      );
    } catch (vectorError) {
      logger.error("Chat", `Error storing first-time chat vector: ${vectorError.message}`);
    }
    
    // Send to Twitch chat if autoRespond is enabled
    let chatResponse = null;
    if (autoRespond && user.twitch_tokens?.bot?.access_token) {
      try {
        chatResponse = await sendChatMessage(eventResponse.response, userId);
      } catch (sendError) {
        logger.error("Chat", `Error sending first-time chatter response: ${sendError.message}`);
        chatResponse = { success: false, error: sendError.message };
      }
    }
    
    return {
      success: true,
      processed: true,
      firstTimeChatter: true,
      response: eventResponse.response,
      thoughtProcess: eventResponse.thoughtProcess,
      chatResponse,
      summaryString
    };
    
  } catch (error) {
    logger.error("Chat", `Error handling first-time chatter: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function handleRegularMessage(message, chatUser, userId, formattedDate, user) {
  try {
    logger.log("Chat", `Regular message from ${chatUser}, storing for context (if enabled)`);
    const summaryString = `On ${formattedDate} ${chatUser} said in ${user.user_name || user.twitch_name}'s Twitch chat: "${message}"`;
    
    // Store in vector memory if enabled in user settings
    if (user.store_all_chat) {
      try {
        logger.log("Chat", `Storing regular chat message for context`);
        await addChatMessageAsVector(
          summaryString,
          message,
          chatUser,
          formattedDate,
          "", // No response
          userId
        );
      } catch (vectorError) {
        logger.error("Chat", `Error storing regular chat: ${vectorError.message}`);
      }
    }
    
    return {
      success: true,
      processed: false,
      requiresResponse: false,
      summaryString
    };
    
  } catch (error) {
    logger.error("Chat", `Error handling regular message: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Enhanced rate limiting for chat processing
 */
const userMessageCounts = new Map();
const CHAT_RATE_LIMIT = 10; // Messages per minute per user
const RATE_LIMIT_WINDOW = 60000; // 1 minute

async function isUserRateLimited(userId, chatUser) {
  const key = `${userId}:${chatUser}`;
  const now = Date.now();
  
  let userStats = userMessageCounts.get(key) || { count: 0, windowStart: now };
  
  // Reset window if expired
  if (now - userStats.windowStart > RATE_LIMIT_WINDOW) {
    userStats = { count: 1, windowStart: now };
  } else {
    userStats.count++;
  }
  
  userMessageCounts.set(key, userStats);
  
  // Clean up old entries periodically
  if (userMessageCounts.size > 1000) {
    for (const [k, stats] of userMessageCounts.entries()) {
      if (now - stats.windowStart > RATE_LIMIT_WINDOW * 2) {
        userMessageCounts.delete(k);
      }
    }
  }
  
  return userStats.count > CHAT_RATE_LIMIT;
}

// ==========================================
// ENHANCED MONITORING AND HEALTH CHECKS
// ==========================================

/**
 * Comprehensive health monitoring system
 */
class TwitchHealthMonitor {
  constructor() {
    this.metrics = {
      eventsProcessed: 0,
      eventsSuccessful: 0,
      eventsFailed: 0,
      chatMessagesProcessed: 0,
      chatResponsesSent: 0,
      averageResponseTime: 0,
      lastEventTime: null,
      subscriptionHealth: new Map(),
      errorCounts: new Map()
    };

    this.alertThresholds = {
      errorRate: 0.1, // 10% error rate triggers alert
      responseTime: 10000, // 10 second response time triggers alert
      eventsPerMinute: 100 // Alert if processing more than 100 events/minute
    };

    // Start monitoring job
    this.startMonitoring();
  }

  startMonitoring() {
    // Every 5 minutes, check health and log metrics
    setInterval(() => {
      this.performHealthCheck();
    }, 5 * 60 * 1000);

    // Every hour, clean up old metrics
    setInterval(() => {
      this.cleanupMetrics();
    }, 60 * 60 * 1000);
  }

  recordEvent(eventType, success, responseTime) {
    this.metrics.eventsProcessed++;
    this.metrics.lastEventTime = Date.now();

    if (success) {
      this.metrics.eventsSuccessful++;
    } else {
      this.metrics.eventsFailed++;
      this.incrementErrorCount(eventType);
    }

    // Update average response time (rolling average)
    if (this.metrics.averageResponseTime === 0) {
      this.metrics.averageResponseTime = responseTime;
    } else {
      this.metrics.averageResponseTime = (this.metrics.averageResponseTime * 0.9) + (responseTime * 0.1);
    }
  }

  recordChatMessage(success, responseTime) {
    this.metrics.chatMessagesProcessed++;
    if (success) {
      this.metrics.chatResponsesSent++;
    }
  }

  incrementErrorCount(eventType) {
    const current = this.errorCounts.get(eventType) || 0;
    this.errorCounts.set(eventType, current + 1);
  }

  performHealthCheck() {
    const errorRate = this.metrics.eventsProcessed > 0 
      ? this.metrics.eventsFailed / this.metrics.eventsProcessed 
      : 0;

    const healthStatus = {
      timestamp: new Date().toISOString(),
      eventsProcessed: this.metrics.eventsProcessed,
      successRate: ((this.metrics.eventsSuccessful / Math.max(1, this.metrics.eventsProcessed)) * 100).toFixed(2) + "%",
      averageResponseTime: Math.round(this.metrics.averageResponseTime),
      chatMessagesProcessed: this.metrics.chatMessagesProcessed,
      chatResponsesSent: this.metrics.chatResponsesSent,
      isHealthy: errorRate < this.alertThresholds.errorRate && 
                 this.metrics.averageResponseTime < this.alertThresholds.responseTime
    };

    logger.log("Health", `Twitch Health Check: ${JSON.stringify(healthStatus)}`);

    // Alert if unhealthy
    if (!healthStatus.isHealthy) {
      logger.error("Health", `Twitch system is unhealthy! Error rate: ${(errorRate * 100).toFixed(2)}%, Avg response: ${Math.round(this.metrics.averageResponseTime)}ms`);
    }

    return healthStatus;
  }

  cleanupMetrics() {
    // Reset metrics every hour to prevent memory growth
    const eventsLastHour = this.metrics.eventsProcessed;
    
    this.metrics = {
      eventsProcessed: 0,
      eventsSuccessful: 0,
      eventsFailed: 0,
      chatMessagesProcessed: 0,
      chatResponsesSent: 0,
      averageResponseTime: this.metrics.averageResponseTime, // Keep rolling average
      lastEventTime: this.metrics.lastEventTime,
      subscriptionHealth: new Map(),
      errorCounts: new Map()
    };

    logger.log("Health", `Metrics reset. Processed ${eventsLastHour} events in the last hour`);
  }

  getDetailedMetrics() {
    return {
      ...this.metrics,
      errorCounts: Object.fromEntries(this.errorCounts),
      subscriptionHealth: Object.fromEntries(this.metrics.subscriptionHealth)
    };
  }
}

// Create global health monitor instance
const healthMonitor = new TwitchHealthMonitor();

// ==========================================
// ENHANCED EVENT PROCESSING WITH MONITORING
// ==========================================

/**
 * Enhanced event processor with comprehensive monitoring and error handling
 */
export async function processEventSubNotification(eventType, eventData, userId, eventVersion = "1") {
  const startTime = Date.now();
  
  try {
    // Rate limiting check for events
    if (await isEventRateLimited(userId, eventType)) {
      logger.warn("Twitch", `Rate limited ${eventType} event for user ${userId}`);
      return { success: false, error: "Rate limited", rateLimited: true };
    }

    logger.log("Twitch", `Processing ${eventType} (v${eventVersion}) event for user ${userId}`);

    // Import AI logic with timeout
    const { respondToEvent } = await import("./ai-logic.js");

    // Map EventSub event format to internal format
    const mappedEvent = mapEventSubToInternalFormat(eventType, eventData, eventVersion);

    // Enhanced error handling for specific event types
    if (eventType === "channel.chat.message") {
      const chatResult = await processChatMessage(eventData, userId);
      
      const processingTime = Date.now() - startTime;
      healthMonitor.recordEvent(eventType, chatResult.success, processingTime);
      
      return {
        ...chatResult,
        processingTime,
        eventType
      };
    }

    // Get response from AI system with timeout
    const responsePromise = respondToEvent(mappedEvent, userId);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Event processing timeout")), 30000)
    );

    const aiResponse = await Promise.race([responsePromise, timeoutPromise]);

    // Check if we have a valid response
    if (aiResponse && aiResponse.response) {
      // Send the response to Twitch chat with enhanced error handling
      try {
        const chatResult = await sendChatMessage(aiResponse.response, userId);

        if (chatResult.success) {
          logger.log("Twitch", `Sent response to ${eventType} event to chat: ${aiResponse.response.substring(0, 50)}...`);
        } else {
          logger.error("Twitch", `Failed to send ${eventType} response to chat: ${chatResult.error}`);
        }

        const processingTime = Date.now() - startTime;
        healthMonitor.recordEvent(eventType, true, processingTime);

        return {
          ...aiResponse,
          chatMessageSent: chatResult.success,
          chatMessageId: chatResult.message_id,
          chatError: chatResult.success ? null : chatResult.error,
          processingTime,
          eventType
        };
      } catch (chatError) {
        logger.error("Twitch", `Exception sending chat response for ${eventType}: ${chatError.message}`);
        
        const processingTime = Date.now() - startTime;
        healthMonitor.recordEvent(eventType, false, processingTime);
        
        return {
          ...aiResponse,
          chatMessageSent: false,
          chatError: chatError.message,
          processingTime,
          eventType
        };
      }
    }

    const processingTime = Date.now() - startTime;
    healthMonitor.recordEvent(eventType, aiResponse ? true : false, processingTime);

    return {
      ...aiResponse,
      processingTime,
      eventType
    };

  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error("Twitch", `Error processing ${eventType} notification: ${error.message}`);
    
    healthMonitor.recordEvent(eventType, false, processingTime);
    
    return {
      success: false,
      error: error.message,
      processingTime,
      eventType,
      stack: error.stack
    };
  }
}

/**
 * Enhanced rate limiting for events
 */
const eventCounts = new Map();
const EVENT_RATE_LIMIT = 50; // Events per minute per user
const EVENT_RATE_LIMIT_WINDOW = 60000; // 1 minute

async function isEventRateLimited(userId, eventType) {
  const key = `${userId}:${eventType}`;
  const now = Date.now();
  
  let eventStats = eventCounts.get(key) || { count: 0, windowStart: now };
  
  // Reset window if expired
  if (now - eventStats.windowStart > EVENT_RATE_LIMIT_WINDOW) {
    eventStats = { count: 1, windowStart: now };
  } else {
    eventStats.count++;
  }
  
  eventCounts.set(key, eventStats);
  
  // Clean up old entries periodically
  if (eventCounts.size > 500) {
    for (const [k, stats] of eventCounts.entries()) {
      if (now - stats.windowStart > EVENT_RATE_LIMIT_WINDOW * 2) {
        eventCounts.delete(k);
      }
    }
  }
  
  return eventStats.count > EVENT_RATE_LIMIT;
}

// ==========================================
// ENHANCED CHAT MESSAGE SENDING
// ==========================================

/**
 * Enhanced chat message sending with retry logic and better error handling
 */
export async function sendChatMessage(message, userId) {
  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const user = await returnAuthObject(userId);

      // Enhanced validation
      if (!user?.twitch_tokens?.bot?.access_token) {
        return { 
          success: false, 
          error: "No bot token available",
          code: "NO_BOT_TOKEN"
        };
      }

      if (!user?.twitch_tokens?.streamer?.twitch_user_id) {
        return { 
          success: false, 
          error: "No streamer ID available",
          code: "NO_STREAMER_ID"
        };
      }

      // Ensure token is valid
      const botToken = await ensureValidToken(userId, "bot");
      if (!botToken) {
        return { 
          success: false, 
          error: "Failed to refresh bot token",
          code: "TOKEN_REFRESH_FAILED"
        };
      }

      const channelId = user.twitch_tokens.streamer.twitch_user_id;

      // Enhanced message validation and sanitization
      const sanitizedMessage = sanitizeChatMessage(message);
      if (!sanitizedMessage) {
        return { 
          success: false, 
          error: "Message was empty after sanitization",
          code: "EMPTY_MESSAGE"
        };
      }

      // Make API call with timeout
      const response = await axios.post(
        `https://api.twitch.tv/helix/chat/messages`,
        {
          broadcaster_id: channelId,
          sender_id: user.twitch_tokens.bot.twitch_user_id,
          message: sanitizedMessage,
        },
        {
          headers: {
            "Client-ID": await retrieveConfigValue("twitch.clientId"),
            Authorization: `Bearer ${botToken}`,
          },
          timeout: 10000 // 10 second timeout
        }
      );

      if (response.status === 200) {
        logger.log("Twitch", `Sent chat message to ${user.twitch_name || user.user_name}'s channel`);
        return { 
          success: true, 
          message_id: response.data?.data?.[0]?.message_id,
          attempt
        };
      } else {
        throw new Error(`API returned ${response.status}: ${response.statusText}`);
      }

    } catch (error) {
      lastError = error;
      
      // Check if error is retryable
      const isRetryable = (
        error.response?.status >= 500 ||
        error.code === "ECONNRESET" ||
        error.code === "ETIMEDOUT" ||
        error.code === "ECONNABORTED"
      );

      if (isRetryable && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
        logger.warn("Twitch", `Retrying chat message send (attempt ${attempt}/${maxRetries}) after ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // Non-retryable error or max retries reached
      break;
    }
  }

  // Return detailed error information
  const errorCode = lastError.response?.status || lastError.code || "UNKNOWN";
  const errorMessage = lastError.response?.data?.message || lastError.message || "Unknown error";

  logger.error("Twitch", `Failed to send chat message after ${maxRetries} attempts: ${errorMessage}`);
  
  return { 
    success: false, 
    error: errorMessage,
    code: errorCode,
    attempts: maxRetries
  };
}

/**
 * Sanitize chat messages for Twitch
 */
function sanitizeChatMessage(message) {
  if (!message || typeof message !== 'string') {
    return '';
  }

  // Remove excessive whitespace and newlines
  let sanitized = message.replace(/\s+/g, ' ').trim();
  
  // Limit message length (Twitch has a 500 character limit)
  if (sanitized.length > 500) {
    sanitized = sanitized.substring(0, 497) + '...';
  }

  // Remove any control characters except basic ones
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  return sanitized;
}

// Export the health monitor for external access
export { healthMonitor, TwitchAPIManager };