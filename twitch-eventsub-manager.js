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
    // Rate limit buckets with TTL and size limits
    this.buckets = new Map();
    this.maxBuckets = 100; // Prevent memory leaks
    
    // Track per-endpoint usage with cleanup
    this.endpointCounts = new Map();
    this.lastCleanup = Date.now();
    this.cleanupInterval = 60 * 60 * 1000; // 1 hour

    // Default retry settings
    this.defaultRetryConfig = {
      maxRetries: 3,
      initialDelay: 500,
      maxDelay: 10000,
      factor: 2,
      jitter: true,
    };

    // Start periodic cleanup
    this.startCleanupTimer();
  }

  /**
   * Periodic cleanup to prevent memory leaks
   */
  startCleanupTimer() {
    setInterval(() => {
      this.cleanupOldData();
    }, this.cleanupInterval);
  }

  /**
   * Clean up old rate limit data and endpoint counts
   */
  cleanupOldData() {
    const now = Date.now();
    
    // Clean up expired buckets
    for (const [key, bucket] of this.buckets.entries()) {
      if (now > bucket.resetAt + 300000) { // 5 minutes buffer
        this.buckets.delete(key);
      }
    }

    // Reset endpoint counts periodically
    if (this.endpointCounts.size > 1000) {
      this.endpointCounts.clear();
      logger.log("Twitch", "Cleaned up endpoint usage statistics");
    }

    // Ensure we don't exceed max buckets
    if (this.buckets.size > this.maxBuckets) {
      const oldestKeys = Array.from(this.buckets.keys()).slice(0, 10);
      oldestKeys.forEach(key => this.buckets.delete(key));
    }

    this.lastCleanup = now;
  }

  /**
   * Get or create rate limit bucket
   */
  getBucket(bucketType) {
    if (!this.buckets.has(bucketType)) {
      const bucket = {
        helix: {
          points: 800,
          remaining: 800,
          resetAt: Date.now() + 60000,
          perMinute: 800,
        },
        auth: {
          points: 120,
          remaining: 120,
          resetAt: Date.now() + 60000,
          perMinute: 120,
        },
      }[bucketType] || {
        points: 100,
        remaining: 100,
        resetAt: Date.now() + 60000,
        perMinute: 100,
      };
      
      this.buckets.set(bucketType, bucket);
    }
    
    return this.buckets.get(bucketType);
  }

  /**
   * Make a rate-limited API call with automatic retries and improved error handling
   */
  async makeRequest(config, bucketType = "helix", retryOptions = {}) {
    const endpoint = this.getEndpointFromUrl(config.url);
    this.trackEndpointUsage(endpoint);

    const retryConfig = { ...this.defaultRetryConfig, ...retryOptions };
    const bucket = this.getBucket(bucketType);

    // Check rate limits before proceeding
    await this.checkRateLimits(bucket);

    let lastError;
    let delay = retryConfig.initialDelay;

    for (let attempt = 0; attempt < retryConfig.maxRetries; attempt++) {
      try {
        const response = await axios({
          ...config,
          timeout: config.timeout || 15000, // Default timeout
        });

        // Update rate limit info from headers
        this.updateRateLimits(bucket, response.headers);
        return response;

      } catch (error) {
        lastError = error;

        // Handle different error types
        if (error.response?.status === 429) {
          const retryAfter = parseInt(error.response.headers["retry-after"] || "0") * 1000;
          delay = Math.max(retryAfter, this.calculateBackoff(attempt, retryConfig));
          
          logger.warn("Twitch", `Rate limited on ${endpoint}. Retrying in ${delay}ms`);
          
          bucket.remaining = 0;
          bucket.resetAt = Date.now() + retryAfter || delay;
          
        } else if (this.isRetryableError(error)) {
          delay = this.calculateBackoff(attempt, retryConfig);
          logger.warn("Twitch", `Retryable error on ${endpoint}: ${error.message}. Retry ${attempt + 1}/${retryConfig.maxRetries} in ${delay}ms`);
        } else {
          // Non-retryable error
          logger.error("Twitch", `Non-retryable error on ${endpoint}: ${error.message}`);
          throw error;
        }

        // Wait before retry
        if (attempt < retryConfig.maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  /**
   * Calculate backoff delay with jitter
   */
  calculateBackoff(attempt, config) {
    const baseDelay = config.initialDelay * Math.pow(config.factor, attempt);
    const maxDelay = config.maxDelay;

    if (config.jitter) {
      return Math.min(maxDelay, Math.random() * baseDelay);
    }

    return Math.min(maxDelay, baseDelay);
  }

  /**
   * Check if we should attempt to retry this error
   */
  isRetryableError(error) {
    // Network errors
    if (["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENOTFOUND"].includes(error.code)) {
      return true;
    }

    // Server errors (5xx) or rate limiting (429)
    if (error.response) {
      const status = error.response.status;
      return status >= 500 || status === 429;
    }

    return false;
  }

  /**
   * Update rate limit info from response headers
   */
  updateRateLimits(bucket, headers) {
    if (!headers) return;

    const remaining = headers["ratelimit-remaining"];
    const reset = headers["ratelimit-reset"];
    const limit = headers["ratelimit-limit"];

    if (remaining !== undefined) bucket.remaining = parseInt(remaining);
    if (limit !== undefined) bucket.points = parseInt(limit);
    if (reset !== undefined) bucket.resetAt = parseInt(reset) * 1000;
  }

  /**
   * Wait if we're close to hitting rate limits
   */
  async checkRateLimits(bucket) {
    const now = Date.now();

    // Reset bucket if time has passed
    if (now > bucket.resetAt) {
      bucket.remaining = bucket.points;
      bucket.resetAt = now + 60000;
      return;
    }

    // If close to limit (less than 10% remaining), delay the request
    if (bucket.remaining < bucket.points * 0.1) {
      const timeToReset = Math.max(0, bucket.resetAt - now);
      logger.warn("Twitch", `Approaching rate limit, delaying request by ${timeToReset}ms`);

      await new Promise((resolve) => setTimeout(resolve, timeToReset));
      bucket.remaining = bucket.points;
      bucket.resetAt = now + 60000;
    }

    bucket.remaining--;
  }

  /**
   * Extract endpoint from URL for tracking
   */
  getEndpointFromUrl(url) {
    try {
      const parsedUrl = new URL(url);
      const segments = parsedUrl.pathname.split("/").filter((s) => s);
      return segments.slice(0, 2).join("/");
    } catch (e) {
      return url;
    }
  }

  /**
   * Track usage per endpoint for analytics
   */
  trackEndpointUsage(endpoint) {
    const count = this.endpointCounts.get(endpoint) || 0;
    this.endpointCounts.set(endpoint, count + 1);
  }

  /**
   * Get usage statistics
   */
  getUsageStats() {
    return {
      buckets: Object.fromEntries(this.buckets),
      endpoints: Object.fromEntries(this.endpointCounts),
    };
  }
}

// Optimized subscription types with better organization
const SUBSCRIPTION_TYPES = [
  // Essential events - high priority
  {
    type: "channel.chat.message",
    version: "1",
    condition: (broadcasterId) => ({
      broadcaster_user_id: broadcasterId,
      user_id: broadcasterId,
    }),
    requiredScopes: ["channel:moderate"],
    tokenType: "app",
    priority: "high",
  },
  {
    type: "channel.follow",
    version: "2",
    condition: (broadcasterId) => ({
      broadcaster_user_id: broadcasterId,
      moderator_user_id: broadcasterId,
    }),
    requiredScopes: ["moderator:read:followers"],
    tokenType: "app",
    priority: "high",
  },
  {
    type: "channel.subscribe",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ["channel:read:subscriptions"],
    tokenType: "app",
    priority: "high",
  },
  {
    type: "channel.subscription.gift",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ["channel:read:subscriptions"],
    tokenType: "app",
    priority: "high",
  },
  // Medium priority events
  {
    type: "channel.cheer",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ["bits:read"],
    tokenType: "app",
    priority: "medium",
  },
  {
    type: "channel.raid",
    version: "1",
    condition: (broadcasterId) => ({ to_broadcaster_user_id: broadcasterId }),
    requiredScopes: [],
    tokenType: "app",
    priority: "medium",
  },
  {
    type: "stream.online",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: [],
    tokenType: "app",
    priority: "medium",
  },
  {
    type: "stream.offline",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: [],
    tokenType: "app",
    priority: "medium",
  },
  // Additional events - lower priority
  {
    type: "channel.update",
    version: "2",
    condition: (broadcasterId) => ({
      broadcaster_user_id: broadcasterId,
      moderator_user_id: broadcasterId,
    }),
    requiredScopes: ["channel:read:stream_key"],
    tokenType: "app",
    priority: "low",
  },
  {
    type: "channel.subscription.message",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ["channel:read:subscriptions"],
    tokenType: "app",
    priority: "low",
  },
  {
    type: "channel.channel_points_custom_reward_redemption.add",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ["channel:read:redemptions"],
    tokenType: "app",
    priority: "low",
  },
];

// Token cache to prevent excessive refreshes
const tokenCache = new Map();
const TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Cached app access token with automatic refresh
 */
export async function getAppAccessToken() {
  const cacheKey = "app_token";
  const cached = tokenCache.get(cacheKey);
  
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  try {
    logger.log("Twitch", "Getting new app access token");

    const clientId = await retrieveConfigValue("twitch.clientId");
    const clientSecret = await retrieveConfigValue("twitch.clientSecret");

    if (!clientId || !clientSecret) {
      throw new Error("Missing Twitch client ID or secret in configuration");
    }

    const response = await axios.post(
      "https://id.twitch.tv/oauth2/token",
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000,
      }
    );

    const { access_token, expires_in } = response.data;
    const expiresAt = Date.now() + (expires_in * 900); // 90% of expiry time

    tokenCache.set(cacheKey, {
      token: access_token,
      expiresAt,
    });

    logger.log("Twitch", "Successfully obtained app access token");
    return access_token;
  } catch (error) {
    logger.error("Twitch", `Failed to get app access token: ${error.message}`);
    throw error;
  }
}

/**
 * Enhanced token refresh with proper error handling and caching
 */
async function ensureValidToken(userId, tokenType) {
  const cacheKey = `${userId}_${tokenType}`;
  const cached = tokenCache.get(cacheKey);
  
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  try {
    const user = await returnAuthObject(userId);
    
    if (!user?.twitch_tokens?.[tokenType]?.refresh_token) {
      return false;
    }
    
    const tokenData = user.twitch_tokens[tokenType];
    const now = Date.now();
    const bufferTime = 5 * 60 * 1000; // 5 minutes buffer
    
    // If token is valid and not close to expiry, return it
    if (tokenData.access_token && tokenData.expires_at && now < tokenData.expires_at - bufferTime) {
      // Cache the existing valid token
      tokenCache.set(cacheKey, {
        token: tokenData.access_token,
        expiresAt: tokenData.expires_at - bufferTime,
      });
      return tokenData.access_token;
    }
    
    // Token needs refresh
    const response = await axios.post(
      "https://id.twitch.tv/oauth2/token",
      new URLSearchParams({
        client_id: await retrieveConfigValue("twitch.clientId"),
        client_secret: await retrieveConfigValue("twitch.clientSecret"),
        grant_type: "refresh_token",
        refresh_token: tokenData.refresh_token
      }),
      { 
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000,
      }
    );
    
    const { access_token, refresh_token, expires_in } = response.data;
    const expiresAt = Date.now() + expires_in * 1000;
    
    // Update token in user record
    await updateUserParameter(userId, `twitch_tokens.${tokenType}`, {
      ...tokenData,
      access_token,
      refresh_token,
      expires_at: expiresAt,
      scopes: null // Clear cached scopes
    });
    
    // Cache the new token
    tokenCache.set(cacheKey, {
      token: access_token,
      expiresAt: expiresAt - bufferTime,
    });
    
    logger.log("Twitch", `Refreshed ${tokenType} token for user ${userId}`);
    return access_token;
    
  } catch (error) {
    logger.error("Twitch", `Failed to refresh ${tokenType} token: ${error.message}`);
    tokenCache.delete(cacheKey); // Remove invalid cache entry
    return false;
  }
}

/**
 * Optimized subscription fetching with proper error handling
 */
async function fetchCurrentTwitchSubscriptions(userId) {
  try {
    const appToken = await getAppAccessToken();
    
    if (!appToken) {
      logger.error("Twitch", "Failed to get app access token for subscription check");
      return [];
    }
    
    const response = await twitchAPI.makeRequest({
      method: "get",
      url: "https://api.twitch.tv/helix/eventsub/subscriptions",
      headers: {
        "Client-ID": await retrieveConfigValue("twitch.clientId"),
        "Authorization": `Bearer ${appToken}`
      }
    });
    
    if (response.data?.data) {
      const callbackUrl = `${await retrieveConfigValue("server.endpoints.external")}/api/v1/twitch/eventsub/${userId}`;
      
      return response.data.data.filter(sub => 
        sub.transport?.callback === callbackUrl &&
        sub.status === "enabled"
      );
    }
    
    return [];
  } catch (error) {
    logger.error("Twitch", `Error fetching current subscriptions: ${error.message}`);
    return [];
  }
}

/**
 * Create singleton instance
 */
const twitchAPI = new TwitchAPIManager();

/**
 * Export wrapper function for all Twitch API calls
 */
export async function callTwitchAPI(config, bucketType = "helix", retryOptions = {}) {
  return twitchAPI.makeRequest(config, bucketType, retryOptions);
}

/**
 * Enhanced subscription registration with better prioritization and error handling
 */
export async function registerUserSubscriptions(userId) {
  try {
    const user = await returnAuthObject(userId);

    if (!user.twitch_tokens?.streamer?.access_token) {
      return {
        success: false,
        created: [],
        skipped: [],
        error: "No streamer account connected",
      };
    }

    // Ensure we have broadcaster ID
    if (!user.twitch_tokens.streamer.twitch_user_id) {
      const twitchUserId = await fetchTwitchUserId(userId, "streamer");
      if (!twitchUserId) {
        return {
          success: false,
          created: [],
          skipped: [],
          error: "Failed to fetch Twitch user ID",
        };
      }
    }

    await ensureParameterPath(userId, "twitch_tokens.streamer.subscriptions");

    // Generate webhook secret if needed
    if (!user.twitch_tokens.streamer.webhook_secret) {
      const newSecret = crypto.randomBytes(32).toString("hex");
      await updateUserParameter(userId, "twitch_tokens.streamer.webhook_secret", newSecret);
      logger.log("Twitch", `Generated new webhook secret for user ${userId}`);
    }

    const updatedUser = await returnAuthObject(userId);
    const broadcasterId = updatedUser.twitch_tokens.streamer.twitch_user_id;

    // Get current subscriptions from Twitch and our database
    const [currentTwitchSubs, streamerScopes] = await Promise.all([
      fetchCurrentTwitchSubscriptions(userId),
      getUserScopes(userId, "streamer"),
    ]);

    // Track existing subscriptions
    const existingSubsMap = new Map();
    currentTwitchSubs.forEach(sub => {
      const key = `${sub.type}:${sub.version}`;
      existingSubsMap.set(key, sub);
    });

    const results = {
      success: true,
      created: [],
      skipped: [],
      errors: [],
      error: null,
    };

    // Sort subscription types by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const sortedSubscriptions = SUBSCRIPTION_TYPES.sort((a, b) => {
      return priorityOrder[a.priority || "low"] - priorityOrder[b.priority || "low"];
    });

    // Process subscriptions with delay between requests
    for (const subscriptionConfig of sortedSubscriptions) {
      try {
        const subKey = `${subscriptionConfig.type}:${subscriptionConfig.version}`;

        // Skip if subscription already exists
        if (existingSubsMap.has(subKey)) {
          results.skipped.push(`${subscriptionConfig.type} (v${subscriptionConfig.version})`);
          continue;
        }

        // Check required scopes
        if (subscriptionConfig.requiredScopes.length > 0) {
          const missingScopes = subscriptionConfig.requiredScopes.filter(
            scope => !streamerScopes.includes(scope)
          );

          if (missingScopes.length > 0) {
            logger.log("Twitch", `Skipping ${subscriptionConfig.type} - missing scopes: ${missingScopes.join(", ")}`);
            results.skipped.push(`${subscriptionConfig.type} (v${subscriptionConfig.version}) - missing scopes`);
            continue;
          }
        }

        // Create the subscription
        const subResult = await createSubscription(userId, subscriptionConfig, broadcasterId);

        if (subResult.success) {
          results.created.push(`${subscriptionConfig.type} (v${subscriptionConfig.version})`);
        } else {
          results.errors.push(`${subscriptionConfig.type}: ${subResult.error}`);
        }

        // Rate limiting delay
        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (error) {
        results.errors.push(`${subscriptionConfig.type}: ${error.message}`);
      }
    }

    // Update success status
    results.success = results.created.length > 0 || results.skipped.length === SUBSCRIPTION_TYPES.length;

    if (results.errors.length > 0) {
      results.error = `Some subscriptions failed: ${results.errors.length} errors`;
    }

    logger.log("Twitch", `EventSub registration for ${userId}: ${results.created.length} created, ${results.skipped.length} skipped, ${results.errors.length} errors`);
    return results;

  } catch (error) {
    logger.error("Twitch", `Error in registerUserSubscriptions: ${error.message}`);
    return {
      success: false,
      created: [],
      skipped: [],
      error: error.message,
    };
  }
}

/**
 * Enhanced subscription creation with better error handling
 */
async function createSubscription(userId, subscriptionConfig, broadcasterId) {
  try {
    const user = await returnAuthObject(userId);
    
    // Use app access token for subscription creation
    const accessToken = await getAppAccessToken();
    const condition = subscriptionConfig.condition(broadcasterId);
    const callbackUrl = `${await retrieveConfigValue("server.endpoints.external")}/api/v1/twitch/eventsub/${userId}`;
    
    const subscriptionBody = {
      type: subscriptionConfig.type,
      version: subscriptionConfig.version,
      condition: condition,
      transport: {
        method: "webhook",
        callback: callbackUrl,
        secret: user.twitch_tokens.streamer.webhook_secret,
      },
    };
    
    const response = await twitchAPI.makeRequest({
      method: "post",
      url: "https://api.twitch.tv/helix/eventsub/subscriptions",
      data: subscriptionBody,
      headers: {
        "Client-ID": await retrieveConfigValue("twitch.clientId"),
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    
    // Save subscription ID
    const subscriptionId = response.data.data[0].id;
    
    // Update local subscription records
    const currentUser = await returnAuthObject(userId);
    const subscriptions = currentUser.twitch_tokens.streamer.subscriptions || [];
    
    subscriptions.push({
      id: subscriptionId,
      type: subscriptionConfig.type,
      version: subscriptionConfig.version,
      created_at: new Date().toISOString(),
    });
    
    await updateUserParameter(userId, "twitch_tokens.streamer.subscriptions", subscriptions);
    
    return {
      success: true,
      id: subscriptionId,
      version: subscriptionConfig.version,
    };
    
  } catch (error) {
    // Handle 409 conflict errors (subscription already exists)
    if (error.response?.status === 409) {
      logger.log("Twitch", `409 Conflict for ${subscriptionConfig.type} - subscription likely exists`);
      
      // Try to find the existing subscription
      const existingSubs = await fetchCurrentTwitchSubscriptions(userId);
      const matchingSub = existingSubs.find(sub => 
        sub.type === subscriptionConfig.type && 
        sub.version === subscriptionConfig.version
      );
      
      if (matchingSub) {
        return {
          success: true,
          id: matchingSub.id,
          version: matchingSub.version,
          alreadyExists: true
        };
      }
    }
    
    logger.error("Twitch", `Error creating subscription ${subscriptionConfig.type}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Enhanced chat message processing with better error handling
 */
export async function processChatMessage(chatEvent, userId) {
  try {
    const { handleChatMessage, normalizeMessageFormat } = await import("./chat-handler.js");
    
    const normalizedChat = normalizeMessageFormat(chatEvent);
    
    // Process through central handler with autoRespond enabled for Twitch
    return await handleChatMessage(normalizedChat, userId, true);
    
  } catch (error) {
    logger.error("Twitch", `Error processing chat message: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Enhanced chat message sending with retry logic
 */
export async function sendChatMessage(message, userId) {
  try {
    const user = await returnAuthObject(userId);

    if (!user.twitch_tokens?.bot?.access_token) {
      logger.error("Twitch", `No bot token for user ${userId}, can't send chat message`);
      return { success: false, error: "No bot token available" };
    }

    // Ensure valid bot token
    const botToken = await ensureValidToken(userId, "bot");
    if (!botToken) {
      logger.error("Twitch", `Failed to refresh bot token for ${userId}`);
      return { success: false, error: "Failed to refresh bot token" };
    }

    if (!user.twitch_tokens?.streamer?.twitch_user_id) {
      logger.error("Twitch", `No streamer ID for ${userId}, can't determine chat channel`);
      return { success: false, error: "No streamer ID available" };
    }

    const channelId = user.twitch_tokens.streamer.twitch_user_id;

    const response = await twitchAPI.makeRequest({
      method: "post",
      url: "https://api.twitch.tv/helix/chat/messages",
      data: {
        broadcaster_id: channelId,
        sender_id: user.twitch_tokens.bot.twitch_user_id,
        message: message,
      },
      headers: {
        "Client-ID": await retrieveConfigValue("twitch.clientId"),
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 200) {
      logger.log("Twitch", `Sent chat message to ${user.twitch_name || user.user_name}'s channel`);
      return { success: true, message_id: response.data.message_id };
    } else {
      logger.error("Twitch", `Failed to send chat message: ${response.status} ${response.statusText}`);
      return { success: false, error: `API returned ${response.status}` };
    }
    
  } catch (error) {
    logger.error("Twitch", `Error sending chat message: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Enhanced user scope checking with caching
 */
async function getUserScopes(userId, tokenType) {
  const cacheKey = `scopes_${userId}_${tokenType}`;
  const cached = tokenCache.get(cacheKey);
  
  if (cached && Date.now() < cached.expiresAt) {
    return cached.scopes;
  }

  try {
    const user = await returnAuthObject(userId);

    if (!user.twitch_tokens?.[tokenType]?.access_token) {
      return [];
    }

    // If we have cached scopes in the user object, use them
    if (user.twitch_tokens[tokenType].scopes && Array.isArray(user.twitch_tokens[tokenType].scopes)) {
      const scopes = user.twitch_tokens[tokenType].scopes;
      tokenCache.set(cacheKey, {
        scopes,
        expiresAt: Date.now() + TOKEN_CACHE_TTL,
      });
      return scopes;
    }

    // Validate token to get scopes
    const response = await axios.get("https://id.twitch.tv/oauth2/validate", {
      headers: {
        Authorization: `OAuth ${user.twitch_tokens[tokenType].access_token}`,
      },
      timeout: 10000,
    });

    if (response.data?.scopes) {
      const scopes = response.data.scopes;
      
      // Cache scopes both in memory and in user object
      await updateUserParameter(userId, `twitch_tokens.${tokenType}.scopes`, scopes);
      tokenCache.set(cacheKey, {
        scopes,
        expiresAt: Date.now() + TOKEN_CACHE_TTL,
      });
      
      return scopes;
    }

    return [];
    
  } catch (error) {
    if (error.response?.status === 401) {
      // Token is invalid, try to refresh
      const newToken = await ensureValidToken(userId, tokenType);
      if (newToken) {
        // Retry with new token
        return getUserScopes(userId, tokenType);
      }
    }
    
    logger.error("Twitch", `Error getting user scopes: ${error.message}`);
    return [];
  }
}

/**
 * Enhanced Twitch user ID fetching
 */
async function fetchTwitchUserId(userId, tokenType) {
  try {
    const user = await returnAuthObject(userId);

    if (user.twitch_tokens?.[tokenType]?.twitch_user_id) {
      return user.twitch_tokens[tokenType].twitch_user_id;
    }

    if (!user.twitch_tokens?.[tokenType]?.access_token) {
      logger.error("Twitch", `No access token available for ${userId} (${tokenType})`);
      return null;
    }

    const response = await twitchAPI.makeRequest({
      method: "get",
      url: "https://api.twitch.tv/helix/users",
      headers: {
        "Client-ID": await retrieveConfigValue("twitch.clientId"),
        Authorization: `Bearer ${user.twitch_tokens[tokenType].access_token}`,
      },
    });

    if (response.data.data?.[0]) {
      const userData = response.data.data[0];
      
      // Save all user info
      await ensureParameterPath(userId, `twitch_tokens.${tokenType}`);
      await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_user_id`, userData.id);
      await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_login`, userData.login);
      await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_display_name`, userData.display_name);

      logger.log("Twitch", `Retrieved and saved Twitch user ID for ${userId} (${tokenType}): ${userData.id}`);
      return userData.id;
    }

    logger.error("Twitch", `Failed to get user info for ${userId} (${tokenType})`);
    return null;
    
  } catch (error) {
    logger.error("Twitch", `Error fetching Twitch user ID for ${userId} (${tokenType}): ${error.message}`);
    return null;
  }
}

/**
 * Main registration function with improved error handling
 */
export async function registerAllUsersEventSub() {
  try {
    logger.log("Twitch", "Starting automatic EventSub registration for all users");

    const users = await returnAPIKeys();
    let successCount = 0;
    let failureCount = 0;

    // Process users in smaller batches to avoid overwhelming the API
    const batchSize = 3;
    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (user) => {
        try {
          if (!user.twitch_tokens?.streamer?.access_token) {
            logger.log("Twitch", `Skipping EventSub for ${user.user_id}: No streamer account connected`);
            return false;
          }

          const validToken = await ensureValidToken(user.user_id, "streamer");
          if (!validToken) {
            logger.log("Twitch", `Skipping EventSub for ${user.user_id}: Token refresh failed`);
            return false;
          }

          const results = await registerUserSubscriptions(user.user_id);
          
          if (results.success) {
            logger.log("Twitch", `Successfully registered EventSub for ${user.user_id}`);
            return true;
          } else {
            logger.log("Twitch", `Failed to register EventSub for ${user.user_id}: ${results.error}`);
            return false;
          }
          
        } catch (userError) {
          logger.error("Twitch", `Error processing user ${user.user_id}: ${userError.message}`);
          return false;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      successCount += batchResults.filter(Boolean).length;
      failureCount += batchResults.filter(result => !result).length;

      // Delay between batches
      if (i + batchSize < users.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    logger.log("Twitch", `EventSub registration complete. Success: ${successCount}, Failures: ${failureCount}`);
    return { success: successCount, failures: failureCount };
    
  } catch (error) {
    logger.error("Twitch", `Error in registerAllUsersEventSub: ${error.message}`);
    throw error;
  }
}

/**
 * Enhanced event processing with better error handling
 */
export async function processEventSubNotification(eventType, eventData, userId, eventVersion = "1") {
  try {
    const { respondToEvent } = await import("./ai-logic.js");

    const mappedEvent = mapEventSubToInternalFormat(eventType, eventData, eventVersion);
    
    logger.log("Twitch", `Processing ${eventType} (v${eventVersion}) event for user ${userId}`);

    const aiResponse = await respondToEvent(mappedEvent, userId);

    if (aiResponse?.response) {
      const chatResult = await sendChatMessage(aiResponse.response, userId);

      if (chatResult.success) {
        logger.log("Twitch", `Sent response to ${eventType} event to chat: ${aiResponse.response.substring(0, 50)}...`);
      } else {
        logger.error("Twitch", `Failed to send ${eventType} response to chat: ${chatResult.error}`);
      }

      return {
        ...aiResponse,
        chatMessageSent: chatResult.success,
        chatMessageId: chatResult.message_id,
      };
    }

    return aiResponse;
    
  } catch (error) {
    logger.error("Twitch", `Error processing notification: ${error.message}`);
    throw error;
  }
}

/**
 * Optimized event mapping function
 */
function mapEventSubToInternalFormat(eventType, eventData, version = "1") {
  const mappedEvent = { eventType: null, eventData: {} };

  switch (eventType) {
    case "channel.chat.message":
      mappedEvent.eventType = "chat";
      mappedEvent.eventData = {
        user: eventData.chatter.user_name,
        user_id: eventData.chatter.user_id,
        message: eventData.message.text,
        is_first: eventData.message.is_first || false,
        chatter_is_broadcaster: eventData.chatter.user_id === eventData.broadcaster_user_id,
        chatter_is_moderator: eventData.chatter.badges?.some(badge => badge.set_id === "moderator") || false,
        chatter_is_subscriber: eventData.chatter.badges?.some(badge => badge.set_id === "subscriber") || false,
        fragments: eventData.message.fragments || [],
        emotes: eventData.message.fragments
          ?.filter(frag => frag.type === "emote")
          .map(emote => ({ id: emote.id, name: emote.text })) || [],
      };
      break;

    case "channel.follow":
      mappedEvent.eventType = "follow";
      mappedEvent.eventData = {
        username: eventData.user_name || "",
        userId: eventData.user_id || "",
        followed_at: eventData.followed_at || new Date().toISOString(),
      };
      break;

    case "channel.subscribe":
      mappedEvent.eventType = "sub";
      mappedEvent.eventData = {
        subType: "sub",
        user: eventData.user_name || "",
        subTier: mapTier(eventData.tier || "1000"),
        isGift: eventData.is_gift || false,
      };
      break;

    case "channel.subscription.gift":
      mappedEvent.eventType = "sub";
      mappedEvent.eventData = {
        subType: "gift_sub",
        user: eventData.is_anonymous ? "Anonymous" : eventData.user_name || "",
        anonymous: eventData.is_anonymous || false,
        subTier: mapTier(eventData.tier || "1000"),
        recipientUserName: eventData.recipient_user_name || "a viewer",
      };
      break;

    case "channel.cheer":
      mappedEvent.eventType = "dono";
      mappedEvent.eventData = {
        donoType: "bits",
        donoFrom: eventData.is_anonymous ? "Anonymous" : eventData.user_name || "",
        donoAmt: eventData.bits || 0,
        donoMessage: eventData.message || "",
      };
      break;

    case "channel.raid":
      mappedEvent.eventType = "raid";
      mappedEvent.eventData = {
        username: eventData.from_broadcaster_user_name || "",
        viewers: eventData.viewers || 0,
      };
      break;

    case "stream.online":
      mappedEvent.eventType = "stream_online";
      mappedEvent.eventData = {
        startTime: eventData.started_at || new Date().toISOString(),
        type: eventData.type || "live",
      };
      break;

    case "stream.offline":
      mappedEvent.eventType = "stream_offline";
      mappedEvent.eventData = {
        endTime: new Date().toISOString(),
      };
      break;

    default:
      mappedEvent.eventType = eventType.replace("channel.", "").replace("stream.", "");
      mappedEvent.eventData = { ...eventData };
  }

  return mappedEvent;
}

/**
 * Helper for tier mapping
 */
function mapTier(tier) {
  switch (tier) {
    case "1000": return "tier 1";
    case "2000": return "tier 2";
    case "3000": return "tier 3";
    default: return "prime";
  }
}

/**
 * Enhanced stream info fetching with better error handling
 */
export async function fetchStreamInfo(userId) {
  try {
    const user = await returnAuthObject(userId);

    if (!user?.twitch_tokens?.streamer?.twitch_user_id) {
      logger.log("Twitch", `No Twitch user ID for ${userId}, can't fetch stream info`);
      return { success: false, isLive: false, error: "Missing Twitch user ID" };
    }

    const appToken = await getAppAccessToken();
    const channelId = user.twitch_tokens.streamer.twitch_user_id;

    const streamResponse = await twitchAPI.makeRequest({
      method: "get",
      url: `https://api.twitch.tv/helix/streams?user_id=${channelId}`,
      headers: {
        "Client-ID": await retrieveConfigValue("twitch.clientId"),
        Authorization: `Bearer ${appToken}`,
      },
    });

    const result = { success: true, isLive: false, data: {} };

    if (streamResponse.data.data?.[0]) {
      const streamData = streamResponse.data.data[0];
      result.isLive = true;
      result.data = {
        viewerCount: streamData.viewer_count || 0,
        startedAt: streamData.started_at || null,
        title: streamData.title || "",
        gameId: streamData.game_id || "",
        gameName: streamData.game_name || "Unknown Game",
        thumbnailUrl: streamData.thumbnail_url
          ?.replace("{width}", "320")
          .replace("{height}", "180") || null,
      };

      // Update user parameters
      await Promise.all([
        updateUserParameter(userId, "current_game", {
          title: streamData.title || "No Title",
          game: streamData.game_name || "none",
          game_id: streamData.game_id || "0",
          thumbnail_url: streamData.thumbnail_url || null,
          updated_at: new Date().toISOString(),
        }),
        updateUserParameter(userId, "current_viewers", streamData.viewer_count || 0),
        updateUserParameter(userId, "stream_status", {
          online: true,
          started_at: streamData.started_at || null,
          type: streamData.type || "live",
          title: streamData.title || "",
          viewer_count: streamData.viewer_count || 0,
          updated_at: new Date().toISOString(),
        })
      ]);

      logger.log("Twitch", `Updated stream info for ${userId}: ${streamData.viewer_count} viewers, playing ${streamData.game_name}`);
    } else {
      // Stream is offline
      await Promise.all([
        updateUserParameter(userId, "stream_status", {
          online: false,
          updated_at: new Date().toISOString(),
        }),
        updateUserParameter(userId, "current_viewers", 0)
      ]);
    }

    // Always fetch follower count
    await fetchFollowerCount(userId, channelId, appToken);

    return result;
    
  } catch (error) {
    logger.error("Twitch", `Error fetching stream info: ${error.message}`);
    return { success: false, isLive: false, error: error.message };
  }
}

/**
 * Fetch follower count with error handling
 */
async function fetchFollowerCount(userId, channelId, appToken) {
  try {
    const followerResponse = await twitchAPI.makeRequest({
      method: "get",
      url: `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${channelId}`,
      headers: {
        "Client-ID": await retrieveConfigValue("twitch.clientId"),
        Authorization: `Bearer ${appToken}`,
      },
    });

    const followerCount = followerResponse.data.total || 0;
    await updateUserParameter(userId, "current_followers", followerCount);
    
    logger.log("Twitch", `Updated follower count for ${userId}: ${followerCount}`);
    return followerCount;
    
  } catch (error) {
    logger.error("Twitch", `Error fetching follower count: ${error.message}`);
    return 0;
  }
}

/**
 * Update all stream info with better error handling and concurrency control
 */
export async function updateAllStreamInfo() {
  try {
    const users = await returnAPIKeys();
    const twitchUsers = users.filter(user => user.twitch_tokens?.streamer?.twitch_user_id);
    
    let updatedCount = 0;
    let errorCount = 0;

    // Process in smaller batches to avoid rate limits
    const batchSize = 5;
    for (let i = 0; i < twitchUsers.length; i += batchSize) {
      const batch = twitchUsers.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (user) => {
        try {
          await fetchStreamInfo(user.user_id);
          return true;
        } catch (error) {
          logger.error("Twitch", `Error updating stream info for ${user.user_id}: ${error.message}`);
          return false;
        }
      });

      const results = await Promise.all(batchPromises);
      updatedCount += results.filter(Boolean).length;
      errorCount += results.filter(result => !result).length;

      // Short delay between batches
      if (i + batchSize < twitchUsers.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    logger.log("Twitch", `Updated stream info for ${updatedCount} users, with ${errorCount} errors`);
    return { updated: updatedCount, errors: errorCount };
    
  } catch (error) {
    logger.error("Twitch", `Error in updateAllStreamInfo: ${error.message}`);
    return { updated: 0, errors: 1 };
  }
}

/**
 * Enhanced cron job setup with better error handling
 */
export function setupTwitchCronJobs() {
  // Update stream info every minute
  cron.schedule("*/1 * * * *", async () => {
    try {
      await updateAllStreamInfo();
    } catch (error) {
      logger.error("Cron", `Error in stream info update job: ${error.message}`);
    }
  });

  // Update follower count every 5 minutes
  cron.schedule("*/5 * * * *", async () => {
    try {
      const users = await returnAPIKeys();
      const twitchUsers = users.filter(user => user.twitch_tokens?.streamer?.twitch_user_id);

      for (const user of twitchUsers) {
        try {
          const channelId = user.twitch_tokens.streamer.twitch_user_id;
          const appToken = await getAppAccessToken();
          await fetchFollowerCount(user.user_id, channelId, appToken);
        } catch (userError) {
          logger.error("Twitch", `Error updating follower count for ${user.user_id}: ${userError.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      logger.error("Cron", `Error in follower count update job: ${error.message}`);
    }
  });

  // Periodic token cache cleanup
  cron.schedule("*/15 * * * *", () => {
    const now = Date.now();
    for (const [key, cached] of tokenCache.entries()) {
      if (now > cached.expiresAt) {
        tokenCache.delete(key);
      }
    }
  });

  logger.log("System", "Twitch cron jobs initialized");
}