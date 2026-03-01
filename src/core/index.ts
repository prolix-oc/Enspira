/**
 * Core module barrel export for Enspira
 * Import from '@/core' for core functionality
 * @module core
 */

// Re-export all core modules
export * from './logger.js';
export * from './config.js';
export * from './tokenizer.js';
export * from './database.js';
export * from './api-helper.js';
export * from './data-helper.js';
export * from './llm-requests.js';
export * from './expression-parser.js';
export * from './llm-client.js';
export * from './prompt-builder.js';
export * from './message-utils.js';
export * from './chat-handler.js';
export * from './vector-db.js';
export * from './embeddings.js';
export * from './rag-context.js';
export * from './ai-engine.js';
export * from './response-generator.js';

// Extension system exports
export * from './event-bus.js';
export * from './extension-registry.js';
export * from './extension-loader.js';
export * from './extension-worker.js';
export * from './extension-installer.js';

// Import for grouped access
import {
  createLogger,
  getLogger,
  ensureGlobalLogger,
  setGlobalLogger,
  logger,
  logConsole,
  type Logger,
  type LogLevel,
  type LoggerOptions,
  type LogConsole,
  type BlessedScreen,
  type BlessedLogBox,
} from './logger.js';

import {
  loadConfig,
  retrieveConfigValue,
  saveConfigValue,
  saveConfigToDisk,
  reloadConfig,
  findClosestKey,
  getAllConfigPaths,
  hasConfigValue,
  getConfigValueType,
  type ConfigValueType,
  type ConfigObject,
  type FuzzyMatchResult,
} from './config.js';

import {
  countTokens,
  getPromptCount,
  getPromptTokens,
  getOutputTokens,
  promptTokenizedFromRemote,
  encode,
  decode,
  truncateToTokenLimit,
  getEncoderForModel,
  getEncodingForModel,
  clearEncoderCache,
  getEncoderCacheStats,
  type EncodingType,
  type ChatMessage,
  type MessageRequestBody,
} from './tokenizer.js';

import {
  connectToMongoDB,
  disconnect,
  getUserById,
  getAllUsers,
  createUser,
  updateUserData,
  ensureUserPath,
  addAlternateSpelling,
  removeAlternateSpelling,
  storeChatMessage,
  getChatCount,
  getRecentChats,
  findRelevantChatContext,
  checkDatabaseHealth,
  flushAllChanges,
  isConnected,
  getCacheStats,
  UserModel,
  ChatMessageModel,
} from './database.js';

import {
  loadAPIKeys,
  returnAPIKeys,
  returnAuthObject,
  ensureParameterPath,
  updateUserParameter,
  saveAuthToDisk,
  checkForAuth,
  funFact,
  initAllAPIs,
} from './api-helper.js';

import {
  createRagError,
  maintainVoiceContext,
  axiosRequestWithRetry,
  startWebResults,
  resultsReranked,
  interpretEmotions,
  pullFromWeb,
  pullFromWebScraper,
} from './data-helper.js';

import {
  ChatRequestBody,
  ChatRequestBodyCoT,
  ToolRequestBody,
  QueryRequestBody,
  ModerationRequestBody,
  SummaryRequestBody,
  ConvertDocsRequestBody,
} from './llm-requests.js';

import {
  parseExpressions,
  calculateExpressionTimings,
  estimateAudioDuration,
  generateExpressionPrompt,
  validateExpressions,
  processResponseWithExpressions,
  createExpressionDebugInfo,
  clearExpressionCache,
  getExpressionStats,
} from './expression-parser.js';

import {
  getOpenAIClient,
  clearClientPool,
  getClientPoolSize,
  sendToolCompletionRequest,
  sendChatCompletionRequest,
  sendChatCompletionRequestCoT,
} from './llm-client.js';

import {
  clearTemplateCache,
  getTemplateCacheStats,
  clearModerationCache,
  getSocialMediaReplacements,
  readPromptFiles,
  moderatorPrompt,
  contextPromptChat,
  contextPromptChatCoT,
  eventPromptChat,
  queryPrompt,
  rerankPrompt,
  summaryPrompt,
  clearPromptHelperCaches,
  runCacheCleanup,
} from './prompt-builder.js';

import {
  escapeRegExp,
  replyStripped,
  fixTTSString,
  filterCharacterFromMessage,
  containsCharacterName,
  containsPlayerSocials,
  containsAuxBotName,
} from './message-utils.js';

import {
  handleChatMessage,
  handleChatMessageBatch,
  normalizeMessageFormat,
  getChatHandlerStats,
  clearChatHandlerCache,
  relieveMemoryPressure,
  stopCleanupInterval,
  stopMemoryReliefInterval,
} from './chat-handler.js';

