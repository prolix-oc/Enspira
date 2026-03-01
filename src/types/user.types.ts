/**
 * User type definitions for Enspira
 * Based on MongoDB/Mongoose schema in mongodb-client.js
 */

// Alternate spelling can be a simple string or a from/to mapping
export interface AlternateSpellMapping {
  from: string;
  to: string;
}

export type AlternateSpell = string | AlternateSpellMapping;

// Twitch token data for OAuth
export interface TwitchTokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  twitch_user_id: string;
  twitch_login: string;
  twitch_display_name: string;
  scopes: string[];
}

export interface StreamerTwitchTokenData extends TwitchTokenData {
  webhook_secret: string;
  subscriptions: TwitchSubscription[];
}

export interface TwitchTokens {
  streamer: StreamerTwitchTokenData | null;
  bot: TwitchTokenData | null;
}

// Twitch EventSub subscription stored on user
export interface TwitchSubscription {
  id: string;
  type: string;
  version: string;
  status: TwitchSubscriptionStatus;
  created_at: string;
}

export type TwitchSubscriptionStatus =
  | 'enabled'
  | 'webhook_callback_verification_pending'
  | 'webhook_callback_verification_failed'
  | 'notification_failures_exceeded'
  | 'authorization_revoked'
  | 'moderator_removed'
  | 'user_removed'
  | 'version_removed';

// Social media handles
export interface UserSocials {
  twitter?: string;
  tiktok?: string;
  youtube?: string;
  instagram?: string;
  twitch?: string;
  kick?: string;
}

// TTS equalizer preference
export type TTSEqPreference = 'clarity' | 'warm' | 'flat' | string;

// Stream status information
export interface StreamStatus {
  is_live: boolean;
  started_at?: string;
  game_id?: string;
  game_name?: string;
  title?: string;
  viewer_count?: number;
  thumbnail_url?: string;
}

// Current game information
export interface CurrentGame {
  id: string;
  name: string;
  box_art_url?: string;
}

// Command configuration
export interface UserCommand {
  name: string;
  response: string;
  enabled: boolean;
  cooldown?: number;
}

// Auxiliary bot configuration
export interface AuxBot {
  name: string;
  enabled: boolean;
  prefix?: string;
}

// Complete user document type
export interface User {
  // MongoDB ID
  _id?: string;

  // Required unique identifier
  user_id: string;

  // Authentication fields
  api_token?: string;
  webPasswordHash?: string;
  webPasswordSalt?: string;
  webPasswordIterations: number;

  // User information
  email?: string;
  user_name?: string;
  display_name?: string;

  // Twitch integration
  twitch_name?: string;
  bot_name?: string;
  bot_twitch?: string;

  // Alternate spellings for voice recognition
  alternateSpell: AlternateSpell[];

  // Token and integration data
  twitch_tokens: TwitchTokens;

  // User preferences
  socials: UserSocials;

  // Stream and chat settings
  weather: boolean;
  store_all_chat: boolean;
  commands_list: UserCommand[];
  aux_bots: AuxBot[];
  mod_list: string[];
  approved_sites: string[];

  // TTS settings
  tts_enabled: boolean;
  ttsEqPref: TTSEqPreference;
  ttsUpsamplePref: boolean;
  speaker_file?: string;
  fishTTSVoice?: string;

  // Fun facts settings
  funFacts: boolean;
  funFactsInterval: number;

  // Tracking fields
  lastIp?: string;
  latitude?: string;
  longitude?: string;
  timeZone?: string;

  // Stream status tracking
  current_game?: CurrentGame;
  current_viewers: number;
  current_followers: number;
  stream_status?: StreamStatus;

  // Feature flags
  global_strikes: boolean;
  global_bans: boolean;
  allow_beta_features: boolean;
  is_local: boolean;
  max_chats: number;

  // Mongoose timestamps
  createdAt?: Date;
  updatedAt?: Date;
}

// User creation input (partial, with required fields)
export interface CreateUserInput {
  user_id: string;
  user_name?: string;
  display_name?: string;
  email?: string;
}

// User update input (all fields optional except user_id for lookup)
export type UpdateUserInput = Partial<Omit<User, 'user_id' | '_id' | 'createdAt' | 'updatedAt'>>;

// Cached user with metadata
export interface CachedUser {
  user: User;
  cachedAt: number;
  isDirty: boolean;
}

// User lookup result
export interface UserLookupResult {
  success: boolean;
  user?: User;
  error?: string;
  fromCache?: boolean;
}

// ============================================
// Chat Message Types
// ============================================

/** Chat message metadata */
export interface ChatMessageMetadata {
  firstMessage?: boolean;
  mentionsCharacter?: boolean;
  emoteCount?: number;
  [key: string]: unknown;
}

/** Chat message data structure for database storage */
export interface DbChatMessage {
  user_id: string;
  username: string;
  message: string;
  message_id: string;
  timestamp?: Date;
  ai_response?: string;
  embedding_id?: string;
  is_important?: boolean;
  metadata?: ChatMessageMetadata;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Input for storing a new chat message */
export interface StoreChatMessageInput {
  username: string;
  message: string;
  aiResponse?: string;
  firstMessage?: boolean;
  mentionsCharacter?: boolean;
  emoteCount?: number;
}

/** Result of storing a chat message */
export interface StoreChatMessageResult {
  success: boolean;
  message_id?: string;
  error?: string;
}

/** Formatted chat message for API responses and context retrieval */
export interface FormattedChatMessage {
  username: string;
  raw_msg: string;
  text_content: string;
  ai_message: string;
  time_stamp: number;
}

// ============================================
// Database Cache Types
// ============================================

/** Cache entry structure for user data */
export interface UserCacheEntry {
  data: User;
  expiry: number;
  lastModified: number;
}

/** Database health check result */
export interface DatabaseHealthResult {
  connected: boolean;
  error?: string;
  pendingWrites?: number;
  cachedUsers?: number;
  status?: string | number;
}

/** Options for the caching wrapper */
export interface CachingOptions {
  /** Time-to-live in milliseconds (default: 60000) */
  ttl?: number;
  /** Force fresh fetch from database */
  forceFresh?: boolean;
}

/** Options for finding relevant chat context */
export interface RelevantContextOptions {
  /** Use vector search via Milvus */
  useVectors?: boolean;
  /** Use MongoDB text search */
  simpleTextSearch?: boolean;
}
