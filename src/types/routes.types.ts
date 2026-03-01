/**
 * Route type definitions for Enspira
 * Shared types for Fastify route handlers
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { User } from './user.types.js';

// ==================== REQUEST EXTENSION ====================

/** Extended request with user authentication */
export interface AuthenticatedRequest extends FastifyRequest {
  user: User;
}

/** Session token payload */
export interface SessionPayload {
  userId: string;
  exp: number;
}

// ==================== COMMON RESPONSE TYPES ====================

/** Generic success response */
export interface SuccessResponse {
  success: true;
  message: string;
}

/** Generic error response */
export interface ErrorResponse {
  success: false;
  error: string;
}

/** API response with data */
export interface DataResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// ==================== AUTH TYPES ====================

/** Login request body */
export interface LoginRequestBody {
  user_id: string;
  password: string;
}

/** Twitch authenticate request body */
export interface TwitchAuthenticateBody {
  user_id: string;
  password: string;
  auth_type?: 'bot' | 'streamer';
}

/** Twitch callback query */
export interface TwitchCallbackQuery {
  code: string;
  state: string;
}

/** Password hash result */
export interface PasswordHashResult {
  salt: string;
  hash: string;
  iterations: number;
  digest: string;
}

/** Pending Twitch auth entry */
export interface PendingTwitchAuth {
  userId: string;
  createdAt: number;
  authType: 'bot' | 'streamer';
}

// ==================== CHARACTER TYPES ====================

/** Character preset structure */
export interface CharacterPreset {
  id: string;
  name: string;
  author: string;
  summary: string;
  image?: string;
  bot_twitch?: string;
  personality: {
    internalFmt: string;
    publicFmt: string;
  };
  char_description: {
    internalFmt: string;
    publicFmt: string;
  };
}

/** Voice upload file data */
export interface VoiceUploadFile {
  name: string;
  data: string;
}

/** Voice upload request body */
export interface VoiceUploadBody {
  files?: VoiceUploadFile[];
}

/** WAV validation result */
export interface WavValidationResult {
  valid: boolean;
  reason?: string;
  sampleRate?: number;
  numChannels?: number;
  bitsPerSample?: number;
  duration?: number;
  format?: string;
  closestStandardRate?: number;
}

// ==================== FORM DATA TYPES ====================

/** Multipart form field (can be string, Part object, or stream) */
export interface FormField {
  value?: string;
  pipe?: (destination: NodeJS.WritableStream) => NodeJS.WritableStream;
}

/** Profile settings form body */
export interface ProfileSettingsBody {
  display_name?: string | FormField;
  user_name?: string | FormField;
  email?: string | FormField;
  timeZone?: string | FormField;
}

/** Social settings form body */
export interface SocialSettingsBody {
  'socials[twitter]'?: string | FormField;
  'socials[tiktok]'?: string | FormField;
  'socials[youtube]'?: string | FormField;
  'socials[instagram]'?: string | FormField;
  'socials[twitch]'?: string | FormField;
  'socials[kick]'?: string | FormField;
}

/** Password settings form body */
export interface PasswordSettingsBody {
  current_password?: string | FormField;
  new_password?: string | FormField;
  confirm_password?: string | FormField;
}

/** Character features form body */
export interface CharacterFeaturesBody {
  funFacts?: string | FormField;
  funFactsInterval?: string | FormField;
  tts_enabled?: string | FormField;
  ttsEqPref?: string | FormField;
  ttsUpsamplePref?: string | FormField;
}

/** Character personality form body */
export interface CharacterPersonalityBody {
  bot_name?: string | FormField;
  personality?: string | FormField;
}

/** Character description form body */
export interface CharacterDescriptionBody {
  description?: string | FormField;
  bot_twitch?: string | FormField;
}

/** World info form body */
export interface WorldInfoBody {
  world_info?: string | FormField;
  weather_enabled?: string | FormField;
}

