/**
 * Twitch API and EventSub type definitions for Enspira
 * Based on Twitch Helix API and EventSub specifications
 */

// EventSub subscription types
export type TwitchEventType =
  | 'channel.follow'
  | 'channel.subscribe'
  | 'channel.subscription.gift'
  | 'channel.subscription.message'
  | 'channel.cheer'
  | 'channel.raid'
  | 'channel.ban'
  | 'channel.unban'
  | 'channel.moderator.add'
  | 'channel.moderator.remove'
  | 'channel.channel_points_custom_reward_redemption.add'
  | 'channel.channel_points_custom_reward_redemption.update'
  | 'channel.poll.begin'
  | 'channel.poll.progress'
  | 'channel.poll.end'
  | 'channel.prediction.begin'
  | 'channel.prediction.progress'
  | 'channel.prediction.lock'
  | 'channel.prediction.end'
  | 'channel.hype_train.begin'
  | 'channel.hype_train.progress'
  | 'channel.hype_train.end'
  | 'channel.charity_campaign.donate'
  | 'channel.charity_campaign.start'
  | 'channel.charity_campaign.progress'
  | 'channel.charity_campaign.stop'
  | 'channel.goal.begin'
  | 'channel.goal.progress'
  | 'channel.goal.end'
  | 'channel.shield_mode.begin'
  | 'channel.shield_mode.end'
  | 'channel.shoutout.create'
  | 'channel.shoutout.receive'
  | 'stream.online'
  | 'stream.offline';

// EventSub message types
export type EventSubMessageType =
  | 'notification'
  | 'webhook_callback_verification'
  | 'revocation';

// Base EventSub webhook payload
export interface EventSubPayload<T = unknown> {
  subscription: EventSubSubscription;
  event: T;
}

export interface EventSubSubscription {
  id: string;
  type: TwitchEventType;
  version: string;
  status: string;
  cost: number;
  condition: Record<string, string>;
  transport: EventSubTransport;
  created_at: string;
}

export interface EventSubTransport {
  method: 'webhook';
  callback: string;
}

// Common event properties
interface BaseEvent {
  broadcaster_user_id: string;
  broadcaster_user_login: string;
  broadcaster_user_name: string;
}

// Follow event
export interface FollowEvent extends BaseEvent {
  user_id: string;
  user_login: string;
  user_name: string;
  followed_at: string;
}

// Subscribe event (new subscription)
export interface SubscribeEvent extends BaseEvent {
  user_id: string;
  user_login: string;
  user_name: string;
  tier: SubscriptionTier;
  is_gift: boolean;
}

export type SubscriptionTier = '1000' | '2000' | '3000';

// Subscription message event (resub with message)
export interface SubscriptionMessageEvent extends BaseEvent {
  user_id: string;
  user_login: string;
  user_name: string;
  tier: SubscriptionTier;
  message: SubscriptionMessage;
  cumulative_months: number;
  streak_months: number | null;
  duration_months: number;
}

export interface SubscriptionMessage {
  text: string;
  emotes: Emote[];
}

export interface Emote {
  begin: number;
  end: number;
  id: string;
}

// Gift subscription event
export interface GiftSubscriptionEvent extends BaseEvent {
  user_id: string;
  user_login: string;
  user_name: string;
  tier: SubscriptionTier;
  total: number;
  cumulative_total: number | null;
  is_anonymous: boolean;
}

// Cheer (bits) event
export interface CheerEvent extends BaseEvent {
  user_id: string;
  user_login: string;
  user_name: string;
  is_anonymous: boolean;
  message: string;
  bits: number;
}

// Raid event
export interface RaidEvent extends BaseEvent {
  from_broadcaster_user_id: string;
  from_broadcaster_user_login: string;
  from_broadcaster_user_name: string;
  viewers: number;
}

// Channel points redemption event
export interface ChannelPointsRedemptionEvent extends BaseEvent {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  user_input: string;
  status: 'unfulfilled' | 'fulfilled' | 'canceled';
  reward: ChannelPointsReward;
  redeemed_at: string;
}

export interface ChannelPointsReward {
  id: string;
  title: string;
  prompt: string;
  cost: number;
}

// Hype train event
export interface HypeTrainEvent extends BaseEvent {
  id: string;
  total: number;
  progress: number;
  goal: number;
  level: number;
  started_at: string;
  expires_at: string;
  top_contributions: HypeTrainContribution[];
  last_contribution: HypeTrainContribution;
}

export interface HypeTrainContribution {
  user_id: string;
  user_login: string;
  user_name: string;
  type: 'bits' | 'subscription' | 'other';
  total: number;
}

// Stream online/offline events
export interface StreamOnlineEvent extends BaseEvent {
  id: string;
  type: 'live' | 'playlist' | 'watch_party' | 'premiere' | 'rerun';
  started_at: string;
}

export interface StreamOfflineEvent extends BaseEvent {}

