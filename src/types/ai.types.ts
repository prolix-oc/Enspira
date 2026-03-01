/**
 * AI and LLM type definitions for Enspira
 * Based on OpenAI-compatible API schemas and internal structures
 */

// Message roles
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

// Chat message structure (OpenAI-compatible)
export interface ChatMessage {
  role: MessageRole;
  content: string | ContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

// Content parts for multimodal messages
export type ContentPart = TextContentPart | ImageContentPart;

export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface ImageContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'low' | 'high' | 'auto';
  };
}

// Tool definitions
export interface ToolDefinition {
  type: 'function';
  function: FunctionDefinition;
}

export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
}

// Tool calls in responses
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// Chat completion request (OpenAI-compatible)
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  tools?: ToolDefinition[];
  tool_choice?: 'none' | 'auto' | 'required' | ToolChoice;
  response_format?: ResponseFormat;
}

export interface ToolChoice {
  type: 'function';
  function: {
    name: string;
  };
}

export interface ResponseFormat {
  type: 'text' | 'json_object' | 'json_schema';
  json_schema?: {
    name: string;
    strict?: boolean;
    schema: JSONSchema;
  };
}

// Chat completion response (OpenAI-compatible)
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: CompletionUsage;
  system_fingerprint?: string;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: FinishReason;
  logprobs?: LogProbs | null;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call';

export interface LogProbs {
  content: LogProbContent[] | null;
}

export interface LogProbContent {
  token: string;
  logprob: number;
  bytes: number[] | null;
  top_logprobs: TopLogProb[];
}

export interface TopLogProb {
  token: string;
  logprob: number;
  bytes: number[] | null;
}

export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// Streaming response chunk
export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: Partial<ChatMessage>;
  finish_reason: FinishReason | null;
}

// Embedding request/response
export interface EmbeddingRequest {
  input: string | string[];
  model: string;
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
}