import { getEventBus } from './event-bus.js';
import { getExtensionRegistry } from './extension-registry.js';
import { getExtensionLoader } from './extension-loader.js';
import { getWorkerPool } from './extension-worker.js';
import { getExtensionInstaller } from './extension-installer.js';

/**
 * Grouped core exports for convenient namespace access
 *
 * @example
 * ```ts
 * import { core } from '@/core';
 *
 * core.log.info('MyModule', 'Starting up...');
 * const model = await core.config.retrieveConfigValue('models.chat.model');
 * const tokens = core.tokenizer.countTokens('Hello world', 'gpt-4');
 * ```
 */
export const core = {
  /** Logging utilities */
  log: {
    createLogger,
    getLogger,
    ensureGlobalLogger,
    setGlobalLogger,
    logger,
    logConsole,
  },

  /** Configuration management */
  config: {
    loadConfig,
    retrieveConfigValue,
    saveConfigValue,
    saveConfigToDisk,
    reloadConfig,
    findClosestKey,
    getAllConfigPaths,
    hasConfigValue,
    getConfigValueType,
  },

  /** Token counting and encoding */
  tokenizer: {
    countTokens,
    getPromptCount,
    getPromptTokens,
    getOutputTokens,
    promptTokenizedFromRemote,
    encode,
    decode,
    truncateToTokenLimit,
    getEncoderForModel,
    getEncodingForModel,
    clearEncoderCache,
    getEncoderCacheStats,
  },

  /** Database operations */
  db: {
    connectToMongoDB,
    disconnect,
    getUserById,
    getAllUsers,
    createUser,
    updateUserData,
    ensureUserPath,
    addAlternateSpelling,
    removeAlternateSpelling,
    storeChatMessage,
    getChatCount,
    getRecentChats,
    findRelevantChatContext,
    checkDatabaseHealth,
    flushAllChanges,
    isConnected,
    getCacheStats,
    UserModel,
    ChatMessageModel,
  },

  /** API helper operations */
  api: {
    loadAPIKeys,
    returnAPIKeys,
    returnAuthObject,
    ensureParameterPath,
    updateUserParameter,
    saveAuthToDisk,
    checkForAuth,
    funFact,
    initAllAPIs,
  },

  /** Data helper operations */
  data: {
    createRagError,
    maintainVoiceContext,
    axiosRequestWithRetry,
    startWebResults,
    resultsReranked,
    interpretEmotions,
    pullFromWeb,
    pullFromWebScraper,
  },

  /** LLM request body builders */
  llm: {
    ChatRequestBody,
    ChatRequestBodyCoT,
    ToolRequestBody,
    QueryRequestBody,
    ModerationRequestBody,
    SummaryRequestBody,
    ConvertDocsRequestBody,
  },

  /** Expression parsing operations */
  expressions: {
    parseExpressions,
    calculateExpressionTimings,
    estimateAudioDuration,
    generateExpressionPrompt,
    validateExpressions,
    processResponseWithExpressions,
    createExpressionDebugInfo,
    clearExpressionCache,
    getExpressionStats,
  },

  /** LLM client and completion operations */
  client: {
    getOpenAIClient,
    clearClientPool,
    getClientPoolSize,
    sendToolCompletionRequest,
    sendChatCompletionRequest,
    sendChatCompletionRequestCoT,
  },

  /** Prompt building operations */
  prompts: {
    clearTemplateCache,
    getTemplateCacheStats,
    clearModerationCache,
    getSocialMediaReplacements,
    readPromptFiles,
    moderatorPrompt,
    contextPromptChat,
    contextPromptChatCoT,
    eventPromptChat,
    queryPrompt,
    rerankPrompt,
    summaryPrompt,
    clearPromptHelperCaches,
    runCacheCleanup,
  },

  /** Message processing utilities */
  message: {
    escapeRegExp,
    replyStripped,
    fixTTSString,
    filterCharacterFromMessage,
    containsCharacterName,
    containsPlayerSocials,
    containsAuxBotName,
  },

  /** Chat message handling and routing */
  chat: {
    handleChatMessage,
    handleChatMessageBatch,
    normalizeMessageFormat,
    getChatHandlerStats,
    clearChatHandlerCache,
    relieveMemoryPressure,
    stopCleanupInterval,
    stopMemoryReliefInterval,
  },

  /** Extension system */
  extensions: {
    getEventBus,
    getExtensionRegistry,
    getExtensionLoader,
    getExtensionInstaller,
    getWorkerPool,
  },
} as const;

// Type exports for convenience
export type {
  Logger,
  LogLevel,
  LoggerOptions,
  LogConsole,
  BlessedScreen,
  BlessedLogBox,
  ConfigValueType,
  ConfigObject,
  FuzzyMatchResult,
  EncodingType,
  ChatMessage,
  MessageRequestBody,
};

export default core;