// Ban event
export interface BanEvent extends BaseEvent {
  user_id: string;
  user_login: string;
  user_name: string;
  moderator_user_id: string;
  moderator_user_login: string;
  moderator_user_name: string;
  reason: string;
  banned_at: string;
  ends_at: string | null;
  is_permanent: boolean;
}

// Poll events
export interface PollChoice {
  id: string;
  title: string;
  bits_votes: number;
  channel_points_votes: number;
  votes: number;
}

export interface PollEvent extends BaseEvent {
  id: string;
  title: string;
  choices: PollChoice[];
  bits_voting: {
    is_enabled: boolean;
    amount_per_vote: number;
  };
  channel_points_voting: {
    is_enabled: boolean;
    amount_per_vote: number;
  };
  started_at: string;
  ends_at: string;
}

// Prediction events
export interface PredictionOutcome {
  id: string;
  title: string;
  color: 'blue' | 'pink';
  users: number;
  channel_points: number;
  top_predictors: TopPredictor[];
}

export interface TopPredictor {
  user_id: string;
  user_login: string;
  user_name: string;
  channel_points_won: number | null;
  channel_points_used: number;
}

export interface PredictionEvent extends BaseEvent {
  id: string;
  title: string;
  outcomes: PredictionOutcome[];
  started_at: string;
  locks_at: string;
}

// Shoutout events
export interface ShoutoutCreateEvent extends BaseEvent {
  moderator_user_id: string;
  moderator_user_login: string;
  moderator_user_name: string;
  to_broadcaster_user_id: string;
  to_broadcaster_user_login: string;
  to_broadcaster_user_name: string;
  started_at: string;
  viewer_count: number;
  cooldown_ends_at: string;
  target_cooldown_ends_at: string;
}

export interface ShoutoutReceiveEvent {
  broadcaster_user_id: string;
  broadcaster_user_login: string;
  broadcaster_user_name: string;
  from_broadcaster_user_id: string;
  from_broadcaster_user_login: string;
  from_broadcaster_user_name: string;
  viewer_count: number;
  started_at: string;
}

// Chat message (from TMI/IRC, not EventSub)
export interface TwitchChatMessage {
  id: string;
  channel: string;
  username: string;
  display_name: string;
  user_id: string;
  message: string;
  timestamp: number;
  badges: Record<string, string>;
  emotes: Record<string, string[]>;
  is_mod: boolean;
  is_subscriber: boolean;
  is_vip: boolean;
  is_broadcaster: boolean;
  color: string;
}

// API response types
export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  type: '' | 'admin' | 'global_mod' | 'staff';
  broadcaster_type: '' | 'affiliate' | 'partner';
  description: string;
  profile_image_url: string;
  offline_image_url: string;
  created_at: string;
}

export interface TwitchStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_id: string;
  game_name: string;
  type: 'live' | '';
  title: string;
  viewer_count: number;
  started_at: string;
  language: string;
  thumbnail_url: string;
  tags: string[];
  is_mature: boolean;
}

export interface TwitchGame {
  id: string;
  name: string;
  box_art_url: string;
  igdb_id?: string;
}

// EventSub registration result
export interface EventSubRegistrationResult {
  success: boolean;
  created: string[];
  skipped: string[];
  error?: string;
}

// EventSub health check result
export interface EventSubHealthResult {
  timestamp: string;
  overall: 'healthy' | 'degraded' | 'unhealthy' | 'error';
  uptime: number;
  memoryUsage: NodeJS.MemoryUsage;
  twitch: {
    appTokenValid: boolean;
    appTokenError?: string;
    externalEndpoint: string;
    externalEndpointIssues: string[];
    events: {
      eventsProcessed: number;
      successRate: string;
      averageResponseTime: number;
      chatMessagesProcessed: number;
    };
    api?: {
      totalRequests: number;
      successRate: string;
      rateLimitViolations: {
        helix: number;
        auth: number;
      };
    };
    subscriptions?: {
      total: number;
      enabled: number;
      pending: number;
      failed: number;
      problems: Array<{
        type: string;
        status: string;
        createdAt: string;
      }>;
    };
  };
}

// ==================== HELPER FUNCTION TYPES ====================

/** Internal event type identifiers (mapped from EventSub) */
export type InternalEventType =
  | 'sub'
  | 'dono'
  | 'chat'
  | 'raid'
  | 'follow'
  | 'hype_start'
  | 'hype_update'
  | 'hype_end'
  | 'hype_up'
  | 'trivia'
  | 'ad'
  | 'summary'
  | 'shoutout'
  | 'stream_online'
  | 'stream_offline';

/** Internal event structure */
export interface InternalTwitchEvent {
  eventType: InternalEventType | string;
  eventData: Record<string, unknown>;
  playerName?: string;
  playerId?: string;
  user?: string;
  message?: string;
  firstMessage?: boolean;
  minutesLeft?: number;
}

/** Event message templates from files */
export interface EventMessageTemplates {
  sub?: string;
  dono?: string;
  charity?: string;
  raid?: string;
  follow?: string;
  firstchat?: string;
  hype?: string;
  [key: string]: string | undefined;
}