export interface EmbeddingResponse {
  object: 'list';
  data: EmbeddingData[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

export interface EmbeddingData {
  object: 'embedding';
  index: number;
  embedding: number[];
}

// Moderation request/response
export interface ModerationRequest {
  input: string | string[];
  model?: string;
}

export interface ModerationResponse {
  id: string;
  model: string;
  results: ModerationResult[];
}

export interface ModerationResult {
  flagged: boolean;
  categories: ModerationCategories;
  category_scores: ModerationCategoryScores;
}

export interface ModerationCategories {
  hate: boolean;
  'hate/threatening': boolean;
  harassment: boolean;
  'harassment/threatening': boolean;
  'self-harm': boolean;
  'self-harm/intent': boolean;
  'self-harm/instructions': boolean;
  sexual: boolean;
  'sexual/minors': boolean;
  violence: boolean;
  'violence/graphic': boolean;
}

export interface ModerationCategoryScores {
  hate: number;
  'hate/threatening': number;
  harassment: number;
  'harassment/threatening': number;
  'self-harm': number;
  'self-harm/intent': number;
  'self-harm/instructions': number;
  sexual: number;
  'sexual/minors': number;
  violence: number;
  'violence/graphic': number;
}

// RAG context types
export interface RAGContext {
  content: string;
  source: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface RAGQueryResult {
  contexts: RAGContext[];
  query: string;
  totalResults: number;
}

// Vector search types (Milvus)
export interface VectorSearchParams {
  collection: string;
  vector: number[];
  topK: number;
  filter?: string;
  outputFields?: string[];
}

export interface VectorSearchResult {
  id: string | number;
  score: number;
  content: string;
  metadata?: Record<string, unknown>;
}

// Expression parsing types
export type ExpressionType =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'surprised'
  | 'thinking'
  | 'embarrassed'
  | 'excited'
  | string;

export interface ParsedExpression {
  type: ExpressionType;
  intensity: number;
  text: string;
}

export interface ExpressionParseResult {
  expressions: ParsedExpression[];
  cleanText: string;
  hasExpressions: boolean;
}

// Internal request types for Enspira
export interface ChatRequestInput {
  message: string;
  user: string;
  firstMessage?: boolean;
  context?: Record<string, unknown>;
}

export interface ChatRequestOutput {
  response: string;
  audio_url?: string;
  expressions?: ParsedExpression[];
  usage?: CompletionUsage;
  processingTime?: number;
}

export interface EventRequestInput {
  eventType: string;
  eventData: Record<string, unknown>;
  user?: string;
}

export interface VoiceRequestInput {
  message: string;
  user?: string;
}

// Reranking types
export interface RerankRequest {
  query: string;
  documents: string[];
  model?: string;
  top_n?: number;
}

export interface RerankResult {
  index: number;
  document: string;
  relevance_score: number;
}

export interface RerankResponse {
  results: RerankResult[];
  model: string;
}

// Classification types
export interface ClassificationRequest {
  text: string;
  labels: string[];
}

export interface ClassificationResult {
  label: string;
  score: number;
}

export interface ClassificationResponse {
  results: ClassificationResult[];
}

// ============================================
// Web RAG Types
// ============================================

/** Structured error for RAG operations */
export interface RagError {
  success: false;
  error: true;
  stage: string;
  message: string;
  details?: unknown;
  timestamp: string;
  optedOut?: boolean;
  reason?: string;
  noSearchNeeded?: boolean;
}

/** Successful search inference result */
export interface SearchInferenceSuccess {
  success: true;
  searchTerm: string;
  freshness?: string;
  subject?: string;
}

/** Failed search inference result */
export interface SearchInferenceFailure {
  success: false;
  optedOut?: boolean;
  reason?: string;
  message?: string;
}

export type SearchInferenceResult = SearchInferenceSuccess | SearchInferenceFailure;

/** URL object for web scraping */
export interface WebUrl {
  url: string;
  source?: string;
  title?: string;
}

/** Rerank item from reranking API (different from RerankResult) */
export interface RerankItem {
  index: number;
  score: number;
  relevance_score?: number;
}

/** Context item for reranking */
export interface ContextItem {
  text_content?: string;
  summary?: string;
  relation?: string;
}

/** Emotion classification result */
export interface EmotionResult {
  label: string;
  score: number;
}

// ============================================
// Location & Weather Types
// ============================================

/** IP geolocation response */
export interface GeoLocationResponse {
  status: 'success' | 'fail';
  message?: string;
  country?: string;
  regionName?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
}

/** Processed location data */
export interface LocationData {
  latitude: string | number;
  longitude: string | number;
  timezone: string;
}

/** Weather API current conditions */
export interface WeatherCurrent {
  temperature_2m: number;
  is_day: number;
  precipitation: number;
  rain: number;
  showers: number;
  snowfall: number;
  cloud_cover: number;
  wind_speed_10m: number;
}

/** Weather API response */
export interface WeatherResponse {
  current: WeatherCurrent;
}

// ============================================
// Auth Types
// ============================================

/** Auth check result */
export interface AuthCheckResult {
  valid: boolean;
  user_id?: string;
  api_token?: string;
  [key: string]: unknown;
}

// ============================================
// LLM Request Body Types
// ============================================

/** Input data for building chat prompts */
export interface ChatPromptData {
  systemPrompt: string;
  characterDescription?: string;
  characterPersonality?: string;
  worldInfo?: string;
  scenario?: string;
  playerInfo?: string;
  recentChat?: string;
  weatherInfo?: string;
  additionalContext?: Record<string, string>;
  userMessage: string;
}

/** Base interface for LLM request bodies */
export interface BaseLLMRequestBody {
  model?: string;
  messages: ChatMessage[];
  stream: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  max_tokens?: number;
}

/** Chat sampler configuration */
export interface ChatSamplerValues {
  model: string;
  topK: number;
  minP: number;
  xtcThreshold: number;
  xtcProbability: number;
  topP: number;
  typicalP: number;
  minTokens: number;
  repetitionPenalty: number;
  presencePenalty: number;
  repetitionRange: number;
  presenceRange: number;
  temperature: number;
  maxTokens: number;
  generateWindow: number;
  dynTemp?: boolean;
  dynTempMin?: number;
  dynTempMax?: number;
}

/** Tool sampler configuration */
export interface ToolSamplerValues {
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  generateWindow?: number;
  maxTokens?: number;
}

/** JSON schema for query responses */
export interface QueryResponseSchema {
  valid: boolean;
  searchTerm: string;
  subject: string;
  vectorString: string;
  freshness: string;
  reason: string;
}

/** JSON schema for moderation responses */
export interface ModerationResponseSchema {
  actionNeeded: boolean;
  actionType: string;
  reason: string;
}

/** JSON schema for summary responses */
export interface SummaryResponseSchema {
  vectorString: string;
  summaryContents: string;
}

/** JSON schema for chain-of-thought responses */
export interface ChainOfThoughtResponseSchema {
  thoughts: string[];
  final_response: string;
}

// ============================================
// Expression Parser Types
// ============================================

/** Parsed expression from AI response */
export interface ParsedExpressionTag {
  expression: string;
  textPosition: number;
  originalTag: string;
  isValid: boolean;
}

/** Result of parsing expressions from text */
export interface ExpressionParseOutput {
  cleanText: string;
  expressions: ParsedExpressionTag[];
}

/** Expression with timing information */
export interface TimedExpression {
  expression: string;
  startTime: number;
  duration: number;
  endTime: number;
  textPosition: number;
  isValid: boolean;
}

/** Options for audio duration estimation */
export interface AudioDurationOptions {
  wordsPerMinute?: number;
  pauseFactor?: number;
  minimumDuration?: number;
  maximumDuration?: number;
}

/** Options for expression processing */
export interface ExpressionProcessingOptions {
  enableDebugLogging?: boolean;
  estimateDuration?: boolean;
  validateExpressionList?: boolean;
  maxProcessingTime?: number;
}

/** Debug information for expression processing */
export interface ExpressionDebugInfo {
  originalLength: number;
  cleanLength: number;
  removedCharacters: number;
  expressionCount: number;
  validExpressions: number;
  invalidExpressions: string[];
  availableExpressionCount: number;
  expressionCoverage: string;
}

/** Result of processing response with expressions */
export interface ExpressionProcessingResult {
  success: boolean;
  originalText: string;
  cleanText: string;
  expressions: TimedExpression[];
  estimatedDuration?: number;
  debug?: ExpressionDebugInfo | null;
  error?: string;
}

/** Expression cache statistics */
export interface ExpressionCacheStats {
  cacheSize: number;
  maxCacheSize: number;
  cacheKeys: string[];
}

// ============================================
// LLM Client Types (Phase 6)
// ============================================

/** Model configuration for LLM requests */
export interface ModelConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  modelType?: string;
  maxTokens?: number;
}

/** Result from tool completion requests */
export interface ToolCompletionResult {
  response?: unknown;
  rawResponse?: string;
  processingTime?: string;
  jsonFixed?: boolean;
  error?: string;
}

/** Result from chat completion requests */
export interface ChatCompletionResult {
  response?: string;
  thoughtProcess?: string;
  timeToFirstToken?: string | null;
  tokensPerSecond?: string | number;
  requestId?: string;
  metadata?: {
    totalTokens?: number;
    totalTime?: string;
    endpoint?: string;
    model?: string;
  };
  error?: string;
  details?: {
    endpoint?: string;
    model?: string;
    hasApiKey?: boolean;
  };
}

/** Result from chain-of-thought completion requests */
export interface CoTCompletionResult {
  response?: string;
  thoughtProcess?: string[];
  timeToFirstToken?: string | null;
  tokensPerSecond?: string | number;
  rawResponse?: string;
  error?: string;
}

// ============================================
// Prompt Builder Types (Phase 6)
// ============================================

/** Social media placeholder replacements */
export interface SocialMediaReplacements {
  '{{socials}}': string;
  [key: `{{socials.${string}}}`]: string;
  '{{soc_tiktok}}'?: string;
  '{{soc_youtube}}'?: string;
  '{{soc_twitter}}'?: string;
  '{{soc_instagram}}'?: string;
}

/** Contents loaded from prompt files */
export interface PromptFileContents {
  character_personality?: string;
  world_lore?: string;
  scenario?: string;
  character_card?: string;
  weather?: string;
  twitch_chat?: string;
  player_info?: string;
  voice_messages?: string;
  [key: string]: string | undefined;
}

/** Template placeholder replacements */
export interface TemplateReplacements {
  '{{user}}'?: string;
  '{{char}}'?: string;
  '{{char_limit}}'?: string | number;
  '{{chat_user}}'?: string;
  '{{model_author}}'?: string;
  '{{model_org}}'?: string;
  '{{twitch}}'?: string;
  '{{modlist}}'?: string;
  '{{sites}}'?: string;
  '{{datetime}}'?: string;
  '{{query}}'?: string;
  [key: string]: string | number | undefined;
}

/** Input data for context-aware chat prompts */
export interface ContextPromptData {
  chat_user: string;
  user?: string;
  relContext?: string;
  relChats?: string | string[];
  relVoice?: string | string[];
}

/** Structured prompt data for LLM request building */
export interface StructuredPromptData {
  systemPrompt: string;
  characterDescription?: string;
  characterPersonality?: string;
  worldInfo?: string;
  scenario?: string;
  playerInfo?: string;
  recentChat?: string;
  weatherInfo?: string;
  additionalContext?: {
    contextResults?: string;
    chatHistory?: string;
    voiceInteractions?: string;
    recentVoice?: string;
    emotionalAssessment?: string;
    dateTime?: string;
  };
  userMessage: string;
  isChainOfThought?: boolean;
}

// ============================================
// Message Utils Types (Phase 6)
// ============================================

/** Result from TTS string fixing */
export interface TTSFixResult {
  fixedString: string;
  acronymCount: number;
  jsCount: number;
}

/** Cache entry for moderation prompts */
export interface ModerationCacheEntry {
  prompt: BaseLLMRequestBody;
  timestamp: number;
}

/** Prompt helper cache statistics */
export interface PromptHelperCacheStats {
  templateCacheSize: number;
  moderationCacheSize: number;
  clientPoolSize: number;
}

// ============================================
// Chat Handler Types (Phase 7)
// ============================================

/** Incoming chat data from various sources */
export interface ChatData {
  message: string;
  user: string;
  userId?: string;
  firstMessage?: boolean;
  badges?: string[];
  emotes?: ChatEmote[];
  emoteCount?: number;
  color?: string;
  source?: 'eventsub' | 'api' | string;
}

/** Chat emote structure */
export interface ChatEmote {
  id: string;
  code: string;
}

/** Normalized chat message format */
export interface NormalizedChatMessage {
  user: string;
  userId: string | undefined;
  message: string;
  firstMessage: boolean;
  badges: string[];
  emotes: ChatEmote[];
  emoteCount: number;
  color: string | undefined;
  source: 'eventsub' | 'api' | string;
}

/** Rate limit entry for a user */
export interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/** Cached response entry */
export interface ResponseCacheEntry {
  response: ChatHandlerResponse;
  expiresAt: number;
  cachedAt: number;
  size: number;
}

/** Cache statistics for monitoring */
export interface ChatCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  rateLimitHits: number;
  lastCleanup: number;
}

/** Chat response from Twitch send */
export interface TwitchChatResponse {
  success: boolean;
  error?: string;
  messageId?: string;
}

/** Base chat handler response */
export interface ChatHandlerResponse {
  success: boolean;
  processed?: boolean;
  ignored?: boolean;
  reason?: 'bot_user' | 'command' | 'rate_limited' | string;
  response?: string;
  thoughtProcess?: string | null;
  firstTimeChatter?: boolean;
  requiresResponse?: boolean;
  type?: string;
  chatResponse?: TwitchChatResponse;
  summaryString?: string;
  error?: string;
}

/** Chat handler statistics */
export interface ChatHandlerStats {
  responseCache: {
    size: number;
    maxSize: number;
    totalSize: number;
    avgEntrySize: number;
    hitRate: string;
    hits: number;
    misses: number;
    evictions: number;
  };
  rateLimits: {
    activeUsers: number;
    maxUsers: number;
    windowMs: number;
    maxPerWindow: number;
    rateLimitHits: number;
  };
  cacheTtl: number;
  lastCleanup: string;
  memoryEstimate: {
    responseCacheBytes: number;
    rateLimitMapBytes: number;
  };
}

/** Memory pressure relief result */
export interface MemoryPressureReliefResult {
  before: ChatHandlerStats;
  after: ChatHandlerStats;
  removedResponses: number;
  removedRateLimit: number;
}

/** Event data for first-time chatter */
export interface FirstTimeChatterEventData {
  eventType: 'chat';
  eventData: {
    user: string;
    message: string;
    firstMessage: true;
  };
}

/** EventSub message data format */
export interface EventSubMessageData {
  chatter?: {
    user_name?: string;
    user_id?: string;
    badges?: Array<{ set_id: string }>;
    color?: string;
  };
  message?: {
    text?: string;
    is_first?: boolean;
    fragments?: Array<{
      type: string;
      id?: string;
      text?: string;
    }>;
  };
}

// ============================================
// Milvus Vector DB Types (Phase 8)
// ============================================

/** Milvus collection types */
export type MilvusCollectionType = 'users' | 'intelligence' | 'twitch_chat' | 'vocal' | 'voice' | 'chat';

/** Milvus schema field definition */
export interface MilvusFieldDefinition {
  name: string;
  data_type: number; // DataType enum value
  dim?: number;
  max_length?: number;
  is_primary_key: boolean;
  auto_id?: boolean;
}

/** Milvus index parameters */
export interface MilvusIndexParams {
  field_name: string;
  index_name: string;
  index_type: string;
  metric_type?: string;
  params?: {
    nlist?: number;
    [key: string]: unknown;
  };
}

/** Milvus collection schema */
export interface MilvusCollectionSchema {
  collection_name: string;
  consistency_level?: number;
  schema: MilvusFieldDefinition[];
  index_params: MilvusIndexParams[];
}

/** Collection load status cache entry */
export interface CollectionLoadStatus {
  loaded: boolean;
  timestamp: number;
}

/** Query cache entry */
export interface QueryCacheEntry<T = unknown> {
  result: T;
  expiry: number;
}

/** Vector insertion data */
export interface VectorInsertData {
  embedding: number[] | Buffer;
  [key: string]: unknown;
}

/** Pending vectors for batch processing */
export interface PendingVectorBatch {
  vectors: VectorInsertData[];
  scheduledAt: number;
}

/** Search options for Milvus queries */
export interface MilvusSearchOptions {
  requireStrongConsistency?: boolean;
  criticalSearch?: boolean;
  maxRetries?: number;
}

/** Optimized search parameters */
export interface OptimizedSearchParams {
  collection_name: string;
  data: Buffer | number[];
  topk: number;
  metric_type: string;
  output_fields: string[];
  vector_type: number;
  search_params: unknown;
  consistency_level: number;
}

/** Milvus search response */
export interface MilvusSearchResponse {
  results: MilvusSearchResult[];
}

/** Individual search result from Milvus */
export interface MilvusSearchResult {
  id?: string | number;
  score?: number;
  text_content?: string;
  relation?: string;
  username?: string;
  raw_msg?: string;
  ai_message?: string;
  time_stamp?: number;
  summary?: string;
  user_message?: string;
  ai_resp?: string;
  date_time?: string;
  gender?: string;
  age?: number;
  residence?: string;
  [key: string]: unknown;
}

/** User info for vector storage */
export interface MilvusUserInfo {
  username: string;
  gender?: string;
  age?: number;
  residence?: string;
}

// ============================================
// Embedding Types (Phase 8)
// ============================================

/** Embedding API configuration */
export interface EmbeddingApiConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  apiKeyType?: 'infinity' | 'enspiraEmb' | 'openai';
}

