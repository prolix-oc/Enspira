/**
 * Twitch EventSub Manager
 * Handles EventSub subscriptions, API rate limiting, and event processing
 */

import crypto from 'crypto';
import axios, { type AxiosResponse, type AxiosRequestConfig } from 'axios';
import cron from 'node-cron';

import { logger } from '../../core/logger.js';
import { retrieveConfigValue } from '../../core/config.js';
import { getEventBus } from '../../core/event-bus.js';
import type { EnspiraEvent, EnspiraEventType } from '../../types/extension.types.js';
import {
  returnAPIKeys,
  returnAuthObject,
  updateUserParameter,
  ensureParameterPath,
} from '../../core/api-helper.js';

import type {
  RateLimitBucket,
  RetryConfig,
  TokenCacheEntry,
  ScopesCacheEntry,
  APIUsageStats,
  SubscriptionConfig,
  SubscriptionRecord,
  SubscriptionCreationResult,
  SubscriptionCleanupResult,
  SubscriptionStatusResult,
  StreamInfoResult,
  ChatMessageResult,
  StreamUpdateResult,
  EventSubBatchResult,
  InternalTwitchEvent,
  EventSubRegistrationResult,
} from '../../types/twitch.types.js';
import type { User } from '../../types/user.types.js';

// ==================== TWITCH API MANAGER CLASS ====================

class TwitchAPIManager {
  private buckets: Map<string, RateLimitBucket>;
  private maxBuckets: number;
  private endpointCounts: Map<string, number>;
  private lastCleanup: number;
  private cleanupInterval: number;
  private defaultRetryConfig: RetryConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null;

  constructor() {
    this.buckets = new Map();
    this.maxBuckets = 100;
    this.endpointCounts = new Map();
    this.lastCleanup = Date.now();
    this.cleanupInterval = 60 * 60 * 1000; // 1 hour
    this.cleanupTimer = null;

    this.defaultRetryConfig = {
      maxRetries: 3,
      initialDelay: 500,
      maxDelay: 10000,
      factor: 2,
      jitter: true,
    };

    this.startCleanupTimer();
  }

  /**
   * Periodic cleanup to prevent memory leaks
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupOldData();
    }, this.cleanupInterval);
  }

  /**
   * Clean up old rate limit data and endpoint counts
   */
  private cleanupOldData(): void {
    const now = Date.now();

    // Clean up expired buckets
    for (const [key, bucket] of this.buckets.entries()) {
      if (now > bucket.resetAt + 300000) {
        this.buckets.delete(key);
      }
    }

    // Reset endpoint counts periodically
    if (this.endpointCounts.size > 1000) {
      this.endpointCounts.clear();
      logger.log('Twitch', 'Cleaned up endpoint usage statistics');
    }

    // Ensure we don't exceed max buckets
    if (this.buckets.size > this.maxBuckets) {
      const oldestKeys = Array.from(this.buckets.keys()).slice(0, 10);
      oldestKeys.forEach((key) => this.buckets.delete(key));
    }

    this.lastCleanup = now;
  }

  /**
   * Get or create rate limit bucket
   */
  private getBucket(bucketType: string): RateLimitBucket {
    if (!this.buckets.has(bucketType)) {
      const bucketDefaults: Record<string, RateLimitBucket> = {
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
      };

      const bucket = bucketDefaults[bucketType] || {
        points: 100,
        remaining: 100,
        resetAt: Date.now() + 60000,
        perMinute: 100,
      };

      this.buckets.set(bucketType, bucket);
    }

    return this.buckets.get(bucketType)!;
  }