/** Player info form body */
export interface PlayerInfoBody {
  player_info?: string | FormField;
  commands_list?: string | FormField;
}

/** Scenario form body */
export interface ScenarioBody {
  scenario?: string | FormField;
  aux_bots?: string | FormField;
}

/** Preferences form body */
export interface PreferencesBody {
  store_all_chat?: string | FormField;
  tts_enabled?: string | FormField;
  ttsEqPref?: string | FormField;
  ttsUpsamplePref?: string | FormField;
}

// ==================== ALTERNATE SPELLING TYPES ====================

/** Alternate spelling - simple or mapping */
export type AlternateSpelling = string | { from: string; to: string };

/** Add alternate spelling body */
export interface AddAlternateSpellingBody {
  spelling: AlternateSpelling;
}

/** Test alternate spelling body */
export interface TestAlternateSpellingBody {
  text: string;
}

/** Replacement result */
export interface SpellingReplacement {
  from: string;
  to: string;
  occurrences: number;
}

// ==================== TWITCH EVENTSUB TYPES ====================

/** EventSub health result */
export interface EventSubHealthResult {
  timestamp: string;
  overall: 'healthy' | 'degraded' | 'unhealthy' | 'error';
  uptime: number;
  memoryUsage: NodeJS.MemoryUsage;
  twitch: {
    appTokenValid?: boolean;
    appTokenError?: string;
    externalEndpoint?: string;
    externalEndpointIssues?: string[];
    events: {
      eventsProcessed: number;
      successRate: string;
      averageResponseTime: number;
      chatMessagesProcessed: number;
    };
    subscriptions?: {
      total: number;
      byStatus: Record<string, number>;
      maxAllowed: number;
      currentCost: number;
      problemSubscriptions: Array<{
        type: string;
        status: string;
        condition: Record<string, string>;
        createdAt: string;
      }>;
      warnings?: string[];
      errors?: string[];
      error?: string;
      hint?: string;
    };
    userDetails?: {
      userId: string;
      hasStreamerToken: boolean;
      hasBotToken: boolean;
      hasWebhookSecret: boolean;
      twitchUserId: string | null;
      callbackUrl: string;
      storedSubscriptions: number;
      error?: string;
    };
  };
}

/** Test event request body */
export interface TestEventBody {
  eventType: string;
  eventData: Record<string, unknown>;
  eventVersion?: string;
}

/** Subscribe to event body */
export interface SubscribeEventBody {
  userId: string;
  type: string;
  condition?: Record<string, string>;
}

/** EventSub notification structure */
export interface EventSubNotification {
  subscription: {
    id: string;
    type: string;
    version: string;
    status: string;
  };
  event: Record<string, unknown>;
  challenge?: string;
}

// ==================== TIMEZONE TYPE ====================

/** Timezone option */
export interface TimezoneOption {
  value: string;
  label: string;
}

// ==================== STREAM STATUS TYPES ====================

/** Dashboard stream status */
export interface DashboardStreamStatus {
  online: boolean;
  title: string;
  game: string;
  viewers: number;
  duration: string;
  thumbnail: string | null;
}

/** Dashboard stats */
export interface DashboardStats {
  chatMessages: number;
}

// ==================== ROUTE PARAMS ====================

/** User ID param */
export interface UserIdParams {
  userId: string;
}

/** Character ID param */
export interface CharacterIdParams {
  characterId: string;
}

/** Event type param */
export interface EventTypeParams {
  eventType: string;
}

/** Filename param */
export interface FilenameParams {
  filename: string;
}

// ==================== QUERY TYPES ====================

/** Health check query */
export interface HealthCheckQuery {
  detailed?: string;
  userId?: string;
}

/** Twitch connect query */
export interface TwitchConnectQuery {
  type?: 'bot' | 'streamer';
}

// ==================== GLOBAL DECLARATIONS ====================

declare global {
  // eslint-disable-next-line no-var
  var pendingTwitchAuths: Map<string, PendingTwitchAuth> | undefined;
}