/** Embedding generation result */
export interface EmbeddingResult {
  embedding: number[];
  model: string;
  usage?: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// ============================================
// RAG Context Types (Phase 8)
// ============================================

/** Web search result item */
export interface WebSearchResultItem {
  url: string;
  title: string;
  source: string;
}

/** Summary response from LLM */
export interface SummaryResult {
  vectorString: string;
  summaryContents: string;
  error?: string;
}

/** Search inference parameters */
export interface SearchInferenceParams {
  searchTerm: string;
  subject: string;
  freshness: string;
  vectorString: string;
}

/** Document comparison result for sync */
export interface DocumentComparisonResult {
  missing: DocumentUpsertData[];
  update: DocumentUpsertData[];
  remove: Array<{ relation: string }>;
}

/** Document data for upsert */
export interface DocumentUpsertData {
  relation: string;
  text_content: string;
  embedding: number[];
}

// ============================================
// AI Engine Types (Phase 8)
// ============================================

/** User expressions storage with TTL */
export interface UserExpressionsEntry {
  expressions: string[];
  lastAccess: number;
}

/** Context data for prompt building */
export interface PromptContextData {
  relChats: string | string[];
  relContext: string;
  relVoice: string | string[];
  chat_user: string;
  user?: string;
}

/** Response from respondWithContext */
export interface ContextualResponse {
  response: string;
  thoughtProcess?: string | string[];
  isErrorResponse?: boolean;
  metadata?: {
    contextId: string;
    timeToFirstToken?: string | null;
    tokensPerSecond?: string | number;
    requestId?: string;
    contextUsed?: {
      documents: number;
      voice: number;
      chat: number;
    };
    endpoint?: string;
    model?: string;
    errorType?: string;
    errorMessage?: string;
  };
}

/** AI chat response */
export interface AIChatResponse {
  success: boolean;
  text?: string;
  response?: string;
  thoughtProcess?: string | string[] | null;
  expressions?: TimedExpression[];
  estimatedDuration?: number;
  metadata?: {
    timestamp: string;
    userId: string;
    username: string;
    expressionCount?: number;
    debug?: ExpressionDebugInfo | null;
  };
  error?: string;
  details?: string;
}

/** Expression-enhanced response */
export interface ExpressionEnhancedResponse {
  success: boolean;
  cleanText: string;
  expressions: TimedExpression[];
  estimatedDuration?: number;
  thoughtProcess?: string | string[];
  debug?: ExpressionDebugInfo | null;
  error?: string;
  details?: string;
  contextId?: string;
}

// ============================================
// Response Generator Types (Phase 8)
// ============================================

/** Voice response result */
export interface VoiceResponseResult {
  response: string;
  audio_url?: string;
  expressions?: TimedExpression[];
  estimatedDuration?: number;
  thoughtProcess?: string | string[];
  debug?: ExpressionDebugInfo | null;
  error?: string;
}

/** TTS generation parameters for Fish TTS */
export interface FishTTSParameters {
  text: string;
  chunk_length: number;
  format: string;
  reference_id: string;
  seed: null | number;
  normalize: boolean;
  streaming: boolean;
  max_new_tokens: number;
  top_p: number;
  repetition_penalty: number;
  temperature: number;
}

/** Event response result */
export interface EventResponseResult {
  response: string;
  thoughtProcess?: string | string[];
  error?: string;
}

/** Milvus health check result */
export interface MilvusHealthResult {
  isHealthy: boolean;
  timestamp: number;
  error?: string;
  metrics?: {
    collections?: Record<string, CollectionHealthStatus>;
    system?: unknown;
    cache?: {
      queryCache: {
        size: number;
        maxSize: number;
      };
      collectionLoadStatus: {
        size: number;
      };
    };
  };
}

/** Individual collection health status */
export interface CollectionHealthStatus {
  exists: boolean | 'error';
  rowCount?: number;
  loadState?: number | string;
  error?: string;
}

/** Endpoint check result */
export interface EndpointCheckResult {
  healthy: boolean;
  endpoint: string;
  model?: string;
  error?: string;
}

// ============================================
// Fallback Response Types
// ============================================

/** Fallback response determination */
export type FallbackResponseType =
  | 'connection_error'
  | 'timeout'
  | 'rate_limit'
  | 'model_error'
  | 'generic_error';

// ============================================
// Cache Statistics Types
// ============================================

/** Query cache statistics */
export interface QueryCacheStats {
  size: number;
  maxSize: number;
  defaultTtl: number;
}

/** Collection load status statistics */
export interface CollectionLoadStats {
  size: number;
  entries: Record<string, CollectionLoadStatus>;
}

/** Pending vectors statistics */
export interface PendingVectorsStats {
  batchCount: number;
  totalVectors: number;
  batches: Record<string, number>;
}

/** AI engine cache statistics */
export interface AIEngineCacheStats {
  queryCache: QueryCacheStats;
  collectionLoadStatus: CollectionLoadStats;
  pendingVectors: PendingVectorsStats;
  userExpressions: {
    size: number;
    maxSize: number;
  };
}
