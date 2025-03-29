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
    // Rate limit buckets - track API call counts
    this.buckets = {
      helix: {
        // Core API
        points: 800,
        remaining: 800,
        resetAt: Date.now() + 60000,
        perMinute: 800,
      },
      auth: {
        // Auth API
        points: 120,
        remaining: 120,
        resetAt: Date.now() + 60000,
        perMinute: 120,
      },
    };

    // Track per-endpoint usage
    this.endpointCounts = new Map();

    // Default retry settings
    this.defaultRetryConfig = {
      maxRetries: 3,
      initialDelay: 500,
      maxDelay: 10000,
      factor: 2,
      jitter: true,
    };
  }

  /**
   * Make a rate-limited API call with automatic retries
   * @param {Object} config - Axios config object
   * @param {String} bucketType - API type ('helix' or 'auth')
   * @param {Object} retryOptions - Custom retry options
   * @returns {Promise<Object>} - API response
   */
  async makeRequest(config, bucketType = "helix", retryOptions = {}) {
    // Track this endpoint
    const endpoint = this.getEndpointFromUrl(config.url);
    this.trackEndpointUsage(endpoint);

    // Merge retry options
    const retryConfig = { ...this.defaultRetryConfig, ...retryOptions };

    // Check rate limits before proceeding
    await this.checkRateLimits(bucketType);

    // Try the request with retries
    let lastError;
    let delay = retryConfig.initialDelay;

    for (let attempt = 0; attempt < retryConfig.maxRetries; attempt++) {
      try {
        const response = await axios(config);

        // Update rate limit info from headers
        this.updateRateLimits(bucketType, response.headers);

        return response;
      } catch (error) {
        lastError = error;

        // Check if error is due to rate limiting
        if (error.response?.status === 429) {
          // Get retry-after header or use exponential backoff
          const retryAfter =
            parseInt(error.response.headers["retry-after"] || "0") * 1000;
          delay = Math.max(
            retryAfter,
            this.calculateBackoff(attempt, retryConfig)
          );

          logger.warn(
            "Twitch",
            `Rate limited on ${endpoint}. Retrying in ${delay}ms`
          );

          // Update our rate limit tracking
          this.buckets[bucketType].remaining = 0;
          this.buckets[bucketType].resetAt = Date.now() + retryAfter || delay;
        } else if (this.isRetryableError(error)) {
          // For other retryable errors, use exponential backoff
          delay = this.calculateBackoff(attempt, retryConfig);
          logger.warn(
            "Twitch",
            `Retryable error on ${endpoint}: ${error.message}. Retry ${attempt + 1}/${retryConfig.maxRetries} in ${delay}ms`
          );
        } else {
          // Non-retryable error
          throw error;
        }

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // If we've exhausted retries, throw the last error
    throw lastError;
  }

  /**
   * Calculate backoff delay with jitter
   */
  calculateBackoff(attempt, config) {
    const baseDelay = config.initialDelay * Math.pow(config.factor, attempt);
    const maxDelay = config.maxDelay;

    // Apply jitter if enabled (helps distribute retries)
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
    if (
      error.code === "ECONNRESET" ||
      error.code === "ETIMEDOUT" ||
      error.code === "ECONNABORTED"
    ) {
      return true;
    }

    // Server errors (5xx)
    if (error.response && error.response.status >= 500) {
      return true;
    }

    // Rate limiting (429)
    if (error.response && error.response.status === 429) {
      return true;
    }

    return false;
  }

  /**
   * Update rate limit info from response headers
   */
  updateRateLimits(bucketType, headers) {
    if (!headers) return;

    const remaining = headers["ratelimit-remaining"];
    const reset = headers["ratelimit-reset"];
    const limit = headers["ratelimit-limit"];

    if (remaining) this.buckets[bucketType].remaining = parseInt(remaining);
    if (limit) this.buckets[bucketType].points = parseInt(limit);
    if (reset) this.buckets[bucketType].resetAt = parseInt(reset) * 1000; // Convert to ms
  }

  /**
   * Wait if we're close to hitting rate limits
   */
  async checkRateLimits(bucketType) {
    const bucket = this.buckets[bucketType];
    const now = Date.now();

    // Reset bucket if time has passed
    if (now > bucket.resetAt) {
      bucket.remaining = bucket.points;
      bucket.resetAt = now + 60000; // Default 1 minute
      return;
    }

    // If close to limit (less than 10% remaining), delay the request
    if (bucket.remaining < bucket.points * 0.1) {
      const timeToReset = Math.max(0, bucket.resetAt - now);
      logger.warn(
        "Twitch",
        `Approaching rate limit for ${bucketType}, delaying request by ${timeToReset}ms`
      );

      // Sleep until rate limit resets
      await new Promise((resolve) => setTimeout(resolve, timeToReset));

      // Reset the bucket
      bucket.remaining = bucket.points;
      bucket.resetAt = now + 60000;
    }

    // Decrement remaining points
    bucket.remaining--;
  }

  /**
   * Extract endpoint from URL for tracking
   */
  getEndpointFromUrl(url) {
    try {
      const parsedUrl = new URL(url);
      const path = parsedUrl.pathname;
      // Get first two path segments
      const segments = path.split("/").filter((s) => s);
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
      buckets: this.buckets,
      endpoints: Object.fromEntries(this.endpointCounts),
    };
  }
}

// EventSub subscription definitions with accurate condition requirements
const SUBSCRIPTION_TYPES = [
  // Version 1 endpoints - Standard events
  {
    type: "channel.update",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ["channel:read:stream_key"],
    tokenType: "app",
  },
  {
    type: "channel.chat.message",
    version: "1",
    condition: (broadcasterId) => ({
      broadcaster_user_id: broadcasterId,
      user_id: broadcasterId,
    }),
    requiredScopes: ["channel:moderate"],
    tokenType: "app",
  },
  {
    type: "channel.subscribe",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ["channel:read:subscriptions"],
    tokenType: "app",
  },
  {
    type: "channel.subscription.gift",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ["channel:read:subscriptions"],
    tokenType: "app",
  },
  {
    type: "channel.subscription.message",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ["channel:read:subscriptions"],
    tokenType: "app",
  },
  {
    type: "channel.cheer",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ["bits:read"],
    tokenType: "app",
  },
  {
    type: "channel.raid",
    version: "1",
    condition: (broadcasterId) => ({ to_broadcaster_user_id: broadcasterId }),
    requiredScopes: [],
    tokenType: "app",
  },
  {
    type: "channel.channel_points_custom_reward_redemption.add",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ["channel:read:redemptions"],
    tokenType: "app",
  },
  {
    type: "channel.charity_campaign.donate",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ["channel:read:charity"],
    tokenType: "app",
  },
  {
    type: "channel.charity_campaign.progress",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ["channel:read:charity"],
    tokenType: "app",
  },
  {
    type: "channel.hype_train.begin",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ["channel:read:hype_train"],
    tokenType: "app",
  },
  {
    type: "channel.hype_train.progress",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ["channel:read:hype_train"],
    tokenType: "app",
  },
  {
    type: "channel.hype_train.end",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ["channel:read:hype_train"],
    tokenType: "app",
  },
  {
    type: "stream.online",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: [],
    tokenType: "app",
  },
  {
    type: "stream.offline",
    version: "1",
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: [],
    tokenType: "app",
  },

  // Version 2 endpoints
  {
    type: "channel.follow",
    version: "2",
    condition: (broadcasterId) => ({
      broadcaster_user_id: broadcasterId,
      moderator_user_id: broadcasterId, // Using broadcaster as moderator for simplicity
    }),
    requiredScopes: ["moderator:read:followers"],
    tokenType: "app",
  },
  {
    type: "channel.update",
    version: "2",
    condition: (broadcasterId) => ({
      broadcaster_user_id: broadcasterId,
      moderator_user_id: broadcasterId,
    }),
    requiredScopes: ["channel:read:stream_key"],
    tokenType: "app",
  },

  // Beta endpoints - Only include if broadcaster has appropriate permissions
  {
    type: "channel.guest_star_session.begin",
    version: "beta",
    condition: (broadcasterId) => ({
      broadcaster_user_id: broadcasterId,
      moderator_user_id: broadcasterId,
    }),
    requiredScopes: [
      "moderator:read:guest_star",
      "moderator:manage:guest_star",
    ],
    tokenType: "app",
    optional: true,
  },
  {
    type: "channel.guest_star_guest.update",
    version: "beta",
    condition: (broadcasterId) => ({
      broadcaster_user_id: broadcasterId,
      moderator_user_id: broadcasterId,
    }),
    requiredScopes: ["moderator:read:guest_star"],
    tokenType: "app",
    optional: true,
  },
];

/**
 * Get an app access token for Twitch API calls that require it
 * @returns {Promise<string>} The app access token
 */
export async function getAppAccessToken() {
  try {
    // Check for cached token first
    if (
      global.twitchAppToken &&
      global.twitchAppTokenExpiry &&
      Date.now() < global.twitchAppTokenExpiry
    ) {
      return global.twitchAppToken;
    }

    logger.log("Twitch", "Getting new app access token");

    const clientId = await retrieveConfigValue("twitch.clientId");
    const clientSecret = await retrieveConfigValue("twitch.clientSecret");

    if (!clientId || !clientSecret) {
      throw new Error("Missing Twitch client ID or secret in configuration");
    }

    const axios = (await import("axios")).default;
    const response = await axios.post(
      "https://id.twitch.tv/oauth2/token",
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const { access_token, expires_in } = response.data;

    // Cache the token with a safety margin
    global.twitchAppToken = access_token;
    global.twitchAppTokenExpiry = Date.now() + expires_in * 900; // 90% of expiry time

    logger.log("Twitch", "Successfully obtained app access token");
    return access_token;
  } catch (error) {
    logger.error("Twitch", `Failed to get app access token: ${error.message}`);
    throw error;
  }
}

/**
 * Main function to register EventSub for all users
 * @returns {Promise<{success: number, failures: number}>}
 */
export async function registerAllUsersEventSub() {
  try {
    logger.log(
      "Twitch",
      "Starting automatic EventSub registration for all users"
    );

    // Get all users from auth system
    const users = await returnAPIKeys();
    let successCount = 0;
    let failureCount = 0;

    // Process each user sequentially to avoid rate limits
    for (const user of users) {
      try {
        // Skip users without any Twitch tokens
        if (!user.twitch_tokens) {
          logger.log(
            "Twitch",
            `Skipping EventSub for ${user.user_id}: No Twitch integration`
          );
          continue;
        }

        // We need the streamer account for EventSub
        if (
          !user.twitch_tokens.streamer ||
          !user.twitch_tokens.streamer.access_token
        ) {
          logger.log(
            "Twitch",
            `Skipping EventSub for ${user.user_id}: No streamer account connected`
          );
          continue;
        }

        // Check if we need to refresh the token
        const validToken = await ensureValidToken(user.user_id, "streamer");
        if (!validToken) {
          logger.log(
            "Twitch",
            `Skipping EventSub for ${user.user_id}: Token refresh failed`
          );
          failureCount++;
          continue;
        }

        // Get Twitch user ID if we don't have it yet
        if (!user.twitch_tokens.streamer.twitch_user_id) {
          const twitchUserId = await fetchTwitchUserId(
            user.user_id,
            "streamer"
          );
          if (!twitchUserId) {
            logger.log(
              "Twitch",
              `Skipping EventSub for ${user.user_id}: Couldn't get Twitch user ID`
            );
            failureCount++;
            continue;
          }
        }

        // Register all subscription types
        const results = await registerUserSubscriptions(user.user_id);

        if (results.success) {
          successCount++;
          logger.log(
            "Twitch",
            `Successfully registered EventSub for ${user.user_id}`
          );
        } else {
          failureCount++;
          logger.log(
            "Twitch",
            `Failed to register EventSub for ${user.user_id}: ${results.error}`
          );
        }
      } catch (userError) {
        failureCount++;
        logger.error(
          "Twitch",
          `Error processing user ${user.user_id}: ${userError.message}`
        );
      }

      // Add a small delay between users to avoid rate limits
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    logger.log(
      "Twitch",
      `EventSub registration complete. Success: ${successCount}, Failures: ${failureCount}`
    );
    return { success: successCount, failures: failureCount };
  } catch (error) {
    logger.error(
      "Twitch",
      `Error in registerAllUsersEventSub: ${error.message}`
    );
    throw error;
  }
}

// Create singleton instance
const twitchAPI = new TwitchAPIManager();

// Export a wrapper function for all Twitch API calls
export async function callTwitchAPI(
  config,
  bucketType = "helix",
  retryOptions = {}
) {
  return twitchAPI.makeRequest(config, bucketType, retryOptions);
}

/**
 * Register all subscription types for a single user
 * @param {string} userId - The user ID
 * @returns {Promise<{success: boolean, created: string[], skipped: string[], error: string|null}>}
 */
export async function registerUserSubscriptions(userId) {
  try {
    const user = await returnAuthObject(userId);

    // Check if streamer account is connected
    if (
      !user.twitch_tokens ||
      !user.twitch_tokens.streamer ||
      !user.twitch_tokens.streamer.access_token
    ) {
      return {
        success: false,
        created: [],
        skipped: [],
        error: "No streamer account connected",
      };
    }

    // Check if we have the Twitch user ID
    if (!user.twitch_tokens.streamer.twitch_user_id) {
      logger.log(
        "Twitch",
        `No Twitch user ID found for user ${userId}, fetching it now`
      );

      try {
        const twitchUserId = await fetchTwitchUserId(userId, "streamer");
        if (!twitchUserId) {
          logger.error(
            "Twitch",
            `Failed to fetch Twitch user ID for ${userId}`
          );
          return {
            success: false,
            created: [],
            skipped: [],
            error: "Failed to fetch Twitch user ID",
          };
        }

        // Should be saved by fetchTwitchUserId, but double-check
        if (!user.twitch_tokens.streamer.twitch_user_id) {
          await updateUserParameter(
            userId,
            "twitch_tokens.streamer.twitch_user_id",
            twitchUserId
          );
        }
      } catch (err) {
        logger.error("Twitch", `Error fetching Twitch user ID: ${err.message}`);
        return {
          success: false,
          created: [],
          skipped: [],
          error: `Error fetching Twitch user ID: ${err.message}`,
        };
      }
    }

    // Make sure the webhook_secret path exists
    await ensureParameterPath(userId, "twitch_tokens.streamer.subscriptions");

    // Generate webhook secret if it doesn't exist
    if (!user.twitch_tokens.streamer.webhook_secret) {
      const newSecret = crypto.randomBytes(32).toString("hex");
      await updateUserParameter(
        userId,
        "twitch_tokens.streamer.webhook_secret",
        newSecret
      );
      logger.log("Twitch", `Generated new webhook secret for user ${userId}`);
    }

    // Refresh the user object to make sure we have the latest data
    const updatedUser = await returnAuthObject(userId);

    // Verify we have the broadcaster_user_id
    if (!updatedUser.twitch_tokens.streamer.twitch_user_id) {
      logger.error(
        "Twitch",
        `No Twitch user ID found for user ${userId} after refresh`
      );
      return {
        success: false,
        created: [],
        skipped: [],
        error: "Missing Twitch user ID",
      };
    }

    // Check if the bot account is connected for subscriptions that need it
    const hasBotAccount = updatedUser.twitch_tokens?.bot?.access_token
      ? true
      : false;

    // Track existing subscriptions to avoid duplicates
    const existingSubscriptions = new Map();
    if (updatedUser.twitch_tokens.streamer.subscriptions) {
      updatedUser.twitch_tokens.streamer.subscriptions.forEach((sub) => {
        // Create key from type and version
        const key = `${sub.type}:${sub.version || "1"}`;
        existingSubscriptions.set(key, sub);
      });
    }

    const results = {
      success: true,
      created: [],
      skipped: [],
      errors: [],
      error: null,
    };

    const broadcasterId = updatedUser.twitch_tokens.streamer.twitch_user_id;

    // Check which scopes the user has
    const streamerScopes = await getUserScopes(userId, "streamer");
    const botScopes = hasBotAccount ? await getUserScopes(userId, "bot") : [];

    // Process each subscription type
    for (const subscriptionConfig of SUBSCRIPTION_TYPES) {
      try {
        // Create key for checking existing subscriptions
        const subKey = `${subscriptionConfig.type}:${subscriptionConfig.version}`;

        // Skip if we already have this subscription
        if (existingSubscriptions.has(subKey)) {
          results.skipped.push(
            `${subscriptionConfig.type} (v${subscriptionConfig.version})`
          );
          continue;
        }

        // Skip optional subscriptions if conditions aren't met (like beta features)
        if (subscriptionConfig.optional) {
          // Skip beta features if not explicitly allowed
          if (
            subscriptionConfig.version === "beta" &&
            !user.allow_beta_features
          ) {
            results.skipped.push(
              `${subscriptionConfig.type} (v${subscriptionConfig.version}) - beta feature not enabled`
            );
            continue;
          }
        }

        // Verify the user has the required scopes
        if (subscriptionConfig.requiredScopes.length > 0) {
          const accountType = subscriptionConfig.tokenType;
          const userScopes = accountType === "bot" ? botScopes : streamerScopes;

          // Skip if using bot token but no bot account is connected
          if (accountType === "bot" && !hasBotAccount) {
            results.skipped.push(
              `${subscriptionConfig.type} (v${subscriptionConfig.version}) - requires bot account`
            );
            continue;
          }

          // Check if user has all required scopes
          const missingScopes = subscriptionConfig.requiredScopes.filter(
            (scope) => !userScopes.includes(scope)
          );

          if (missingScopes.length > 0) {
            logger.log(
              "Twitch",
              `Skipping ${subscriptionConfig.type} - missing scopes: ${missingScopes.join(", ")}`
            );
            results.skipped.push(
              `${subscriptionConfig.type} (v${subscriptionConfig.version}) - missing scopes`
            );
            continue;
          }
        }

        // Create the subscription
        const subResult = await createSubscription(
          userId,
          subscriptionConfig,
          broadcasterId
        );

        if (subResult.success) {
          results.created.push(
            `${subscriptionConfig.type} (v${subscriptionConfig.version})`
          );
        } else {
          // Track errors but continue with other subscriptions
          results.errors.push(
            `${subscriptionConfig.type} (v${subscriptionConfig.version}): ${subResult.error}`
          );
          logger.error(
            "Twitch",
            `Failed to create subscription for ${subscriptionConfig.type} (v${subscriptionConfig.version}): ${subResult.error}`
          );
        }

        // Add a small delay between requests to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        // Handle individual subscription errors
        results.errors.push(
          `${subscriptionConfig.type} (v${subscriptionConfig.version}): ${error.message}`
        );
        logger.error(
          "Twitch",
          `Error creating subscription for ${subscriptionConfig.type} (v${subscriptionConfig.version}): ${error.message}`
        );
      }
    }

    // Overall success is true if we created at least one subscription without errors
    // or if we skipped all because they already exist
    results.success =
      results.created.length > 0 ||
      results.skipped.length === SUBSCRIPTION_TYPES.length;

    // Add summary of errors if any occurred
    if (results.errors.length > 0) {
      results.error = `Some subscriptions failed: ${results.errors.length} errors`;
      logger.warn(
        "Twitch",
        `Completed EventSub registration for ${userId} with ${results.errors.length} errors`
      );
    } else {
      logger.log(
        "Twitch",
        `Successfully registered all EventSub subscriptions for ${userId}`
      );
    }

    return results;
  } catch (error) {
    logger.error(
      "Twitch",
      `Error in registerUserSubscriptions: ${error.message}`
    );
    return {
      success: false,
      created: [],
      skipped: [],
      error: error.message,
    };
  }
}

/**
 * Process channel update events to extract game information
 * @param {object} event - The event data
 * @param {string} userId - The user ID
 * @returns {Promise<void>}
 */
async function handleChannelUpdate(event, userId) {
  try {
    // Extract game name, title, and category_id
    const { title, category_name, category_id } = event;

    // Update user's current game info with improved structure
    await updateUserParameter(userId, "current_game", {
      title: title || "No Title",
      game: category_name || "none", // Use "none" as fallback
      game_id: category_id || "0",
      updated_at: new Date().toISOString(),
    });

    logger.log(
      "Twitch",
      `Updated game info for ${userId}: ${category_name || "none"}`
    );

    // After updating game info, fetch current viewer count
    await fetchViewerCount(userId);
  } catch (error) {
    logger.error("Twitch", `Error handling channel update: ${error.message}`);
  }
}

/**
 * Process stream state change events (online/offline)
 * @param {string} eventType - The event type (stream.online or stream.offline)
 * @param {object} event - The event data
 * @param {string} userId - The user ID
 * @returns {Promise<void>}
 */
async function handleStreamStateChange(eventType, event, userId) {
  try {
    const isOnline = eventType === "stream.online";

    // Update user's stream status
    await updateUserParameter(userId, "stream_status", {
      online: isOnline,
      started_at: isOnline ? event.started_at : null,
      type: isOnline ? event.type : null,
      updated_at: new Date().toISOString(),
    });

    logger.log(
      "Twitch",
      `Stream ${isOnline ? "started" : "ended"} for ${userId}`
    );

    // Reset viewer count to 0 when stream goes offline
    if (!isOnline) {
      await updateUserParameter(userId, "current_viewers", 0);
    } else {
      // If stream just went online, fetch current viewer count after a short delay
      // This gives Twitch API time to update with the new stream data
      setTimeout(() => fetchViewerCount(userId), 30000); // 30 seconds delay
    }
  } catch (error) {
    logger.error(
      "Twitch",
      `Error handling stream state change: ${error.message}`
    );
  }
}

/**
 * Fetches current stream information and updates user parameters
 * @param {string} userId - The user ID
 * @returns {Promise<object>} - Stream info object with status and data
 */
export async function fetchStreamInfo(userId) {
  try {
    const user = await returnAuthObject(userId);

    // Check if streamer token exists and channel ID is available
    if (!user?.twitch_tokens?.streamer?.twitch_user_id) {
      logger.log(
        "Twitch",
        `No Twitch user ID for ${userId}, can't fetch stream info`
      );
      return { success: false, isLive: false, error: "Missing Twitch user ID" };
    }

    // Get app access token for API call
    const appToken = await getAppAccessToken();
    const channelId = user.twitch_tokens.streamer.twitch_user_id;

    // Import axios
    const axios = (await import("axios")).default;

    // Get stream information
    const streamResponse = await axios.get(
      `https://api.twitch.tv/helix/streams?user_id=${channelId}`,
      {
        headers: {
          "Client-ID": await retrieveConfigValue("twitch.clientId"),
          Authorization: `Bearer ${appToken}`,
        },
      }
    );

    // Prepare result object
    const result = {
      success: true,
      isLive: false,
      data: {},
    };

    // Check if stream is live
    if (streamResponse.data.data && streamResponse.data.data.length > 0) {
      const streamData = streamResponse.data.data[0];
      result.isLive = true;

      // Extract stream details
      result.data = {
        viewerCount: streamData.viewer_count || 0,
        startedAt: streamData.started_at || null,
        title: streamData.title || "",
        gameId: streamData.game_id || "",
        gameName: streamData.game_name || "Unknown Game",
        thumbnailUrl:
          streamData.thumbnail_url
            ?.replace("{width}", "320")
            .replace("{height}", "180") || null,
      };

      // Calculate stream duration
      if (streamData.started_at) {
        const startTime = new Date(streamData.started_at);
        const currentTime = new Date();
        const durationMs = currentTime - startTime;

        // Format duration
        const hours = Math.floor(durationMs / (1000 * 60 * 60));
        const minutes = Math.floor(
          (durationMs % (1000 * 60 * 60)) / (1000 * 60)
        );
        result.data.duration = `${hours}h ${minutes}m`;
        result.data.durationMs = durationMs;
      }

      // Update user parameters with stream data
      await updateUserParameter(userId, "current_game", {
        title: streamData.title || "No Title",
        game: streamData.game_name || "none",
        game_id: streamData.game_id || "0",
        thumbnail_url: streamData.thumbnail_url || null,
        updated_at: new Date().toISOString(),
      });

      await updateUserParameter(
        userId,
        "current_viewers",
        streamData.viewer_count || 0
      );

      // Update stream status
      await updateUserParameter(userId, "stream_status", {
        online: true,
        started_at: streamData.started_at || null,
        type: streamData.type || "live",
        title: streamData.title || "",
        viewer_count: streamData.viewer_count || 0,
        updated_at: new Date().toISOString(),
      });

      logger.log(
        "Twitch",
        `Updated stream info for ${userId}: ${streamData.viewer_count} viewers, playing ${streamData.game_name}`
      );
    } else {
      // Stream is offline
      await updateUserParameter(userId, "stream_status", {
        online: false,
        updated_at: new Date().toISOString(),
      });

      // Keep the current game info but mark as offline
      const currentGameInfo = user.current_game || {};
      await updateUserParameter(userId, "current_game", {
        ...currentGameInfo,
        online: false,
        updated_at: new Date().toISOString(),
      });

      await updateUserParameter(userId, "current_viewers", 0);
    }

    // Always fetch follower count regardless of stream status
    await fetchFollowerCount(userId, channelId, appToken);

    return result;
  } catch (error) {
    logger.error("Twitch", `Error fetching stream info: ${error.message}`);
    return { success: false, isLive: false, error: error.message };
  }
}

/**
 * Fetches follower count for a channel
 * @param {string} userId - The user ID
 * @param {string} channelId - The Twitch channel ID
 * @param {string} appToken - The app access token
 * @returns {Promise<number>} - The follower count
 */
async function fetchFollowerCount(userId, channelId, appToken) {
  try {
    // Import axios
    const axios = (await import("axios")).default;

    // Get follower information
    const followerResponse = await axios.get(
      `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${channelId}`,
      {
        headers: {
          "Client-ID": await retrieveConfigValue("twitch.clientId"),
          Authorization: `Bearer ${appToken}`,
        },
      }
    );

    const followerCount = followerResponse.data.total || 0;

    // Update user parameter with follower count
    await updateUserParameter(userId, "current_followers", followerCount);
    logger.log(
      "Twitch",
      `Updated follower count for ${userId}: ${followerCount}`
    );

    return followerCount;
  } catch (error) {
    logger.error("Twitch", `Error fetching follower count: ${error.message}`);
    return 0;
  }
}

/**
 * Fetch current viewer count for a user's channel
 * @param {string} userId - The user ID
 * @returns {Promise<number>} - The viewer count, or 0 if unavailable
 */
async function fetchViewerCount(userId) {
  try {
    const user = await returnAuthObject(userId);

    // Check if streamer token exists and channel ID is available
    if (!user.twitch_tokens?.streamer?.twitch_user_id) {
      logger.log(
        "Twitch",
        `No Twitch user ID for ${userId}, can't fetch viewer count`
      );
      await updateUserParameter(userId, "current_viewers", 0);
      return 0;
    }

    // Get app access token for API call
    const appToken = await getAppAccessToken();
    const channelId = user.twitch_tokens.streamer.twitch_user_id;

    // Import axios
    const axios = (await import("axios")).default;

    // Get stream information
    const response = await axios.get(
      `https://api.twitch.tv/helix/streams?user_id=${channelId}`,
      {
        headers: {
          "Client-ID": await retrieveConfigValue("twitch.clientId"),
          Authorization: `Bearer ${appToken}`,
        },
      }
    );

    // Check if stream is live
    if (response.data.data && response.data.data.length > 0) {
      const viewerCount = response.data.data[0].viewer_count || 0;

      // Update user parameter with viewer count
      await updateUserParameter(userId, "current_viewers", viewerCount);
      logger.log(
        "Twitch",
        `Updated viewer count for ${userId}: ${viewerCount}`
      );

      return viewerCount;
    } else {
      // Stream is not live, set viewer count to 0
      await updateUserParameter(userId, "current_viewers", 0);
      return 0;
    }
  } catch (error) {
    logger.error("Twitch", `Error fetching viewer count: ${error.message}`);
    await updateUserParameter(userId, "current_viewers", 0);
    return 0;
  }
}

/**
 * Processes real-time chat messages from Twitch EventSub
 * @param {object} chatEvent - The chat event data from EventSub
 * @param {string} userId - The user ID
 * @returns {Promise<object>} - The processing result
 */
export async function processChatMessage(chatEvent, userId) {
  try {
    // Import the new chat handler
    const { handleChatMessage, normalizeMessageFormat } = await import(
      "./chat-handler.js"
    );

    // Normalize the EventSub message format
    const normalizedChat = normalizeMessageFormat(chatEvent);

    // Process through the central handler with autoRespond=true to enable Twitch chat responses
    return await handleChatMessage(normalizedChat, userId, true);
  } catch (error) {
    logger.error("Twitch", `Error processing chat message: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Sends a chat message to a Twitch channel using the bot account
 * @param {string} message - The message to send
 * @param {string} userId - The user ID
 * @returns {Promise<object>} - Result of the operation
 */
export async function sendChatMessage(message, userId) {
  try {
    const user = await returnAuthObject(userId);

    // Check if bot account is connected
    if (!user.twitch_tokens?.bot?.access_token) {
      logger.error(
        "Twitch",
        `No bot token for user ${userId}, can't send chat message`
      );
      return { success: false, error: "No bot token available" };
    }

    // Make sure we have a valid token
    const botToken = await refreshTwitchToken(userId, "bot");
    if (!botToken) {
      logger.error("Twitch", `Failed to refresh bot token for ${userId}`);
      return { success: false, error: "Failed to refresh bot token" };
    }

    // Check if we have the channel ID
    if (!user.twitch_tokens?.streamer?.twitch_user_id) {
      logger.error(
        "Twitch",
        `No streamer ID for ${userId}, can't determine chat channel`
      );
      return { success: false, error: "No streamer ID available" };
    }

    const channelId = user.twitch_tokens.streamer.twitch_user_id;

    // Import axios
    const axios = (await import("axios")).default;

    // Send chat message via Twitch API
    const response = await axios.post(
      `https://api.twitch.tv/helix/chat/messages`,
      {
        broadcaster_id: channelId,
        sender_id: user.twitch_tokens.bot.twitch_user_id,
        message: message,
      },
      {
        headers: {
          "Client-ID": await retrieveConfigValue("twitch.clientId"),
          Authorization: `Bearer ${botToken}`,
        },
      }
    );

    if (response.status === 200) {
      logger.log(
        "Twitch",
        `Sent chat message to ${user.twitch_name || user.user_name}'s channel`
      );
      return { success: true, message_id: response.data.message_id };
    } else {
      logger.error(
        "Twitch",
        `Failed to send chat message: ${response.status} ${response.statusText}`
      );
      return { success: false, error: `API returned ${response.status}` };
    }
  } catch (error) {
    logger.error("Twitch", `Error sending chat message: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Get the scopes associated with a user's token
 * @param {string} userId - The user ID
 * @param {string} tokenType - The token type (bot or streamer)
 * @returns {Promise<string[]>} - Array of scopes
 */
async function getUserScopes(userId, tokenType) {
  try {
    const user = await returnAuthObject(userId);

    // Check if token exists
    if (!user.twitch_tokens?.[tokenType]?.access_token) {
      logger.log(
        "Twitch",
        `No ${tokenType} access token found for user ${userId}`
      );
      return [];
    }

    // If we already have cached scopes, return them
    if (
      user.twitch_tokens[tokenType].scopes &&
      Array.isArray(user.twitch_tokens[tokenType].scopes)
    ) {
      return user.twitch_tokens[tokenType].scopes;
    }

    // Otherwise validate the token to get scopes
    const axios = (await import("axios")).default;

    try {
      const response = await axios.get("https://id.twitch.tv/oauth2/validate", {
        headers: {
          Authorization: `OAuth ${user.twitch_tokens[tokenType].access_token}`,
        },
      });

      if (response.data && response.data.scopes) {
        // Cache the scopes
        await updateUserParameter(
          userId,
          `twitch_tokens.${tokenType}.scopes`,
          response.data.scopes
        );
        return response.data.scopes;
      }

      return [];
    } catch (validationError) {
      // If we get a 401 error, the token is likely expired
      if (validationError.response && validationError.response.status === 401) {
        logger.log(
          "Twitch",
          `Token for ${userId} (${tokenType}) is invalid or expired. Attempting refresh...`
        );

        // Try to refresh the token
        if (user.twitch_tokens[tokenType].refresh_token) {
          try {
            const newToken = await refreshTwitchToken(userId, tokenType);

            if (newToken) {
              // Try validation again with the new token
              const freshUser = await returnAuthObject(userId);

              const retryResponse = await axios.get(
                "https://id.twitch.tv/oauth2/validate",
                {
                  headers: {
                    Authorization: `OAuth ${freshUser.twitch_tokens[tokenType].access_token}`,
                  },
                }
              );

              if (retryResponse.data && retryResponse.data.scopes) {
                // Cache the scopes
                await updateUserParameter(
                  userId,
                  `twitch_tokens.${tokenType}.scopes`,
                  retryResponse.data.scopes
                );
                return retryResponse.data.scopes;
              }
            }
          } catch (refreshError) {
            logger.error(
              "Twitch",
              `Failed to refresh token: ${refreshError.message}`
            );
          }
        }
      }

      // Log detailed error information
      if (validationError.response) {
        logger.error(
          "Twitch",
          `Token validation error: Status ${validationError.response.status}, Data: ${JSON.stringify(validationError.response.data)}`
        );
      } else {
        logger.error(
          "Twitch",
          `Token validation error: ${validationError.message}`
        );
      }

      return [];
    }
  } catch (error) {
    logger.error("Twitch", `Error getting user scopes: ${error.message}`);
    return [];
  }
}

/**
 * Create a single EventSub subscription
 * @param {string} userId - The user ID
 * @param {object} subscriptionConfig - The subscription configuration
 * @param {string} broadcasterId - The Twitch broadcaster ID
 * @returns {Promise<{success: boolean, id?: string, error?: string}>}
 */
async function createSubscription(userId, subscriptionConfig, broadcasterId) {
  try {
    const user = await returnAuthObject(userId);

    if (!user.twitch_tokens || !user.twitch_tokens.streamer) {
      return { success: false, error: "No streamer account connected" };
    }

    // Double-check webhook secret exists
    if (!user.twitch_tokens.streamer.webhook_secret) {
      // Try to create it one more time
      const newSecret = crypto.randomBytes(32).toString("hex");
      await updateUserParameter(
        userId,
        "twitch_tokens.streamer.webhook_secret",
        newSecret
      );
      // Refresh user
      const refreshedUser = await returnAuthObject(userId);
      if (!refreshedUser.twitch_tokens.streamer.webhook_secret) {
        return { success: false, error: "Could not create webhook secret" };
      }
    }

    // Validate broadcaster_user_id
    if (!broadcasterId) {
      logger.error("Twitch", `Missing broadcaster_user_id for user ${userId}`);
      return { success: false, error: "Missing broadcaster_user_id" };
    }

    // Always use app access token for EventSub subscriptions
    let accessToken = await getAppAccessToken();

    // Generate the condition based on subscription type and version
    const condition = subscriptionConfig.condition(broadcasterId);

    logger.log(
      "Twitch",
      `Creating ${subscriptionConfig.type} (v${subscriptionConfig.version}) subscription with condition: ${JSON.stringify(condition)} using app access token`
    );

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

    // Import axios if needed
    const axios = (await import("axios")).default;

    const response = await axios.post(
      "https://api.twitch.tv/helix/eventsub/subscriptions",
      subscriptionBody,
      {
        headers: {
          "Client-ID": await retrieveConfigValue("twitch.clientId"),
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Make sure subscriptions array exists
    if (!user.twitch_tokens.streamer.subscriptions) {
      await ensureParameterPath(userId, "twitch_tokens.streamer");
      await updateUserParameter(
        userId,
        "twitch_tokens.streamer.subscriptions",
        []
      );
    }

    // Save subscription ID
    const subscriptionId = response.data.data[0].id;

    // Get the current subscriptions array
    const currentUser = await returnAuthObject(userId);
    const subscriptions =
      currentUser.twitch_tokens.streamer.subscriptions || [];

    // Add new subscription and update
    subscriptions.push({
      id: subscriptionId,
      type: subscriptionConfig.type,
      version: subscriptionConfig.version,
      created_at: new Date().toISOString(),
    });

    await updateUserParameter(
      userId,
      "twitch_tokens.streamer.subscriptions",
      subscriptions
    );

    return {
      success: true,
      id: subscriptionId,
      version: subscriptionConfig.version,
    };
  } catch (error) {
    logger.error(
      "Twitch",
      `Error creating subscription ${subscriptionConfig.type}: ${error.message}`
    );

    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;

      logger.error(
        "Twitch",
        `Response status: ${status}, data: ${JSON.stringify(data)}`
      );

      // Handle specific error cases
      if (status === 400) {
        if (data.message) {
          return { success: false, error: `Bad request: ${data.message}` };
        }
        if (
          data.error === "Bad Request" &&
          data.message &&
          data.message.includes("condition.broadcaster_user_id")
        ) {
          return { success: false, error: "Invalid broadcaster ID" };
        }
      } else if (status === 401) {
        logger.log(
          "Twitch",
          `Token unauthorized, trying to get a new app token`
        );
        global.twitchAppToken = null;
        global.twitchAppTokenExpiry = null;
        return { success: false, error: "Unauthorized. Token refresh needed." };
      } else if (status === 403) {
        return {
          success: false,
          error: "Insufficient permissions. Check Twitch API credentials.",
        };
      } else if (status === 429) {
        return {
          success: false,
          error: "Rate limited by Twitch. Try again later.",
        };
      }
    }

    return { success: false, error: error.message };
  }
}

/**
 * Ensure token is valid and refresh if needed
 * @param {string} userId - The user ID
 * @param {string} tokenType - Either 'bot' or 'streamer'
 * @returns {Promise<boolean>}
 */
async function ensureValidToken(userId, tokenType) {
  try {
    const user = await returnAuthObject(userId);

    if (
      !user.twitch_tokens ||
      !user.twitch_tokens[tokenType] ||
      !user.twitch_tokens[tokenType].refresh_token
    ) {
      return false;
    }

    // Check if token is expired or expiring soon
    const now = Date.now();
    const tokenExpiry = user.twitch_tokens[tokenType].expires_at || 0;

    if (now >= tokenExpiry - 5 * 60 * 1000) {
      // Token is expired or expiring in next 5 minutes, refresh it
      return await refreshToken(userId, tokenType);
    }

    return true;
  } catch (error) {
    logger.error(
      "Twitch",
      `Error checking token for ${userId}: ${error.message}`
    );
    return false;
  }
}

/**
 * Refresh an expired token
 * @param {string} userId - The user ID
 * @param {string} tokenType - Either 'bot' or 'streamer'
 * @returns {Promise<boolean>}
 */
async function refreshToken(userId, tokenType) {
  try {
    const user = await returnAuthObject(userId);

    const response = await axios.post(
      "https://id.twitch.tv/oauth2/token",
      new URLSearchParams({
        client_id: await retrieveConfigValue("twitch.clientId"),
        client_secret: await retrieveConfigValue("twitch.clientSecret"),
        grant_type: "refresh_token",
        refresh_token: user.twitch_tokens[tokenType].refresh_token,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const { access_token, refresh_token, expires_in } = response.data;

    // Update token data
    await updateUserParameter(
      userId,
      `twitch_tokens.${tokenType}.access_token`,
      access_token
    );
    await updateUserParameter(
      userId,
      `twitch_tokens.${tokenType}.refresh_token`,
      refresh_token
    );
    await updateUserParameter(
      userId,
      `twitch_tokens.${tokenType}.expires_at`,
      Date.now() + expires_in * 1000
    );

    // Clear cached scopes as they might change with the new token
    await updateUserParameter(
      userId,
      `twitch_tokens.${tokenType}.scopes`,
      null
    );

    return true;
  } catch (error) {
    logger.error(
      "Twitch",
      `Error refreshing token for ${userId}: ${error.message}`
    );
    return false;
  }
}

/**
 * Get Twitch user ID for a user
 * @param {string} userId - The user ID
 * @param {string} tokenType - Either 'bot' or 'streamer'
 * @returns {Promise<string|null>}
 */
async function fetchTwitchUserId(userId, tokenType) {
  try {
    const user = await returnAuthObject(userId);

    // If we already have the ID, return it
    if (user.twitch_tokens?.[tokenType]?.twitch_user_id) {
      logger.log(
        "Twitch",
        `Using existing Twitch user ID for ${userId} (${tokenType}): ${user.twitch_tokens[tokenType].twitch_user_id}`
      );
      return user.twitch_tokens[tokenType].twitch_user_id;
    }

    // Check if we have an access token
    if (!user.twitch_tokens?.[tokenType]?.access_token) {
      logger.error(
        "Twitch",
        `No access token available for ${userId} (${tokenType})`
      );
      return null;
    }

    // Determine which username to use
    let twitchUsername;
    if (tokenType === "bot") {
      if (user.bot_twitch) {
        // Remove @ if present
        twitchUsername = user.bot_twitch.replace(/^@/, "");
      } else {
        logger.error("Twitch", `No bot_twitch username set for user ${userId}`);

        // Try to get user info without a login parameter (gets the authenticated user)
        logger.log(
          "Twitch",
          `Attempting to get authenticated user info for ${userId} (${tokenType})`
        );
        const axios = (await import("axios")).default;

        const response = await axios.get(`https://api.twitch.tv/helix/users`, {
          headers: {
            "Client-ID": await retrieveConfigValue("twitch.clientId"),
            Authorization: `Bearer ${user.twitch_tokens[tokenType].access_token}`,
          },
        });

        if (response.data.data && response.data.data.length > 0) {
          const twitchUserId = response.data.data[0].id;
          const twitchLogin = response.data.data[0].login;
          const twitchDisplayName = response.data.data[0].display_name;

          // Save all the Twitch user info
          await ensureParameterPath(userId, `twitch_tokens.${tokenType}`);
          await updateUserParameter(
            userId,
            `twitch_tokens.${tokenType}.twitch_user_id`,
            twitchUserId
          );
          await updateUserParameter(
            userId,
            `twitch_tokens.${tokenType}.twitch_login`,
            twitchLogin
          );
          await updateUserParameter(
            userId,
            `twitch_tokens.${tokenType}.twitch_display_name`,
            twitchDisplayName
          );

          logger.log(
            "Twitch",
            `Retrieved and saved Twitch user ID for ${userId} (${tokenType}): ${twitchUserId}`
          );
          return twitchUserId;
        }

        logger.error(
          "Twitch",
          `Failed to get user info without login parameter for ${userId} (${tokenType})`
        );
        return null;
      }
    } else {
      // tokenType === 'streamer'
      if (user.twitch_name) {
        twitchUsername = user.twitch_name;
      } else {
        logger.error(
          "Twitch",
          `No twitch_name username set for user ${userId}`
        );

        // Try to get user info without a login parameter (gets the authenticated user)
        logger.log(
          "Twitch",
          `Attempting to get authenticated user info for ${userId} (${tokenType})`
        );
        const axios = (await import("axios")).default;

        const response = await axios.get(`https://api.twitch.tv/helix/users`, {
          headers: {
            "Client-ID": await retrieveConfigValue("twitch.clientId"),
            Authorization: `Bearer ${user.twitch_tokens[tokenType].access_token}`,
          },
        });

        if (response.data.data && response.data.data.length > 0) {
          const twitchUserId = response.data.data[0].id;
          const twitchLogin = response.data.data[0].login;
          const twitchDisplayName = response.data.data[0].display_name;

          // Save all the Twitch user info
          await ensureParameterPath(userId, `twitch_tokens.${tokenType}`);
          await updateUserParameter(
            userId,
            `twitch_tokens.${tokenType}.twitch_user_id`,
            twitchUserId
          );
          await updateUserParameter(
            userId,
            `twitch_tokens.${tokenType}.twitch_login`,
            twitchLogin
          );
          await updateUserParameter(
            userId,
            `twitch_tokens.${tokenType}.twitch_display_name`,
            twitchDisplayName
          );

          logger.log(
            "Twitch",
            `Retrieved and saved Twitch user ID for ${userId} (${tokenType}): ${twitchUserId}`
          );
          return twitchUserId;
        }

        logger.error(
          "Twitch",
          `Failed to get user info without login parameter for ${userId} (${tokenType})`
        );
        return null;
      }
    }

    logger.log(
      "Twitch",
      `Looking up Twitch user ID for ${twitchUsername} (${userId}, ${tokenType})`
    );

    // Import axios if needed
    const axios = (await import("axios")).default;

    const response = await axios.get(
      `https://api.twitch.tv/helix/users?login=${twitchUsername}`,
      {
        headers: {
          "Client-ID": await retrieveConfigValue("twitch.clientId"),
          Authorization: `Bearer ${user.twitch_tokens[tokenType].access_token}`,
        },
      }
    );

    if (response.data.data && response.data.data.length > 0) {
      const twitchUserId = response.data.data[0].id;
      const twitchLogin = response.data.data[0].login;
      const twitchDisplayName = response.data.data[0].display_name;

      // Save all the Twitch user info
      await ensureParameterPath(userId, `twitch_tokens.${tokenType}`);
      await updateUserParameter(
        userId,
        `twitch_tokens.${tokenType}.twitch_user_id`,
        twitchUserId
      );
      await updateUserParameter(
        userId,
        `twitch_tokens.${tokenType}.twitch_login`,
        twitchLogin
      );
      await updateUserParameter(
        userId,
        `twitch_tokens.${tokenType}.twitch_display_name`,
        twitchDisplayName
      );

      logger.log(
        "Twitch",
        `Retrieved and saved Twitch user ID for ${userId} (${tokenType}): ${twitchUserId}`
      );
      return twitchUserId;
    } else {
      logger.error(
        "Twitch",
        `No user found for username ${twitchUsername} (${userId}, ${tokenType})`
      );
      return null;
    }
  } catch (error) {
    logger.error(
      "Twitch",
      `Error fetching Twitch user ID for ${userId} (${tokenType}): ${error.message}`
    );

    // Log response error details if available
    if (error.response) {
      logger.error(
        "Twitch",
        `Response status: ${error.response.status}, data: ${JSON.stringify(error.response.data)}`
      );

      // Handle token issues
      if (error.response.status === 401) {
        logger.log(
          "Twitch",
          `Attempting to refresh token for ${userId} (${tokenType})`
        );
        const refreshed = await refreshToken(userId, tokenType);
        if (refreshed) {
          logger.log("Twitch", `Token refreshed, retrying user ID lookup`);

          // Get fresh user object with new token
          const refreshedUser = await returnAuthObject(userId);

          // Try the request again with the fresh token
          try {
            const axios = (await import("axios")).default;
            const retryResponse = await axios.get(
              `https://api.twitch.tv/helix/users`,
              {
                headers: {
                  "Client-ID": await retrieveConfigValue("twitch.clientId"),
                  Authorization: `Bearer ${refreshedUser.twitch_tokens[tokenType].access_token}`,
                },
              }
            );

            if (retryResponse.data.data && retryResponse.data.data.length > 0) {
              const twitchUserId = retryResponse.data.data[0].id;
              const twitchLogin = retryResponse.data.data[0].login;
              const twitchDisplayName = retryResponse.data.data[0].display_name;

              // Save all the Twitch user info
              await updateUserParameter(
                userId,
                `twitch_tokens.${tokenType}.twitch_user_id`,
                twitchUserId
              );
              await updateUserParameter(
                userId,
                `twitch_tokens.${tokenType}.twitch_login`,
                twitchLogin
              );
              await updateUserParameter(
                userId,
                `twitch_tokens.${tokenType}.twitch_display_name`,
                twitchDisplayName
              );

              logger.log(
                "Twitch",
                `Successfully retrieved Twitch user ID after token refresh: ${twitchUserId}`
              );
              return twitchUserId;
            }
          } catch (retryError) {
            logger.error(
              "Twitch",
              `Failed retry attempt after token refresh: ${retryError.message}`
            );
          }
        }
      }
    }

    return null;
  }
}

