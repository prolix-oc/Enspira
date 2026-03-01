/**
 * Configuration type definitions for Enspira
 * Based on config/config.json schema
 */

// Server configuration
export interface ServerEndpoints {
  external: string;
  internal: string;
}

export interface ExternalScraperConfig {
  enabled: boolean;
  endpoint: string;
  deviceType: string;
  caching: string;
}

export interface ServerConfig {
  cookieSecret: string;
  authFilePath: string;
  port: number;
  authRequired: boolean;
  endpoints: ServerEndpoints;
  externalScraper: ExternalScraperConfig;
}

// Brave search configuration
export interface BraveConfig {
  apiKey: string;
}

// Milvus vector database configuration
export interface MilvusCollections {
  intelligence: string;
  voice: string;
  chat: string;
  user: string;
}

export interface MilvusConfig {
  collections: MilvusCollections;
  endpoint: string;
  localTextDirectory: string;
}

// Twitch configuration
export interface TwitchScopes {
  streamer: string[];
  bot: string[];
}

export interface TwitchConfig {
  maxChatsToSave: number;
  maxCharLimit: number;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: TwitchScopes;
}

// Model configuration types
export type ModelType = 'openai' | 'anthropic' | 'tabbyAPI' | 'ollama' | 'openrouter' | string;
export type ApiKeyType = 'bearer' | 'x-api-key' | string;
export type EmbeddingType = 'openai' | 'voyage' | 'cohere' | string;

export interface BaseModelConfig {
  endpoint: string;
  apiKey: string;
  model: string;
}

export interface LLMModelConfig extends BaseModelConfig {
  modelType: ModelType;
  maxTokens: number;
}

export interface SummaryModelConfig extends LLMModelConfig {
  enabled: boolean;
}

export interface ChatModelConfig extends LLMModelConfig {
  author: string;
  organization: string;
}

export interface EmbeddingModelConfig extends BaseModelConfig {
  apiKeyType: ApiKeyType;
  dimensions: number;
  embeddingType: EmbeddingType;
}

export interface RerankModelConfig extends BaseModelConfig {
  apiKeyType: ApiKeyType;
}

export interface ClassifierModelConfig extends BaseModelConfig {
  apiKeyType: ApiKeyType;
}

export interface ModeratorModelConfig extends LLMModelConfig {
  apiKeyType: ApiKeyType;
}

export interface ModelsConfig {
  summary: SummaryModelConfig;
  query: LLMModelConfig;
  chat: ChatModelConfig;
  embedding: EmbeddingModelConfig;
  rerank: RerankModelConfig;
  classifier: ClassifierModelConfig;
  conversion: LLMModelConfig;
  rerankTransform: LLMModelConfig;
  moderator: ModeratorModelConfig;
}

// Sampler configuration
export interface ChatSamplerConfig {
  topK: number;
  maxTokens: number;
  generateWindow: number;
  topP: number;
  typicalP: number;
  minP: number;
  temperature: number;
  minTokens: number;
  repetitionPenalty: number;
  presencePenalty: number;
  xtcThreshold: number;
  xtcProbability: number;
  dynTemp: boolean;
  dynTempMin: number;
  dynTempMax: number;
}

export interface ToolSamplerConfig {
  topK: number;
  topP: number;
  minP: number;
  temperature: number;
  maxTokens: number;
  generateWindow: number;
}

export interface SamplersConfig {
  chat: ChatSamplerConfig;
  tool: ToolSamplerConfig;
}

// TTS configuration
export interface TTSEndpoints {
  internal: string;
  external: string;
}

export interface TTSProviderConfig {
  ttsGenEndpoint: TTSEndpoints;
  ttsServeEndpoint: TTSEndpoints;
  healthcheck: TTSEndpoints;
}

export type TTSPreference = 'alltalk' | 'fishTTS' | string;

// Fun facts configuration
export interface FunFactsConfig {
  key: string;
}

// Extension system configuration
export interface ExtensionsAppConfig {
  /** Whether extensions are enabled */
  enabled: boolean;
  /** Directory containing installed extensions */
  directory: string;
  /** Auto-load extensions on startup */
  autoload: boolean;
  /** Run extensions in isolated worker threads */
  sandbox: boolean;
  /** Permission configuration */
  permissions: {
    /** Default permissions granted to all extensions */
    default: string[];
    /** Permissions that require explicit user approval */
    requireApproval: string[];
  };
}

// Complete application configuration
export interface AppConfig {
  server: ServerConfig;
  brave: BraveConfig;
  milvus: MilvusConfig;
  twitch: TwitchConfig;
  models: ModelsConfig;
  samplers: SamplersConfig;
  funFacts: FunFactsConfig;
  ttsPreference: TTSPreference;
  alltalk: TTSProviderConfig;
  fishTTS: TTSProviderConfig;
  extensions?: ExtensionsAppConfig;
}

// Configuration path type for retrieveConfigValue
export type ConfigPath =
  | `server.${keyof ServerConfig}`
  | `server.endpoints.${keyof ServerEndpoints}`
  | `server.externalScraper.${keyof ExternalScraperConfig}`
  | `milvus.${keyof MilvusConfig}`
  | `milvus.collections.${keyof MilvusCollections}`
  | `twitch.${keyof TwitchConfig}`
  | `twitch.scopes.${keyof TwitchScopes}`
  | `models.${keyof ModelsConfig}`
  | `samplers.${keyof SamplersConfig}`
  | `samplers.chat.${keyof ChatSamplerConfig}`
  | `samplers.tool.${keyof ToolSamplerConfig}`
  | string;