/** Normalized chat message format */
export interface NormalizedChatMessage {
  user: string;
  userId: string | null;
  message: string;
  firstMessage: boolean;
  badges: string[];
  emotes: Array<{ id: string; code?: string; text?: string }>;
  emoteCount: number;
  color: string | null;
  source: 'eventsub' | 'api';
}

/** Chat processing result */
export interface ChatProcessResult {
  success: boolean;
  ignored?: boolean;
  processed?: boolean;
  mentioned?: boolean;
  firstMessage?: boolean;
  requiresResponse?: boolean;
  reason?: string;
  response?: string;
  error?: string;
  messageData?: {
    message: string;
    user: string;
  };
}

/** Command event result */
export interface CommandEventResult {
  eventType: string;
  eventData: Record<string, unknown>;
}

// ==================== MODERATION TYPES ====================

/** Moderation action result */
export interface ModerationActionResult {
  action: 'strike' | 'ban';
  reason: string;
  user: string;
  userMsg: string;
  strikeCount?: number;
}

/** Strike information */
export interface StrikeInfo {
  userName: string;
  strikes: number;
}

/** Ban information */
export interface BanInfo {
  banned: boolean;
  streamerBans: string[];
  banCount: number;
}

/** Strikes data file structure */
export interface StrikesData {
  [userName: string]: {
    [streamerName: string]: number;
  };
}

/** Bans data file structure */
export interface BansData {
  [userName: string]: string[];
}

// ==================== SOCIAL MEDIA TYPES ====================

/** Social media platforms */
export type SocialPlatform =
  | 'tiktok'
  | 'youtube'
  | 'twitter'
  | 'twitch'
  | 'instagram'
  | 'discord'
  | 'kick'
  | 'facebook'
  | 'linkedin'
  | 'github'
  | 'reddit';

/** Social media object */
export interface SocialMediaObject {
  [platform: string]: string;
}

// ==================== EVENTSUB MANAGER TYPES ====================

/** Subscription priority */
export type SubscriptionPriority = 'high' | 'medium' | 'low';

/** EventSub subscription configuration */
export interface SubscriptionConfig {
  type: string;
  version: string;
  condition: (broadcasterId: string) => Record<string, string>;
  requiredScopes: string[];
  tokenType: 'app' | 'user';
  priority: SubscriptionPriority;
}

/** Subscription record stored in user data */
export interface SubscriptionRecord {
  id: string;
  type: string;
  version: string;
  created_at: string;
  status?: string;
}

/** Subscription creation result */
export interface SubscriptionCreationResult {
  success: boolean;
  id?: string;
  version?: string;
  alreadyExists?: boolean;
  error?: string;
}

/** Subscription cleanup result */
export interface SubscriptionCleanupResult {
  success: boolean;
  deleted: number;
  found?: number;
  errors?: string[];
  error?: string;
}

/** Subscription status result */
export interface SubscriptionStatusResult {
  success: boolean;
  userId?: string;
  callbackUrl?: string;
  total?: number;
  enabled?: number;
  byStatus?: Record<string, Array<{
    type: string;
    version: string;
    createdAt: string;
  }>>;
  issues?: boolean;
  error?: string;
}

// ==================== API MANAGER TYPES ====================

/** Rate limit bucket */
export interface RateLimitBucket {
  points: number;
  remaining: number;
  resetAt: number;
  perMinute: number;
}

/** Retry configuration */
export interface RetryConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  factor: number;
  jitter: boolean;
}

/** Token cache entry */
export interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

/** Scopes cache entry */
export interface ScopesCacheEntry {
  scopes: string[];
  expiresAt: number;
}

/** API usage statistics */
export interface APIUsageStats {
  buckets: Record<string, RateLimitBucket>;
  endpoints: Record<string, number>;
}

// ==================== STREAM INFO TYPES ====================

/** Stream info result */
export interface StreamInfoResult {
  success: boolean;
  isLive: boolean;
  data?: {
    viewerCount: number;
    startedAt: string | null;
    title: string;
    gameId: string;
    gameName: string;
    thumbnailUrl: string | null;
  };
  error?: string;
}

/** Chat message send result */
export interface ChatMessageResult {
  success: boolean;
  message_id?: string;
  error?: string;
}

/** Stream update result */
export interface StreamUpdateResult {
  updated: number;
  errors: number;
}

/** EventSub batch result */
export interface EventSubBatchResult {
  success: number;
  failures: number;
}

// ==================== TOKEN TYPES ====================

/** Twitch token data */
export interface TwitchTokenData {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  scopes?: string[];
  twitch_user_id?: string;
  twitch_login?: string;
  twitch_display_name?: string;
  webhook_secret?: string;
  subscriptions?: SubscriptionRecord[];
}

/** Twitch tokens container */
export interface TwitchTokens {
  streamer?: TwitchTokenData;
  bot?: TwitchTokenData;
}