  /**
   * Make a rate-limited API call with automatic retries
   */
  async makeRequest<T = unknown>(
    config: AxiosRequestConfig,
    bucketType: string = 'helix',
    retryOptions: Partial<RetryConfig> = {}
  ): Promise<AxiosResponse<T>> {
    const endpoint = this.getEndpointFromUrl(config.url || '');
    this.trackEndpointUsage(endpoint);

    const retryConfig: RetryConfig = { ...this.defaultRetryConfig, ...retryOptions };
    const bucket = this.getBucket(bucketType);

    await this.checkRateLimits(bucket);

    let lastError: Error | null = null;
    let delay = retryConfig.initialDelay;

    for (let attempt = 0; attempt < retryConfig.maxRetries; attempt++) {
      try {
        const response = await axios({
          ...config,
          timeout: config.timeout || 15000,
        });

        this.updateRateLimits(bucket, response.headers as Record<string, string>);
        return response as AxiosResponse<T>;
      } catch (error) {
        lastError = error as Error;
        const axiosError = error as { response?: { status: number; headers: Record<string, string> }; code?: string };

        if (axiosError.response?.status === 429) {
          const retryAfter = parseInt(axiosError.response.headers['retry-after'] || '0') * 1000;
          delay = Math.max(retryAfter, this.calculateBackoff(attempt, retryConfig));

          logger.log('Twitch', `Rate limited on ${endpoint}. Retrying in ${delay}ms`);

          bucket.remaining = 0;
          bucket.resetAt = Date.now() + (retryAfter || delay);
        } else if (this.isRetryableError(error)) {
          delay = this.calculateBackoff(attempt, retryConfig);
          logger.log('Twitch', `Retryable error on ${endpoint}: ${lastError.message}. Retry ${attempt + 1}/${retryConfig.maxRetries} in ${delay}ms`);
        } else {
          logger.log('Twitch', `Non-retryable error on ${endpoint}: ${lastError.message}`);
          throw error;
        }

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
  private calculateBackoff(attempt: number, config: RetryConfig): number {
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
  private isRetryableError(error: unknown): boolean {
    const axiosError = error as { code?: string; response?: { status: number } };

    if (['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND'].includes(axiosError.code || '')) {
      return true;
    }

    if (axiosError.response) {
      const status = axiosError.response.status;
      return status >= 500 || status === 429;
    }

    return false;
  }

  /**
   * Update rate limit info from response headers
   */
  private updateRateLimits(bucket: RateLimitBucket, headers: Record<string, string>): void {
    if (!headers) return;

    const remaining = headers['ratelimit-remaining'];
    const reset = headers['ratelimit-reset'];
    const limit = headers['ratelimit-limit'];

    if (remaining !== undefined) bucket.remaining = parseInt(remaining);
    if (limit !== undefined) bucket.points = parseInt(limit);
    if (reset !== undefined) bucket.resetAt = parseInt(reset) * 1000;
  }

  /**
   * Wait if we're close to hitting rate limits
   */
  private async checkRateLimits(bucket: RateLimitBucket): Promise<void> {
    const now = Date.now();

    if (now > bucket.resetAt) {
      bucket.remaining = bucket.points;
      bucket.resetAt = now + 60000;
      return;
    }

    if (bucket.remaining < bucket.points * 0.1) {
      const timeToReset = Math.max(0, bucket.resetAt - now);
      logger.log('Twitch', `Approaching rate limit, delaying request by ${timeToReset}ms`);

      await new Promise((resolve) => setTimeout(resolve, timeToReset));
      bucket.remaining = bucket.points;
      bucket.resetAt = now + 60000;
    }

    bucket.remaining--;
  }

  /**
   * Extract endpoint from URL for tracking
   */
  private getEndpointFromUrl(url: string): string {
    try {
      const parsedUrl = new URL(url);
      const segments = parsedUrl.pathname.split('/').filter((s) => s);
      return segments.slice(0, 2).join('/');
    } catch {
      return url;
    }
  }

  /**
   * Track usage per endpoint for analytics
   */
  private trackEndpointUsage(endpoint: string): void {
    const count = this.endpointCounts.get(endpoint) || 0;
    this.endpointCounts.set(endpoint, count + 1);
  }

  /**
   * Get usage statistics
   */
  getUsageStats(): APIUsageStats {
    return {
      buckets: Object.fromEntries(this.buckets),
      endpoints: Object.fromEntries(this.endpointCounts),
    };
  }
}

// ==================== SUBSCRIPTION TYPES ====================

const SUBSCRIPTION_TYPES: SubscriptionConfig[] = [
  // Essential events - high priority
  {
    type: 'channel.chat.message',
    version: '1',
    condition: (broadcasterId) => ({
      broadcaster_user_id: broadcasterId,
      user_id: broadcasterId,
    }),
    requiredScopes: ['channel:moderate'],
    tokenType: 'app',
    priority: 'high',
  },
  {
    type: 'channel.follow',
    version: '2',
    condition: (broadcasterId) => ({
      broadcaster_user_id: broadcasterId,
      moderator_user_id: broadcasterId,
    }),
    requiredScopes: ['moderator:read:followers'],
    tokenType: 'app',
    priority: 'high',
  },
  {
    type: 'channel.subscribe',
    version: '1',
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ['channel:read:subscriptions'],
    tokenType: 'app',
    priority: 'high',
  },
  {
    type: 'channel.subscription.gift',
    version: '1',
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ['channel:read:subscriptions'],
    tokenType: 'app',
    priority: 'high',
  },
  // Medium priority events
  {
    type: 'channel.cheer',
    version: '1',
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ['bits:read'],
    tokenType: 'app',
    priority: 'medium',
  },
  {
    type: 'channel.raid',
    version: '1',
    condition: (broadcasterId) => ({ to_broadcaster_user_id: broadcasterId }),
    requiredScopes: [],
    tokenType: 'app',
    priority: 'medium',
  },
  {
    type: 'stream.online',
    version: '1',
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: [],
    tokenType: 'app',
    priority: 'medium',
  },
  {
    type: 'stream.offline',
    version: '1',
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: [],
    tokenType: 'app',
    priority: 'medium',
  },
  // Additional events - lower priority
  {
    type: 'channel.update',
    version: '2',
    condition: (broadcasterId) => ({
      broadcaster_user_id: broadcasterId,
      moderator_user_id: broadcasterId,
    }),
    requiredScopes: ['channel:read:stream_key'],
    tokenType: 'app',
    priority: 'low',
  },
  {
    type: 'channel.subscription.message',
    version: '1',
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ['channel:read:subscriptions'],
    tokenType: 'app',
    priority: 'low',
  },
  {
    type: 'channel.channel_points_custom_reward_redemption.add',
    version: '1',
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
    requiredScopes: ['channel:read:redemptions'],
    tokenType: 'app',
    priority: 'low',
  },
];

// ==================== CACHING ====================

const tokenCache = new Map<string, TokenCacheEntry | ScopesCacheEntry>();
const TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ==================== SINGLETON INSTANCE ====================

const twitchAPI = new TwitchAPIManager();

// ==================== EXPORTED FUNCTIONS ====================

/**
 * Export wrapper function for all Twitch API calls
 */
export async function callTwitchAPI<T = unknown>(
  config: AxiosRequestConfig,
  bucketType: string = 'helix',
  retryOptions: Partial<RetryConfig> = {}
): Promise<AxiosResponse<T>> {
  return twitchAPI.makeRequest<T>(config, bucketType, retryOptions);
}

/**
 * Cached app access token with automatic refresh
 */
export async function getAppAccessToken(): Promise<string> {
  const cacheKey = 'app_token';
  const cached = tokenCache.get(cacheKey) as TokenCacheEntry | undefined;

  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  try {
    logger.log('Twitch', 'Getting new app access token');

    const clientId = await retrieveConfigValue<string>('twitch.clientId');
    const clientSecret = await retrieveConfigValue<string>('twitch.clientSecret');

    if (!clientId || !clientSecret) {
      throw new Error('Missing Twitch client ID or secret in configuration');
    }

    const response = await axios.post(
      'https://id.twitch.tv/oauth2/token',
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      }
    );

    const { access_token, expires_in } = response.data as { access_token: string; expires_in: number };
    const expiresAt = Date.now() + expires_in * 900; // 90% of expiry time

    tokenCache.set(cacheKey, {
      token: access_token,
      expiresAt,
    });

    logger.log('Twitch', 'Successfully obtained app access token');
    return access_token;
  } catch (error) {
    const err = error as Error;
    logger.log('Twitch', `Failed to get app access token: ${err.message}`);
    throw error;
  }
}

/**
 * Enhanced token refresh with proper error handling and caching
 */
async function ensureValidToken(userId: string, tokenType: 'streamer' | 'bot'): Promise<string | false> {
  const cacheKey = `${userId}_${tokenType}`;
  const cached = tokenCache.get(cacheKey) as TokenCacheEntry | undefined;

  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  try {
    const user = await returnAuthObject(userId);
    if (!user) {
      return false;
    }
    const twitchTokens = user.twitch_tokens;

    const tokenData = twitchTokens?.[tokenType];
    if (!tokenData?.refresh_token) {
      return false;
    }
    const now = Date.now();
    const bufferTime = 5 * 60 * 1000;

    if (tokenData.access_token && tokenData.expires_at && now < tokenData.expires_at - bufferTime) {
      tokenCache.set(cacheKey, {
        token: tokenData.access_token,
        expiresAt: tokenData.expires_at - bufferTime,
      });
      return tokenData.access_token;
    }

    const clientId = await retrieveConfigValue<string>('twitch.clientId');
    const clientSecret = await retrieveConfigValue<string>('twitch.clientSecret');

    const response = await axios.post(
      'https://id.twitch.tv/oauth2/token',
      new URLSearchParams({
        client_id: clientId || '',
        client_secret: clientSecret || '',
        grant_type: 'refresh_token',
        refresh_token: tokenData.refresh_token || '',
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      }
    );

    const { access_token, refresh_token, expires_in } = response.data as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    const expiresAt = Date.now() + expires_in * 1000;

    await updateUserParameter(userId, `twitch_tokens.${tokenType}`, {
      ...tokenData,
      access_token,
      refresh_token,
      expires_at: expiresAt,
      scopes: null,
    });

    tokenCache.set(cacheKey, {
      token: access_token,
      expiresAt: expiresAt - bufferTime,
    });

    logger.log('Twitch', `Refreshed ${tokenType} token for user ${userId}`);
    return access_token;
  } catch (error) {
    const err = error as Error;
    logger.log('Twitch', `Failed to refresh ${tokenType} token: ${err.message}`);
    tokenCache.delete(cacheKey);
    return false;
  }
}

/**
 * Optimized subscription fetching with proper error handling
 */
async function fetchCurrentTwitchSubscriptions(userId: string): Promise<SubscriptionRecord[]> {
  try {
    const appToken = await getAppAccessToken();
    const clientId = await retrieveConfigValue<string>('twitch.clientId');
    const externalEndpoint = await retrieveConfigValue<string>('server.endpoints.external');

    if (!appToken) {
      logger.log('Twitch', 'Failed to get app access token for subscription check');
      return [];
    }

    const response = await twitchAPI.makeRequest<{ data: Array<{ transport?: { callback: string }; status: string; id: string; type: string; version: string; created_at: string }> }>({
      method: 'get',
      url: 'https://api.twitch.tv/helix/eventsub/subscriptions',
      headers: {
        'Client-ID': clientId || '',
        Authorization: `Bearer ${appToken}`,
      },
    });

    if (response.data?.data) {
      const callbackUrl = `${externalEndpoint}/api/v1/twitch/eventsub/${userId}`;

      return response.data.data
        .filter((sub) => sub.transport?.callback === callbackUrl && sub.status === 'enabled')
        .map((sub) => ({
          id: sub.id,
          type: sub.type,
          version: sub.version,
          created_at: sub.created_at,
          status: sub.status,
        }));
    }

    return [];
  } catch (error) {
    const err = error as Error;
    logger.log('Twitch', `Error fetching current subscriptions: ${err.message}`);
    return [];
  }
}

/**
 * Cleanup failed/pending subscriptions for a user
 */
export async function cleanupFailedSubscriptions(userId: string): Promise<SubscriptionCleanupResult> {
  try {
    const appToken = await getAppAccessToken();
    const clientId = await retrieveConfigValue<string>('twitch.clientId');
    const externalEndpoint = await retrieveConfigValue<string>('server.endpoints.external');
    const callbackUrl = `${externalEndpoint}/api/v1/twitch/eventsub/${userId}`;

    if (!appToken) {
      logger.log('Twitch', 'Failed to get app access token for subscription cleanup');
      return { success: false, error: 'Failed to get app token', deleted: 0 };
    }

    const response = await twitchAPI.makeRequest<{ data: Array<{ id: string; type: string; status: string; transport?: { callback: string } }> }>({
      method: 'get',
      url: 'https://api.twitch.tv/helix/eventsub/subscriptions',
      headers: {
        'Client-ID': clientId || '',
        Authorization: `Bearer ${appToken}`,
      },
    });

    const allSubs = response.data?.data || [];

    const problemStates = [
      'webhook_callback_verification_pending',
      'webhook_callback_verification_failed',
      'notification_failures_exceeded',
      'authorization_revoked',
      'moderator_removed',
      'user_removed',
      'version_removed',
    ];

    const subsToDelete = allSubs.filter(
      (sub) => sub.transport?.callback === callbackUrl && problemStates.includes(sub.status)
    );

    let deletedCount = 0;
    const errors: string[] = [];

    for (const sub of subsToDelete) {
      try {
        await twitchAPI.makeRequest({
          method: 'delete',
          url: `https://api.twitch.tv/helix/eventsub/subscriptions?id=${sub.id}`,
          headers: {
            'Client-ID': clientId || '',
            Authorization: `Bearer ${appToken}`,
          },
        });
        deletedCount++;
        logger.log('Twitch', `Deleted failed subscription ${sub.type} (${sub.status}) for user ${userId}`);

        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        const err = error as Error;
        errors.push(`${sub.type}: ${err.message}`);
      }
    }

    if (deletedCount > 0) {
      try {
        const user = await returnAuthObject(userId);
        if (user) {
          const storedSubs = user.twitch_tokens?.streamer?.subscriptions || [];
          const deletedIds = subsToDelete.map((s) => s.id);
          const filteredSubs = storedSubs.filter((s) => !deletedIds.includes(s.id));
          await updateUserParameter(userId, 'twitch_tokens.streamer.subscriptions', filteredSubs);
        }
      } catch (updateError) {
        const err = updateError as Error;
        logger.log('Twitch', `Could not update stored subscriptions: ${err.message}`);
      }
    }

    logger.log('Twitch', `Cleanup complete for ${userId}: deleted ${deletedCount}/${subsToDelete.length} failed subscriptions`);

    return {
      success: true,
      deleted: deletedCount,
      found: subsToDelete.length,
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (error) {
    const err = error as Error;
    logger.log('Twitch', `Error cleaning up subscriptions: ${err.message}`);
    return { success: false, error: err.message, deleted: 0 };
  }
}

/**
 * Get detailed subscription status for diagnostics
 */
export async function getSubscriptionStatus(userId: string): Promise<SubscriptionStatusResult> {
  try {
    const appToken = await getAppAccessToken();
    const clientId = await retrieveConfigValue<string>('twitch.clientId');
    const externalEndpoint = await retrieveConfigValue<string>('server.endpoints.external');
    const callbackUrl = `${externalEndpoint}/api/v1/twitch/eventsub/${userId}`;

    const response = await twitchAPI.makeRequest<{ data: Array<{ type: string; version: string; status: string; created_at: string; transport?: { callback: string } }> }>({
      method: 'get',
      url: 'https://api.twitch.tv/helix/eventsub/subscriptions',
      headers: {
        'Client-ID': clientId || '',
        Authorization: `Bearer ${appToken}`,
      },
    });

    const allSubs = response.data?.data || [];
    const userSubs = allSubs.filter((sub) => sub.transport?.callback === callbackUrl);

    const byStatus: Record<string, Array<{ type: string; version: string; createdAt: string }>> = {};
    for (const sub of userSubs) {
      if (!byStatus[sub.status]) {
        byStatus[sub.status] = [];
      }
      byStatus[sub.status]!.push({
        type: sub.type,
        version: sub.version,
        createdAt: sub.created_at,
      });
    }

    return {
      success: true,
      userId,
      callbackUrl,
      total: userSubs.length,
      enabled: byStatus['enabled']?.length || 0,
      byStatus,
      issues: Object.keys(byStatus).filter((s) => s !== 'enabled').length > 0,
    };
  } catch (error) {
    const err = error as Error;
    logger.log('Twitch', `Error getting subscription status: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Enhanced subscription registration with better prioritization
 */
export async function registerUserSubscriptions(userId: string): Promise<EventSubRegistrationResult> {
  try {
    const user = await returnAuthObject(userId);
    if (!user) {
      return {
        success: false,
        created: [],
        skipped: [],
        error: 'User not found',
      };
    }
    const twitchTokens = user.twitch_tokens;

    if (!twitchTokens?.streamer?.access_token) {
      return {
        success: false,
        created: [],
        skipped: [],
        error: 'No streamer account connected',
      };
    }

    if (!twitchTokens.streamer.twitch_user_id) {
      const twitchUserId = await fetchTwitchUserId(userId, 'streamer');
      if (!twitchUserId) {
        return {
          success: false,
          created: [],
          skipped: [],
          error: 'Failed to fetch Twitch user ID',
        };
      }
    }

    await ensureParameterPath(userId, 'twitch_tokens.streamer.subscriptions');

    if (!twitchTokens.streamer.webhook_secret) {
      const newSecret = crypto.randomBytes(32).toString('hex');
      await updateUserParameter(userId, 'twitch_tokens.streamer.webhook_secret', newSecret);
      logger.log('Twitch', `Generated new webhook secret for user ${userId}`);
    }

    const updatedUser = await returnAuthObject(userId);
    if (!updatedUser) {
      return {
        success: false,
        created: [],
        skipped: [],
        error: 'User not found after update',
      };
    }
    const broadcasterId = updatedUser.twitch_tokens?.streamer?.twitch_user_id || '';

    const [currentTwitchSubs, streamerScopes] = await Promise.all([
      fetchCurrentTwitchSubscriptions(userId),
      getUserScopes(userId, 'streamer'),
    ]);

    const existingSubsMap = new Map<string, SubscriptionRecord>();
    currentTwitchSubs.forEach((sub) => {
      const key = `${sub.type}:${sub.version}`;
      existingSubsMap.set(key, sub);
    });

    const results: EventSubRegistrationResult = {
      success: true,
      created: [],
      skipped: [],
      error: undefined,
    };

    const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const sortedSubscriptions = [...SUBSCRIPTION_TYPES].sort((a, b) => {
      return (priorityOrder[a.priority || 'low'] ?? 2) - (priorityOrder[b.priority || 'low'] ?? 2);
    });

    for (const subscriptionConfig of sortedSubscriptions) {
      try {
        const subKey = `${subscriptionConfig.type}:${subscriptionConfig.version}`;

        if (existingSubsMap.has(subKey)) {
          results.skipped.push(`${subscriptionConfig.type} (v${subscriptionConfig.version})`);
          continue;
        }

        if (subscriptionConfig.requiredScopes.length > 0) {
          const missingScopes = subscriptionConfig.requiredScopes.filter(
            (scope) => !streamerScopes.includes(scope)
          );

          if (missingScopes.length > 0) {
            logger.log('Twitch', `Skipping ${subscriptionConfig.type} - missing scopes: ${missingScopes.join(', ')}`);
            results.skipped.push(`${subscriptionConfig.type} (v${subscriptionConfig.version}) - missing scopes`);
            continue;
          }
        }

        const subResult = await createSubscription(userId, subscriptionConfig, broadcasterId);

        if (subResult.success) {
          results.created.push(`${subscriptionConfig.type} (v${subscriptionConfig.version})`);
        } else {
          results.skipped.push(`${subscriptionConfig.type}: ${subResult.error}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (error) {
        const err = error as Error;
        results.skipped.push(`${subscriptionConfig.type}: ${err.message}`);
      }
    }

    results.success = results.created.length > 0 || results.skipped.length === SUBSCRIPTION_TYPES.length;

    logger.log('Twitch', `EventSub registration for ${userId}: ${results.created.length} created, ${results.skipped.length} skipped`);
    return results;
  } catch (error) {
    const err = error as Error;
    logger.log('Twitch', `Error in registerUserSubscriptions: ${err.message}`);
    return {
      success: false,
      created: [],
      skipped: [],
      error: err.message,
    };
  }
}

/**
 * Create a single subscription
 */
async function createSubscription(
  userId: string,
  subscriptionConfig: SubscriptionConfig,
  broadcasterId: string
): Promise<SubscriptionCreationResult> {
  try {
    const user = await returnAuthObject(userId);
    if (!user) {
      return { success: false, error: 'User not found' };
    }
    const webhookSecret = user.twitch_tokens?.streamer?.webhook_secret || '';

    const accessToken = await getAppAccessToken();
    const clientId = await retrieveConfigValue<string>('twitch.clientId');
    const externalEndpoint = await retrieveConfigValue<string>('server.endpoints.external');

    const condition = subscriptionConfig.condition(broadcasterId);
    const callbackUrl = `${externalEndpoint}/api/v1/twitch/eventsub/${userId}`;

    const subscriptionBody = {
      type: subscriptionConfig.type,
      version: subscriptionConfig.version,
      condition: condition,
      transport: {
        method: 'webhook',
        callback: callbackUrl,
        secret: webhookSecret,
      },
    };

    const response = await twitchAPI.makeRequest<{ data: Array<{ id: string }> }>({
      method: 'post',
      url: 'https://api.twitch.tv/helix/eventsub/subscriptions',
      data: subscriptionBody,
      headers: {
        'Client-ID': clientId || '',
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const subscriptionId = response.data.data[0]?.id;
    if (!subscriptionId) {
      return { success: false, error: 'No subscription ID returned' };
    }

    const currentUser = await returnAuthObject(userId);
    if (!currentUser) {
      return { success: false, error: 'User not found after creation' };
    }
    const subscriptions = currentUser.twitch_tokens?.streamer?.subscriptions || [];

    subscriptions.push({
      id: subscriptionId,
      type: subscriptionConfig.type,
      version: subscriptionConfig.version,
      status: 'webhook_callback_verification_pending',
      created_at: new Date().toISOString(),
    });

    await updateUserParameter(userId, 'twitch_tokens.streamer.subscriptions', subscriptions);

    return {
      success: true,
      id: subscriptionId,
      version: subscriptionConfig.version,
    };
  } catch (error) {
    const axiosError = error as { response?: { status: number } };

    if (axiosError.response?.status === 409) {
      logger.log('Twitch', `409 Conflict for ${subscriptionConfig.type} - subscription likely exists`);

      const existingSubs = await fetchCurrentTwitchSubscriptions(userId);
      const matchingSub = existingSubs.find(
        (sub) => sub.type === subscriptionConfig.type && sub.version === subscriptionConfig.version
      );

      if (matchingSub) {
        return {
          success: true,
          id: matchingSub.id,
          version: matchingSub.version,
          alreadyExists: true,
        };
      }
    }

    const err = error as Error;
    logger.log('Twitch', `Error creating subscription ${subscriptionConfig.type}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Enhanced chat message processing
 */
export async function processChatMessage(
  chatEvent: Record<string, unknown>,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { handleChatMessage, normalizeMessageFormat } = await import('../../core/chat-handler.js');

    const normalizedChat = normalizeMessageFormat(chatEvent);
    if (!normalizedChat) {
      return { success: false, error: 'Failed to normalize chat message' };
    }
    return await handleChatMessage(normalizedChat, userId, true);
  } catch (error) {
    const err = error as Error;
    logger.log('Twitch', `Error processing chat message: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Enhanced chat message sending with retry logic
 */
export async function sendChatMessage(message: string, userId: string): Promise<ChatMessageResult> {
  try {
    const user = await returnAuthObject(userId);
    if (!user) {
      return { success: false, error: 'User not found' };
    }
    const twitchTokens = user.twitch_tokens;

    if (!twitchTokens?.bot?.access_token) {
      logger.log('Twitch', `No bot token for user ${userId}, can't send chat message`);
      return { success: false, error: 'No bot token available' };
    }

    const botToken = await ensureValidToken(userId, 'bot');
    if (!botToken) {
      logger.log('Twitch', `Failed to refresh bot token for ${userId}`);
      return { success: false, error: 'Failed to refresh bot token' };
    }

    if (!twitchTokens?.streamer?.twitch_user_id) {
      logger.log('Twitch', `No streamer ID for ${userId}, can't determine chat channel`);
      return { success: false, error: 'No streamer ID available' };
    }

    const channelId = twitchTokens.streamer.twitch_user_id;
    const botUserId = twitchTokens.bot.twitch_user_id;
    const clientId = await retrieveConfigValue<string>('twitch.clientId');

    const response = await twitchAPI.makeRequest<{ message_id?: string }>({
      method: 'post',
      url: 'https://api.twitch.tv/helix/chat/messages',
      data: {
        broadcaster_id: channelId,
        sender_id: botUserId,
        message: message,
      },
      headers: {
        'Client-ID': clientId || '',
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 200) {
      logger.log('Twitch', `Sent chat message to ${user.twitch_name || user.user_name}'s channel`);
      return { success: true, message_id: response.data.message_id };
    } else {
      logger.log('Twitch', `Failed to send chat message: ${response.status} ${response.statusText}`);
      return { success: false, error: `API returned ${response.status}` };
    }
  } catch (error) {
    const err = error as Error;
    logger.log('Twitch', `Error sending chat message: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Enhanced user scope checking with caching
 */
async function getUserScopes(userId: string, tokenType: 'streamer' | 'bot'): Promise<string[]> {
  const cacheKey = `scopes_${userId}_${tokenType}`;
  const cached = tokenCache.get(cacheKey) as ScopesCacheEntry | undefined;

  if (cached && Date.now() < cached.expiresAt) {
    return cached.scopes;
  }

  try {
    const user = await returnAuthObject(userId);
    if (!user) {
      return [];
    }
    const tokenData = user.twitch_tokens?.[tokenType];

    if (!tokenData?.access_token) {
      return [];
    }

    if (tokenData.scopes && Array.isArray(tokenData.scopes)) {
      const scopes = tokenData.scopes;
      tokenCache.set(cacheKey, {
        scopes,
        expiresAt: Date.now() + TOKEN_CACHE_TTL,
      });
      return scopes;
    }

    const response = await axios.get('https://id.twitch.tv/oauth2/validate', {
      headers: {
        Authorization: `OAuth ${tokenData.access_token}`,
      },
      timeout: 10000,
    });

    if (response.data?.scopes) {
      const scopes = response.data.scopes as string[];

      await updateUserParameter(userId, `twitch_tokens.${tokenType}.scopes`, scopes);
      tokenCache.set(cacheKey, {
        scopes,
        expiresAt: Date.now() + TOKEN_CACHE_TTL,
      });

      return scopes;
    }

    return [];
  } catch (error) {
    const axiosError = error as { response?: { status: number } };

    if (axiosError.response?.status === 401) {
      const newToken = await ensureValidToken(userId, tokenType);
      if (newToken) {
        return getUserScopes(userId, tokenType);
      }
    }

    const err = error as Error;
    logger.log('Twitch', `Error getting user scopes: ${err.message}`);
    return [];
  }
}

/**
 * Enhanced Twitch user ID fetching
 */
async function fetchTwitchUserId(userId: string, tokenType: 'streamer' | 'bot'): Promise<string | null> {
  try {
    const user = await returnAuthObject(userId);
    if (!user) {
      logger.log('Twitch', `User not found: ${userId}`);
      return null;
    }
    const tokenData = user.twitch_tokens?.[tokenType];

    if (tokenData?.twitch_user_id) {
      return tokenData.twitch_user_id;
    }

    if (!tokenData?.access_token) {
      logger.log('Twitch', `No access token available for ${userId} (${tokenType})`);
      return null;
    }

    const clientId = await retrieveConfigValue<string>('twitch.clientId');

    const response = await twitchAPI.makeRequest<{ data: Array<{ id: string; login: string; display_name: string }> }>({
      method: 'get',
      url: 'https://api.twitch.tv/helix/users',
      headers: {
        'Client-ID': clientId || '',
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    if (response.data.data?.[0]) {
      const userData = response.data.data[0];

      await ensureParameterPath(userId, `twitch_tokens.${tokenType}`);
      await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_user_id`, userData.id);
      await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_login`, userData.login);
      await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_display_name`, userData.display_name);

      logger.log('Twitch', `Retrieved and saved Twitch user ID for ${userId} (${tokenType}): ${userData.id}`);
      return userData.id;
    }

    logger.log('Twitch', `Failed to get user info for ${userId} (${tokenType})`);
    return null;
  } catch (error) {
    const err = error as Error;
    logger.log('Twitch', `Error fetching Twitch user ID for ${userId} (${tokenType}): ${err.message}`);
    return null;
  }
}

/**
 * Main registration function
 */
export async function registerAllUsersEventSub(): Promise<EventSubBatchResult> {
  try {
    logger.log('Twitch', 'Starting automatic EventSub registration for all users');

    const users = await returnAPIKeys();
    let successCount = 0;
    let failureCount = 0;

    const batchSize = 3;
    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);

      const batchPromises = batch.map(async (user: User) => {
        try {
          const twitchTokens = user.twitch_tokens as { streamer?: { access_token?: string } } | undefined;

          if (!twitchTokens?.streamer?.access_token) {
            logger.log('Twitch', `Skipping EventSub for ${user.user_id}: No streamer account connected`);
            return false;
          }

          const validToken = await ensureValidToken(user.user_id, 'streamer');
          if (!validToken) {
            logger.log('Twitch', `Skipping EventSub for ${user.user_id}: Token refresh failed`);
            return false;
          }

          const results = await registerUserSubscriptions(user.user_id);

          if (results.success) {
            logger.log('Twitch', `Successfully registered EventSub for ${user.user_id}`);
            return true;
          } else {
            logger.log('Twitch', `Failed to register EventSub for ${user.user_id}: ${results.error}`);
            return false;
          }
        } catch (userError) {
          const err = userError as Error;
          logger.log('Twitch', `Error processing user ${user.user_id}: ${err.message}`);
          return false;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      successCount += batchResults.filter(Boolean).length;
      failureCount += batchResults.filter((result) => !result).length;

      if (i + batchSize < users.length) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    logger.log('Twitch', `EventSub registration complete. Success: ${successCount}, Failures: ${failureCount}`);
    return { success: successCount, failures: failureCount };
  } catch (error) {
    const err = error as Error;
    logger.log('Twitch', `Error in registerAllUsersEventSub: ${err.message}`);
    throw error;
  }
}

/**
 * Enhanced event processing
 */
export async function processEventSubNotification(
  eventType: string,
  eventData: Record<string, unknown>,
  userId: string,
  eventVersion: string = '1'
): Promise<{ response?: string; chatMessageSent?: boolean; chatMessageId?: string }> {
  try {
    const { respondToEvent } = await import('../../core/response-generator.js');

    const mappedEvent = mapEventSubToInternalFormat(eventType, eventData, eventVersion);

    logger.log('Twitch', `Processing ${eventType} (v${eventVersion}) event for user ${userId}`);

    // Publish to event bus for extensions
    const eventBus = getEventBus();
    const enspiraEventType = mapEventTypeToEnspira(eventType);
    const enspiraEvent = eventBus.createEvent(
      enspiraEventType,
      'twitch',
      {
        ...mappedEvent.eventData,
        originalEventType: eventType,
        eventVersion,
        userId,
      },
      undefined // User info could be added here if available
    );

    // Publish event to extensions (non-blocking)
    eventBus.publish(enspiraEvent).catch((err) => {
      logger.error('Twitch', `Error publishing event to extensions: ${err}`);
    });

    const aiResponse = await respondToEvent(mappedEvent as unknown as { eventType: string; [key: string]: unknown }, userId);

    if (aiResponse?.response) {
      const chatResult = await sendChatMessage(aiResponse.response, userId);

      if (chatResult.success) {
        logger.log('Twitch', `Sent response to ${eventType} event to chat: ${aiResponse.response.substring(0, 50)}...`);
      } else {
        logger.log('Twitch', `Failed to send ${eventType} response to chat: ${chatResult.error}`);
      }

      // Publish AI response event for extensions
      const responseEvent = eventBus.createEvent(
        'ai:response.sent',
        'internal',
        {
          originalEventId: enspiraEvent.id,
          originalEventType: enspiraEventType,
          response: aiResponse.response,
          chatMessageSent: chatResult.success,
          chatMessageId: chatResult.message_id,
          userId,
        }
      );
      eventBus.publish(responseEvent).catch((err) => {
        logger.error('Twitch', `Error publishing response event: ${err}`);
      });

      return {
        ...aiResponse,
        chatMessageSent: chatResult.success,
        chatMessageId: chatResult.message_id,
      };
    }

    return aiResponse || {};
  } catch (error) {
    const err = error as Error;
    logger.log('Twitch', `Error processing notification: ${err.message}`);
    throw error;
  }
}

/**
 * Optimized event mapping function
 */
function mapEventSubToInternalFormat(
  eventType: string,
  eventData: Record<string, unknown>,
  _version: string = '1'
): InternalTwitchEvent {
  const mappedEvent: InternalTwitchEvent = { eventType: '', eventData: {} };

  switch (eventType) {
    case 'channel.chat.message': {
      const chatter = eventData.chatter as { user_name: string; user_id: string; badges?: Array<{ set_id: string }> };
      const message = eventData.message as { text: string; is_first?: boolean; fragments?: Array<{ type: string; id?: string; text: string }> };

      mappedEvent.eventType = 'chat';
      mappedEvent.eventData = {
        user: chatter.user_name,
        user_id: chatter.user_id,
        message: message.text,
        is_first: message.is_first || false,
        chatter_is_broadcaster: chatter.user_id === eventData.broadcaster_user_id,
        chatter_is_moderator: chatter.badges?.some((badge) => badge.set_id === 'moderator') || false,
        chatter_is_subscriber: chatter.badges?.some((badge) => badge.set_id === 'subscriber') || false,
        fragments: message.fragments || [],
        emotes:
          message.fragments
            ?.filter((frag) => frag.type === 'emote')
            .map((emote) => ({ id: emote.id, name: emote.text })) || [],
      };
      break;
    }

    case 'channel.follow':
      mappedEvent.eventType = 'follow';
      mappedEvent.eventData = {
        username: (eventData.user_name as string) || '',
        userId: (eventData.user_id as string) || '',
        followed_at: (eventData.followed_at as string) || new Date().toISOString(),
      };
      break;

    case 'channel.subscribe':
      mappedEvent.eventType = 'sub';
      mappedEvent.eventData = {
        subType: 'sub',
        user: (eventData.user_name as string) || '',
        subTier: mapTier((eventData.tier as string) || '1000'),
        isGift: (eventData.is_gift as boolean) || false,
      };
      break;

    case 'channel.subscription.gift':
      mappedEvent.eventType = 'sub';
      mappedEvent.eventData = {
        subType: 'gift_sub',
        user: eventData.is_anonymous ? 'Anonymous' : (eventData.user_name as string) || '',
        anonymous: (eventData.is_anonymous as boolean) || false,
        subTier: mapTier((eventData.tier as string) || '1000'),
        recipientUserName: (eventData.recipient_user_name as string) || 'a viewer',
      };
      break;

    case 'channel.cheer':
      mappedEvent.eventType = 'dono';
      mappedEvent.eventData = {
        donoType: 'bits',
        donoFrom: eventData.is_anonymous ? 'Anonymous' : (eventData.user_name as string) || '',
        donoAmt: (eventData.bits as number) || 0,
        donoMessage: (eventData.message as string) || '',
      };
      break;

    case 'channel.raid':
      mappedEvent.eventType = 'raid';
      mappedEvent.eventData = {
        username: (eventData.from_broadcaster_user_name as string) || '',
        viewers: (eventData.viewers as number) || 0,
      };
      break;

    case 'stream.online':
      mappedEvent.eventType = 'stream_online';
      mappedEvent.eventData = {
        startTime: (eventData.started_at as string) || new Date().toISOString(),
        type: (eventData.type as string) || 'live',
      };
      break;

    case 'stream.offline':
      mappedEvent.eventType = 'stream_offline';
      mappedEvent.eventData = {
        endTime: new Date().toISOString(),
      };
      break;

    default:
      mappedEvent.eventType = eventType.replace('channel.', '').replace('stream.', '');
      mappedEvent.eventData = { ...eventData };
  }

  return mappedEvent;
}

/**
 * Helper for tier mapping
 */
function mapTier(tier: string): string {
  switch (tier) {
    case '1000':
      return 'tier 1';
    case '2000':
      return 'tier 2';
    case '3000':
      return 'tier 3';
    default:
      return 'prime';
  }
}

/**
 * Maps Twitch EventSub event types to Enspira event types
 */
function mapEventTypeToEnspira(eventType: string): EnspiraEventType {
  const eventTypeMap: Record<string, EnspiraEventType> = {
    'channel.chat.message': 'twitch:chat',
    'channel.follow': 'twitch:follow',
    'channel.subscribe': 'twitch:subscribe',
    'channel.subscription.gift': 'twitch:gift',
    'channel.subscription.message': 'twitch:subscribe',
    'channel.cheer': 'twitch:cheer',
    'channel.raid': 'twitch:raid',
    'stream.online': 'twitch:stream.online',
    'stream.offline': 'twitch:stream.offline',
    'channel.channel_points_custom_reward_redemption.add': 'twitch:redemption',
  };

  return eventTypeMap[eventType] || (`twitch:${eventType.replace('channel.', '').replace('stream.', '')}` as EnspiraEventType);
}

/**
 * Enhanced stream info fetching
 */
export async function fetchStreamInfo(userId: string): Promise<StreamInfoResult> {
  try {
    const user = await returnAuthObject(userId);
    if (!user) {
      return { success: false, isLive: false, error: 'User not found' };
    }
    const twitchUserId = user.twitch_tokens?.streamer?.twitch_user_id;

    if (!twitchUserId) {
      logger.log('Twitch', `No Twitch user ID for ${userId}, can't fetch stream info`);
      return { success: false, isLive: false, error: 'Missing Twitch user ID' };
    }

    const appToken = await getAppAccessToken();
    const clientId = await retrieveConfigValue<string>('twitch.clientId');

    const streamResponse = await twitchAPI.makeRequest<{ data: Array<{ viewer_count: number; started_at: string; title: string; game_id: string; game_name: string; thumbnail_url: string; type: string }> }>({
      method: 'get',
      url: `https://api.twitch.tv/helix/streams?user_id=${twitchUserId}`,
      headers: {
        'Client-ID': clientId || '',
        Authorization: `Bearer ${appToken}`,
      },
    });

    const result: StreamInfoResult = { success: true, isLive: false };

    if (streamResponse.data.data?.[0]) {
      const streamData = streamResponse.data.data[0];
      result.isLive = true;
      result.data = {
        viewerCount: streamData.viewer_count || 0,
        startedAt: streamData.started_at || null,
        title: streamData.title || '',
        gameId: streamData.game_id || '',
        gameName: streamData.game_name || 'Unknown Game',
        thumbnailUrl:
          streamData.thumbnail_url?.replace('{width}', '320').replace('{height}', '180') || null,
      };

      await Promise.all([
        updateUserParameter(userId, 'current_game', {
          title: streamData.title || 'No Title',
          game: streamData.game_name || 'none',
          game_id: streamData.game_id || '0',
          thumbnail_url: streamData.thumbnail_url || null,
          updated_at: new Date().toISOString(),
        }),
        updateUserParameter(userId, 'current_viewers', streamData.viewer_count || 0),
        updateUserParameter(userId, 'stream_status', {
          online: true,
          started_at: streamData.started_at || null,
          type: streamData.type || 'live',
          title: streamData.title || '',
          viewer_count: streamData.viewer_count || 0,
          updated_at: new Date().toISOString(),
        }),
      ]);

      logger.log('Twitch', `Updated stream info for ${userId}: ${streamData.viewer_count} viewers, playing ${streamData.game_name}`);
    } else {
      await Promise.all([
        updateUserParameter(userId, 'stream_status', {
          online: false,
          updated_at: new Date().toISOString(),
        }),
        updateUserParameter(userId, 'current_viewers', 0),
      ]);
    }

    await fetchFollowerCount(userId, twitchUserId, appToken);

    return result;
  } catch (error) {
    const err = error as Error;
    logger.log('Twitch', `Error fetching stream info: ${err.message}`);
    return { success: false, isLive: false, error: err.message };
  }
}

/**
 * Fetch follower count
 */
async function fetchFollowerCount(userId: string, channelId: string, appToken: string): Promise<number> {
  try {
    const clientId = await retrieveConfigValue<string>('twitch.clientId');

    const followerResponse = await twitchAPI.makeRequest<{ total: number }>({
      method: 'get',
      url: `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${channelId}`,
      headers: {
        'Client-ID': clientId || '',
        Authorization: `Bearer ${appToken}`,
      },
    });

    const followerCount = followerResponse.data.total || 0;
    await updateUserParameter(userId, 'current_followers', followerCount);

    logger.log('Twitch', `Updated follower count for ${userId}: ${followerCount}`);
    return followerCount;
  } catch (error) {
    const err = error as Error;
    logger.log('Twitch', `Error fetching follower count: ${err.message}`);
    return 0;
  }
}

/**
 * Update all stream info
 */
export async function updateAllStreamInfo(): Promise<StreamUpdateResult> {
  try {
    const users = await returnAPIKeys();
    const twitchUsers = users.filter((user: User) => {
      const tokens = user.twitch_tokens as { streamer?: { twitch_user_id?: string } } | undefined;
      return tokens?.streamer?.twitch_user_id;
    });

    let updatedCount = 0;
    let errorCount = 0;

    const batchSize = 5;
    for (let i = 0; i < twitchUsers.length; i += batchSize) {
      const batch = twitchUsers.slice(i, i + batchSize);

      const batchPromises = batch.map(async (user: User) => {
        try {
          await fetchStreamInfo(user.user_id);
          return true;
        } catch (error) {
          const err = error as Error;
          logger.log('Twitch', `Error updating stream info for ${user.user_id}: ${err.message}`);
          return false;
        }
      });

      const results = await Promise.all(batchPromises);
      updatedCount += results.filter(Boolean).length;
      errorCount += results.filter((result) => !result).length;

      if (i + batchSize < twitchUsers.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    logger.log('Twitch', `Updated stream info for ${updatedCount} users, with ${errorCount} errors`);
    return { updated: updatedCount, errors: errorCount };
  } catch (error) {
    const err = error as Error;
    logger.log('Twitch', `Error in updateAllStreamInfo: ${err.message}`);
    return { updated: 0, errors: 1 };
  }
}

/**
 * Enhanced cron job setup
 */
export function setupTwitchCronJobs(): void {
  // Update stream info every minute
  cron.schedule('*/1 * * * *', async () => {
    try {
      await updateAllStreamInfo();
    } catch (error) {
      const err = error as Error;
      logger.log('Cron', `Error in stream info update job: ${err.message}`);
    }
  });

  // Update follower count every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      const users = await returnAPIKeys();
      const twitchUsers = users.filter((user: User) => {
        const tokens = user.twitch_tokens as { streamer?: { twitch_user_id?: string } } | undefined;
        return tokens?.streamer?.twitch_user_id;
      });

      for (const user of twitchUsers) {
        try {
          const tokens = user.twitch_tokens as { streamer?: { twitch_user_id?: string } } | undefined;
          const channelId = tokens?.streamer?.twitch_user_id;
          if (channelId) {
            const appToken = await getAppAccessToken();
            await fetchFollowerCount(user.user_id, channelId, appToken);
          }
        } catch (userError) {
          const err = userError as Error;
          logger.log('Twitch', `Error updating follower count for ${user.user_id}: ${err.message}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (error) {
      const err = error as Error;
      logger.log('Cron', `Error in follower count update job: ${err.message}`);
    }
  });

  // Periodic token cache cleanup
  cron.schedule('*/15 * * * *', () => {
    const now = Date.now();
    for (const [key, cached] of tokenCache.entries()) {
      if (now > cached.expiresAt) {
        tokenCache.delete(key);
      }
    }
  });

  logger.log('System', 'Twitch cron jobs initialized');
}