/**
 * Process an EventSub notification and map it to our internal format
 * @param {string} eventType - The EventSub event type
 * @param {object} eventData - The event data from Twitch
 * @param {string} userId - The user ID
 * @param {string} eventVersion - The version of the event
 * @returns {Promise<object>} - The processed event
 */
export async function processEventSubNotification(
  eventType,
  eventData,
  userId,
  eventVersion = "1"
) {
  try {
    // Import the existing event handling system
    const { respondToEvent } = await import("./ai-logic.js");

    // Map EventSub event format to internal format
    const mappedEvent = mapEventSubToInternalFormat(
      eventType,
      eventData,
      eventVersion
    );

    // Log the processing
    logger.log(
      "Twitch",
      `Processing ${eventType} (v${eventVersion}) event for user ${userId}`
    );

    // Get response from AI system
    const aiResponse = await respondToEvent(mappedEvent, userId);

    // Check if we have a valid response
    if (aiResponse && aiResponse.response) {
      // Send the response to Twitch chat
      const chatResult = await sendChatMessage(aiResponse.response, userId);

      if (chatResult.success) {
        logger.log(
          "Twitch",
          `Sent response to ${eventType} event to chat: ${aiResponse.response.substring(0, 50)}...`
        );
      } else {
        logger.error(
          "Twitch",
          `Failed to send ${eventType} response to chat: ${chatResult.error}`
        );
      }

      // Return both AI response and chat sending result
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
 * Enriches EventSub data with additional broadcaster information
 * @param {string} eventType - The type of event
 * @param {object} eventData - The basic EventSub data
 * @param {string} userId - Enspira user ID
 * @returns {Promise<object>} - Enriched event data
 */
export async function enrichEventData(eventType, eventData, userId) {
  try {
    // Get app access token for API calls
    const appToken = await getAppAccessToken();
    const user = await returnAuthObject(userId);

    // Determine which broadcaster ID we need to fetch data for
    let targetId;
    if (eventType === "channel.raid") {
      targetId = eventData.from_broadcaster_user_id;
    } else if (eventType === "channel.shoutout.create") {
      targetId = eventData.to_broadcaster_user_id;
    } else {
      return eventData; // No enrichment needed
    }

    // Prepare API call configurations
    const channelConfig = {
      method: "get",
      url: `https://api.twitch.tv/helix/channels?broadcaster_id=${targetId}`,
      headers: {
        "Client-ID": await retrieveConfigValue("twitch.clientId"),
        Authorization: `Bearer ${appToken}`,
      },
    };

    const streamConfig = {
      method: "get",
      url: `https://api.twitch.tv/helix/streams?user_id=${targetId}`,
      headers: {
        "Client-ID": await retrieveConfigValue("twitch.clientId"),
        Authorization: `Bearer ${appToken}`,
      },
    };

    const userConfig = {
      method: "get",
      url: `https://api.twitch.tv/helix/users?id=${targetId}`,
      headers: {
        "Client-ID": await retrieveConfigValue("twitch.clientId"),
        Authorization: `Bearer ${appToken}`,
      },
    };

    const followConfig = {
      method: "get",
      url: `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${user.twitch_tokens?.streamer?.twitch_user_id}&user_id=${targetId}`,
      headers: {
        "Client-ID": await retrieveConfigValue("twitch.clientId"),
        Authorization: `Bearer ${appToken}`,
      },
    };

    // Execute API calls in parallel with rate limiting
    const [channelInfo, streamInfo, userData, followData] = await Promise.all([
      callTwitchAPI(channelConfig),
      callTwitchAPI(streamConfig),
      callTwitchAPI(userConfig),
      callTwitchAPI(followConfig).catch((e) => ({ data: { total: 0 } })),
    ]);

    // Check for affiliate/partner status (based on badges)
    if (userData.data.data[0]?.broadcaster_type === "affiliate") {
      enriched.isAffiliate = true; // enriched is undefined here
      enriched.isPartner = false;
    } else if (userData.data.data[0]?.broadcaster_type === "partner") {
      enriched.isAffiliate = false;
      enriched.isPartner = true;
    } else {
      enriched.isAffiliate = false;
      enriched.isPartner = false;
    }

    // Check if target is subbed or is a mod (requires specific API calls with user tokens)
    if (user.twitch_tokens?.streamer?.access_token) {
      try {
        // Check if target is a moderator
        const modResponse = await axios.get(
          `https://api.twitch.tv/helix/moderation/moderators?broadcaster_id=${user.twitch_tokens.streamer.twitch_user_id}&user_id=${targetId}`,
          {
            headers: {
              "Client-ID": await retrieveConfigValue("twitch.clientId"),
              Authorization: `Bearer ${user.twitch_tokens.streamer.access_token}`,
            },
          }
        );

        enriched.isMod = modResponse.data.data.length > 0;

        // Check subscription status (if the shoutout target is subscribed to the streamer)
        const subResponse = await axios
          .get(
            `https://api.twitch.tv/helix/subscriptions?broadcaster_id=${user.twitch_tokens.streamer.twitch_user_id}&user_id=${targetId}`,
            {
              headers: {
                "Client-ID": await retrieveConfigValue("twitch.clientId"),
                Authorization: `Bearer ${user.twitch_tokens.streamer.access_token}`,
              },
            }
          )
          .catch((e) => ({ data: { data: [] } }));

        enriched.isSubbed = subResponse.data.data.length > 0;
      } catch (error) {
        enriched.isMod = false;
        enriched.isSubbed = false;
      }
    }

    return enriched;
  } catch (error) {
    logger.error("Twitch", `Error enriching data: ${error.message}`);
    return {}; // Return empty object on error
  }
}

/**
 * Convert EventSub format to our internal format used by the AI
 * @param {string} eventType - The EventSub event type
 * @param {object} eventData - The event data from Twitch
 * @param {string} version - The version of the event
 * @returns {object} - The mapped event in our internal format
 */
function mapEventSubToInternalFormat(eventType, eventData, version = "1") {
  // Create base event object
  let mappedEvent = { eventType: null, eventData: {} };

  // Map based on event type and version
  switch (eventType) {
    case "channel.update":
      mappedEvent.eventType = "game_change";
      mappedEvent.eventData = {
        game: eventData.category_name || "",
        title: eventData.title || "",
      };
      break;
    case "channel.chat.message":
      mappedEvent.eventType = "chat";
      mappedEvent.eventData = {
        user: eventData.chatter.user_name,
        user_id: eventData.chatter.user_id,
        message: eventData.message.text,
        is_first: eventData.message.is_first || false,
        chatter_is_broadcaster:
          eventData.chatter.user_id === eventData.broadcaster_user_id,
        chatter_is_moderator:
          eventData.chatter.badges?.some(
            (badge) => badge.set_id === "moderator"
          ) || false,
        chatter_is_subscriber:
          eventData.chatter.badges?.some(
            (badge) => badge.set_id === "subscriber"
          ) || false,
        fragments: eventData.message.fragments || [],
        emotes:
          eventData.message.fragments
            ?.filter((frag) => frag.type === "emote")
            .map((emote) => ({
              id: emote.id,
              name: emote.text,
            })) || [],
      };
      break;
    case "channel.follow":
      mappedEvent.eventType = "follow";

      // Handle different versions
      if (version === "2") {
        // v2 format has different fields
        mappedEvent.eventData = {
          username: eventData.user_name || "",
          userId: eventData.user_id || "",
          followed_at: eventData.followed_at || new Date().toISOString(),
        };
      } else {
        // v1 format (legacy)
        mappedEvent.eventData = {
          username: eventData.user_name || "",
          userId: eventData.user_id || "",
          followed_at: eventData.followed_at || new Date().toISOString(),
        };
      }
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

    case "channel.subscription.message":
      mappedEvent.eventType = "sub";
      mappedEvent.eventData = {
        subType: "resub",
        user: eventData.user_name || "",
        subTier: mapTier(eventData.tier || "1000"),
        streak: eventData.streak_months || 1,
        tenure: eventData.cumulative_months || 1,
        sharedChat: eventData.message ? eventData.message.text : "",
      };
      break;

    case "channel.cheer":
      mappedEvent.eventType = "dono";
      mappedEvent.eventData = {
        donoType: "bits",
        donoFrom: eventData.is_anonymous
          ? "Anonymous"
          : eventData.user_name || "",
        donoAmt: eventData.bits || 0,
        donoMessage: eventData.message || "",
      };
      break;

    case "channel.hype_train.begin":
      mappedEvent.eventType = "hype_start";
      mappedEvent.eventData = {
        level: eventData.level || 1,
        total: eventData.total || 0,
        startedAt: eventData.started_at || new Date().toISOString(),
        expiresAt: eventData.expires_at || "",
        percent: eventData.goal ? eventData.progress / eventData.goal : 0,
        topBitsUser:
          getTopContributor(eventData, "BITS")?.user_name || "Unknown",
        topBitsAmt: getTopContributor(eventData, "BITS")?.total || 0,
        topSubUser:
          getTopContributor(eventData, "SUBSCRIPTION")?.user_name || "Unknown",
        topSubTotal: getTopContributor(eventData, "SUBSCRIPTION")?.total || 0,
      };
      break;

    case "channel.hype_train.progress":
      mappedEvent.eventType = "hype_update";
      mappedEvent.eventData = {
        level: eventData.level || 1,
        total: eventData.total || 0,
        startedAt: eventData.started_at || new Date().toISOString(),
        expiresAt: eventData.expires_at || "",
        percent: eventData.goal ? eventData.progress / eventData.goal : 0,
        contributors: eventData.total_users || 0,
        isGolden: false, // EventSub doesn't have this info
        topBitsUser:
          getTopContributor(eventData, "BITS")?.user_name || "Unknown",
        topBitsAmt: getTopContributor(eventData, "BITS")?.total || 0,
        topSubUser:
          getTopContributor(eventData, "SUBSCRIPTION")?.user_name || "Unknown",
        topSubTotal: getTopContributor(eventData, "SUBSCRIPTION")?.total || 0,
      };
      break;

    case "channel.hype_train.end":
      mappedEvent.eventType = "hype_end";
      mappedEvent.eventData = {
        level: eventData.level || 1,
        total: eventData.total || 0,
        startedAt: eventData.started_at || new Date().toISOString(),
        percent: eventData.goal ? eventData.progress / eventData.goal : 0,
        contributors: eventData.total_users || 0,
        isGolden: false, // EventSub doesn't have this info
        topBitsUser:
          getTopContributor(eventData, "BITS")?.user_name || "Unknown",
        topBitsAmt: getTopContributor(eventData, "BITS")?.total || 0,
        topSubUser:
          getTopContributor(eventData, "SUBSCRIPTION")?.user_name || "Unknown",
        topSubTotal: getTopContributor(eventData, "SUBSCRIPTION")?.total || 0,
      };
      break;

    case "stream.online":
      mappedEvent.eventType = "stream_online";
      mappedEvent.eventData = {
        startTime: eventData.started_at || new Date().toISOString(),
        type: eventData.type || "live", // 'live' or 'playlist' or 'watch_party' or 'premiere' or 'rerun'
      };
      break;

    case "stream.offline":
      mappedEvent.eventType = "stream_offline";
      mappedEvent.eventData = {
        endTime: new Date().toISOString(), // EventSub doesn't provide this, so use current time
      };
      break;
    case "channel.raid":
      mappedEvent.eventType = "raid";
      mappedEvent.eventData = {
        username: eventData.from_broadcaster_user_name || "",
        viewers: eventData.viewers || 0,
        accountAge: "Unknown", // Will need separate API call
        isFollowing: false, // Will need separate API call
        lastGame: "Unknown", // Will need separate API call
      };
      break;

    case "channel.charity_campaign.donate":
      mappedEvent.eventType = "dono";
      mappedEvent.eventData = {
        donoType: "charity",
        donoFrom: eventData.user_name || "Anonymous",
        donoAmt: eventData.amount.value || 0,
        forCharity: eventData.charity_name || "Unknown Charity",
        donoMessage: eventData.message || "",
      };
      break;

    case "channel.channel_points_custom_reward_redemption.add":
      mappedEvent.eventType = "reward";
      mappedEvent.eventData = {
        username: eventData.user_name || "",
        rewardTitle: eventData.reward.title || "Unknown Reward",
        rewardCost: eventData.reward.cost || 0,
        userInput: eventData.user_input || "",
      };
      break;

    case "channel.commercial.begin":
      mappedEvent.eventType = "ad";
      mappedEvent.eventData = {
        minutesLeft: eventData.duration / 60 || 0,
      };
      break;

    case "channel.shoutout.create":
      mappedEvent.eventType = "shoutout";
      mappedEvent.eventData = {
        user: eventData.to_broadcaster_user_name || "",
        user_id: eventData.to_broadcaster_user_id || "",
        accountAge: "Unknown", // Requires separate API call
        game: "Unknown", // Requires separate API call
        lastActive: "Unknown", // Requires separate API call
        streamTitle: "Unknown", // Requires separate API call
        isMod: false,
        isAffiliate: false,
        isPartner: false,
        isSubbed: false,
      };
      break;

    case "channel.chat.notification":
      // For summary and trivia events that come through chat
      if (
        eventData.message.text &&
        eventData.message.text.startsWith("!summary")
      ) {
        mappedEvent.eventType = "summary";
      } else if (
        eventData.message.text &&
        eventData.message.text.startsWith("!trivia")
      ) {
        mappedEvent.eventType = "trivia";
      }
      break;

    default:
      // Direct passthrough for unmapped types
      mappedEvent.eventType = eventType
        .replace("channel.", "")
        .replace("stream.", "");
      mappedEvent.eventData = JSON.parse(JSON.stringify(eventData)); // Create a safe copy
  }

  return mappedEvent;
}

/**
 * Helper function to get top contributor from hype train events
 * @param {object} eventData - The hype train event data
 * @param {string} type - The contribution type to look for
 * @returns {object|null} - The top contributor or null
 */
function getTopContributor(eventData, type) {
  if (
    !eventData ||
    !eventData.top_contributions ||
    !Array.isArray(eventData.top_contributions)
  ) {
    return null;
  }

  return eventData.top_contributions.find(
    (contributor) => contributor.type === type
  );
}

/**
 * Updates stream information for all users
 * @returns {Promise<{updated: number, errors: number}>}
 */
export async function updateAllStreamInfo() {
  try {
    // Get all users
    const users = await returnAPIKeys();
    let updatedCount = 0;
    let errorCount = 0;

    // Process each user
    for (const user of users) {
      try {
        // Skip users without Twitch integration
        if (!user.twitch_tokens?.streamer?.twitch_user_id) {
          continue;
        }

        // Update stream info
        await fetchStreamInfo(user.user_id);
        updatedCount++;
      } catch (userError) {
        errorCount++;
        logger.error(
          "Twitch",
          `Error updating stream info for ${user.user_id}: ${userError.message}`
        );
      }

      // Add a small delay between API calls to avoid rate limits
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    logger.log(
      "Twitch",
      `Updated stream info for ${updatedCount} users, with ${errorCount} errors`
    );
    return { updated: updatedCount, errors: errorCount };
  } catch (error) {
    logger.error("Twitch", `Error in updateAllStreamInfo: ${error.message}`);
    return { updated: 0, errors: 1 };
  }
}

export function setupTwitchCronJobs() {
  // Update stream info (includes viewer count) every minute
  cron.schedule("*/1 * * * *", async () => {
    try {
      await updateAllStreamInfo();
    } catch (error) {
      logger.error("Cron", `Error in stream info update job: ${error.message}`);
    }
  });

  // Update follower count every 5 minutes even for offline streams
  cron.schedule("*/5 * * * *", async () => {
    try {
      const users = await returnAPIKeys();

      for (const user of users) {
        try {
          // Skip users without Twitch integration
          if (!user.twitch_tokens?.streamer?.twitch_user_id) {
            continue;
          }

          const channelId = user.twitch_tokens.streamer.twitch_user_id;
          const appToken = await getAppAccessToken();

          // Just update follower count
          await fetchFollowerCount(user.user_id, channelId, appToken);
        } catch (userError) {
          logger.error(
            "Twitch",
            `Error updating follower count for ${user.user_id}: ${userError.message}`
          );
        }

        // Add a small delay between API calls to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      logger.log("Twitch", "Completed follower count update for all users");
    } catch (error) {
      logger.error(
        "Cron",
        `Error in follower count update job: ${error.message}`
      );
    }
  });

  logger.log("System", "Twitch cron jobs initialized");
}

async function refreshTwitchToken(userId, tokenType = "streamer") {
  try {
    const user = await returnAuthObject(userId);

    // Validate token type
    if (tokenType !== "bot" && tokenType !== "streamer") {
      logger.log("Twitch", `Invalid token type: ${tokenType}`);
      return false;
    }

    // Get the tokens for the specified type
    const tokens = user.twitch_tokens?.[tokenType];

    if (!tokens || !tokens.refresh_token) {
      logger.log(
        "Twitch",
        `No refresh token found for ${tokenType} account of user ${userId}`
      );
      return false;
    }

    // Check if token is expired or close to expiring (within 10 minutes)
    const isExpired =
      !tokens.expires_at || Date.now() > tokens.expires_at - 10 * 60 * 1000;

    if (!isExpired) {
      return tokens.access_token; // Return existing token if still valid
    }

    // Import axios if needed
    const axios = (await import("axios")).default;

    // Refresh the token
    const response = await axios.post("https://id.twitch.tv/oauth2/token", {
      client_id: await retrieveConfigValue("twitch.clientId"),
      client_secret: await retrieveConfigValue("twitch.clientSecret"),
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });

    const { access_token, refresh_token, expires_in } = response.data;

    // Update token in user record
    await updateUserParameter(userId, `twitch_tokens.${tokenType}`, {
      ...tokens, // Keep existing data like user_id
      access_token,
      refresh_token,
      expires_at: Date.now() + expires_in * 1000,
    });

    logger.log("Twitch", `Refreshed ${tokenType} token for user ${userId}`);
    return access_token;
  } catch (error) {
    logger.log(
      "Twitch",
      `Failed to refresh ${tokenType} token: ${error.message}`
    );
    return false;
  }
}

/**
 * Helper for tier mapping
 * @param {string} tier - The Twitch tier string
 * @returns {string} - Our internal tier format
 */
function mapTier(tier) {
  switch (tier) {
    case "1000":
      return "tier 1";
    case "2000":
      return "tier 2";
    case "3000":
      return "tier 3";
    default:
      return "prime";
  }
}
