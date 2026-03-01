/**
 * Server and WebSocket type definitions
 * Types for the main Fastify server and WebSocket connection management
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { WebSocket } from 'ws';
import type { User } from './user.types.js';

// ==================== SERVER OPTIONS ====================

/** Fastify server options */
export interface ServerOptions {
  trustProxy: boolean;
  methodNotAllowed: boolean;
  logger: boolean;
  requestTimeout: number;
  bodyLimit: number;
  routerOptions?: {
    maxParamLength?: number;
    caseSensitive?: boolean;
    ignoreTrailingSlash?: boolean;
    ignoreDuplicateSlashes?: boolean;
    allowUnsafeRegex?: boolean;
  };
  https?: {
    allowHTTP1: boolean;
    key: Buffer;
    cert: Buffer;
  };
  http2?: boolean;
  http?: {
    maxHeaderSize: number;
    keepAliveTimeout: number;
    headersTimeout: number;
  };
}

// ==================== WEBSOCKET TYPES ====================

/** Connection limits configuration */
export interface ConnectionLimits {
  MAX_CONNECTIONS: number;
  MAX_CONNECTIONS_PER_IP: number;
  MAX_MESSAGE_RATE: number;
  CONNECTION_TIMEOUT: number;
  HEARTBEAT_INTERVAL: number;
  CLEANUP_INTERVAL: number;
  MAX_MESSAGE_SIZE: number;
  AUTH_TIMEOUT: number;
}

/** Rate limit tracking data */
export interface RateLimitData {
  count: number;
  lastReset: number;
  blocked: boolean;
}

/** Model info from VTuber client */
export interface ModelInfo {
  expressions?: string[];
  [key: string]: unknown;
}

/** WebSocket message types */
export type WebSocketMessageType =
  | 'ping'
  | 'pong'
  | 'connection-established'
  | 'auth-required'
  | 'auth-success'
  | 'auth-failed'
  | 'model-info'
  | 'model-info-received'
  | 'text-input'
  | 'response-queued'
  | 'full-text'
  | 'synthesis-started'
  | 'synthesis-complete'
  | 'audio-url'
  | 'interrupt'
  | 'connection-test'
  | 'connection-test-response'
  | 'error';

/** Incoming WebSocket message */
export interface WebSocketMessage {
  type: WebSocketMessageType;
  auth_token?: string;
  text?: string;
  model_info?: ModelInfo;
  [key: string]: unknown;
}

/** Outgoing WebSocket message */
export interface OutgoingWebSocketMessage {
  type: WebSocketMessageType;
  timestamp?: string;
  client_id?: string;
  server_time?: string;
  message?: string;
  user_id?: string;
  response_id?: string;
  text?: string;
  audio_url?: string;
  display_text?: DisplayText;
  actions?: WebSocketActions;
  audio_format?: string;
  sample_rate?: number;
  bit_depth?: number;
  server_info?: ServerInfo;
  connection_stats?: ConnectionStats;
  error_details?: string;
}

/** Display text for VTuber client */
export interface DisplayText {
  text: string;
  name: string;
  avatar: string;
}

/** Actions for VTuber client */
export interface WebSocketActions {
  expressions?: (string | number)[];
}

/** Server info sent on connection */
export interface ServerInfo {
  version: string;
  capabilities: string[];
}

/** Connection statistics */
export interface ConnectionStats {
  messages_processed: number;
  connected_duration: number;
  last_activity: number;
}

/** Event listener tracking entry */
export interface EventListenerEntry {
  event: string;
  handler: (...args: unknown[]) => void;
}

/** Send message result */
export interface SendMessageResult {
  success: boolean;
  reason?: string;
  error?: string;
}

/** Connection validation result */
export interface ConnectionValidation {
  valid: boolean;
  reason?: string;
}

/** WebSocket status response */
export interface WebSocketStatusResponse {
  websocket_enabled: boolean;
  active_connections: number;
  cleanup_queue_size: number;
  rate_limit_entries: number;
  ip_tracking_entries: number;
  connections: ConnectionInfo[];
  memory_info: MemoryInfo;
  system_info: SystemInfo;
}

/** Individual connection info */
export interface ConnectionInfo {
  id: string;
  authenticated: boolean;
  user_id: string | null;
  connected_at: Date;
  socket_state: number | string;
  is_destroyed: boolean;
  processing_message: boolean;
  send_in_progress: boolean;
  message_count: number;
  last_activity: number;
  connection_ip: string;
  auth_attempts: number;
}

/** Memory usage info */
export interface MemoryInfo {
  heap_used: string;
  heap_total: string;
  external: string;
  rss: string;
}

/** System info */
export interface SystemInfo {
  uptime: number;
  timestamp: string;
}

// ==================== PREFLIGHT CHECK TYPES ====================

/** LLM service statuses */
export interface LLMStatuses {
  allTalkIsOnline: boolean;
  embeddingIsOnline: boolean;
  llmIsOnline: boolean;
  summaryIsOnline: boolean;
  queryIsOnline: boolean;
  conversionIsOnline: boolean;
}

/** Preflight check result */
export interface PreflightResult {
  llmStatuses: LLMStatuses;
  restIsOnline: boolean;
  dbIsOnline: boolean;
  websocketEnabled: boolean;
}

/** Initialize app result */
export interface InitializeResult {
  server: FastifyInstance<any, any, any, any, any>;
  status: PreflightResult;
}

// ==================== AUTH TYPES ====================

/** Authentication result from checkForAuth */
export interface AuthResult {
  valid: boolean;
  user_id?: string;
  user_name?: string;
  bot_name?: string;
  avatar_url?: string;
  tts_enabled?: boolean;
  alternateSpell?: AlternateSpelling[];
  [key: string]: unknown;
}

/** Alternate spelling entry */
export type AlternateSpelling = string | { from: string; to: string };

// ==================== EMOTION MAPPING ====================

/** Emotion keywords for expression selection */
export type EmotionType = 'happy' | 'sad' | 'surprised' | 'angry' | 'neutral';

/** Emotion keyword mapping */
export type EmotionKeywords = Record<EmotionType, string[]>;

/** Expression mapping for emotions */
export type ExpressionMapping = Record<EmotionType, (string | number)[]>;
