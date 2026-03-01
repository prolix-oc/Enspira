/**
 * AI Engine - Main Orchestration
 * Handles chat responses, context retrieval, and response generation
 */

import { performance } from 'node:perf_hooks';

import { logger } from './logger.js';
import { retrieveConfigValue } from './config.js';
import { returnAuthObject } from './api-helper.js';
import {
  findRelevantDocuments,
  findRelevantVoiceInMilvus,
  findRelevantChats,
  addChatMessageAsVector,
} from './rag-context.js';
import { resultsReranked } from './data-helper.js';
import {
  contextPromptChat,
  rerankPrompt,
} from './prompt-builder.js';
import { replyStripped } from './message-utils.js';
import {
  sendChatCompletionRequest,
  sendToolCompletionRequest,
} from './llm-client.js';
import { getCachedResult, setCachedResult, retryMilvusOperation } from './vector-db.js';
import {
  processResponseWithExpressions,
  generateExpressionPrompt,
} from './expression-parser.js';

import type {
  UserExpressionsEntry,
  ContextualResponse,
  AIChatResponse,
  ExpressionEnhancedResponse,
  PromptContextData,
  ModelConfig,
  TimedExpression,
  MilvusSearchResult,
} from '@/types/ai.types.js';

// ==================== USER EXPRESSIONS MANAGEMENT ====================

/** Bounded userExpressions with TTL to prevent unbounded growth */
const MAX_USER_EXPRESSIONS_SIZE = 100;
const USER_EXPRESSIONS_TTL = 3600000; // 1 hour
const userExpressions = new Map<string, UserExpressionsEntry>();

/** Cleanup interval for user expressions */
let expressionCleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the expression cleanup interval
 */
export function startExpressionCleanup(): void {
  if (expressionCleanupInterval) return;

  expressionCleanupInterval = setInterval(() => {
    const now = Date.now();

    // Clean up userExpressions with TTL
    for (const [userId, data] of userExpressions.entries()) {
      if (now - data.lastAccess > USER_EXPRESSIONS_TTL) {
        userExpressions.delete(userId);
      }
    }

    // Enforce size limit on userExpressions with LRU eviction
    if (userExpressions.size > MAX_USER_EXPRESSIONS_SIZE) {
      const sorted = Array.from(userExpressions.entries()).sort(
        (a, b) => a[1].lastAccess - b[1].lastAccess
      );
      const toRemove = userExpressions.size - MAX_USER_EXPRESSIONS_SIZE;
      for (let i = 0; i < toRemove; i++) {
        const entry = sorted[i];
        if (entry) {
          userExpressions.delete(entry[0]);
        }
      }
    }
  }, 300000); // Run every 5 minutes
}

/**
 * Stop the expression cleanup interval
 */
export function stopExpressionCleanup(): void {
  if (expressionCleanupInterval) {
    clearInterval(expressionCleanupInterval);
    expressionCleanupInterval = null;
  }
}

// Start cleanup on module load
startExpressionCleanup();

/**
 * Store available expressions for a user
 * @param userId - User ID
 * @param expressions - Available expressions from the model
 */
export function setUserExpressions(userId: string, expressions: string[]): void {
  if (!expressions || !Array.isArray(expressions)) {
    logger.log('Expression', `Invalid expressions array for user ${userId}`);
    return;
  }

  userExpressions.set(userId, {
    expressions,
    lastAccess: Date.now(),
  });
  logger.log(
    'Expression',
    `Stored ${expressions.length} expressions for user ${userId}: ${expressions.join(', ')}`
  );
}

/**
 * Get available expressions for a user
 * @param userId - User ID
 * @returns Available expressions
 */
export function getUserExpressions(userId: string): string[] {
  const data = userExpressions.get(userId);
  if (!data) return [];

  // Update lastAccess for LRU tracking
  data.lastAccess = Date.now();
  return data.expressions;
}

// ==================== FALLBACK RESPONSES ====================

/**
 * Determine an appropriate fallback response based on error type
 */
function determineFallbackResponse(errorMessage: string): string {
  const lowerError = errorMessage.toLowerCase();

  if (lowerError.includes('timeout') || lowerError.includes('timed out')) {
    return "I'm thinking really hard about this one... give me a moment!";
  }
  if (lowerError.includes('connection') || lowerError.includes('network')) {
    return 'Hmm, I seem to be having some connection issues. Let me try again!';
  }
  if (lowerError.includes('rate') || lowerError.includes('limit')) {
    return "I'm getting a lot of messages right now! Please give me a second to catch up.";
  }
  if (lowerError.includes('model') || lowerError.includes('configuration')) {
    return "I'm having a bit of trouble with my thinking cap right now. Please try again!";
  }

  return "I'm sorry, I encountered an error processing your message. Please try again!";
}

// ==================== CORE RESPONSE FUNCTIONS ====================

/**
 * Respond to a chat message with context
 */
export async function respondWithContext(
  message: string,
  username: string,
  userID: string
): Promise<ContextualResponse> {
  const contextId = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;

  try {
    logger.log(
      'AI',
      `[${contextId}] Starting respondWithContext for user ${userID}: "${message.substring(0, 50)}..."`
    );

    // Check if we should use cached response
    const responseCacheKey = `response_${userID}_${message}_${username}`;
    const cachedResponse = getCachedResult<ContextualResponse>(responseCacheKey);
    if (cachedResponse) {
      logger.log(
        'AI',
        `[${contextId}] Using cached response from previous identical query`
      );
      return cachedResponse;
    }

    // Validate configuration before proceeding
    logger.log('AI', `[${contextId}] Validating model configuration...`);

    const modelConfig = (await retrieveConfigValue('models.chat')) as ModelConfig | null;
    if (!modelConfig) {
      throw new Error('Chat model configuration is missing');
    }

    if (!modelConfig.endpoint || !modelConfig.apiKey || !modelConfig.model) {
      logger.error('AI', `[${contextId}] Invalid model configuration: hasEndpoint=${!!modelConfig.endpoint} hasApiKey=${!!modelConfig.apiKey} hasModel=${!!modelConfig.model} endpoint=${modelConfig.endpoint || 'MISSING'} model=${modelConfig.model || 'MISSING'}`);
      throw new Error(
        'Incomplete chat model configuration - missing endpoint, apiKey, or model'
      );
    }

    logger.log('AI', `[${contextId}] Model configuration validated: endpoint=${modelConfig.endpoint} model=${modelConfig.model} maxTokens=${modelConfig.maxTokens}`);

    // Parallel vector searches with individual error handling and timeouts
    logger.log('AI', `[${contextId}] Starting parallel vector searches...`);

    const searchPromises = [
      Promise.race([
        findRelevantDocuments(message, userID, 8),
        new Promise<MilvusSearchResult[]>((_, reject) =>
          setTimeout(() => reject(new Error('Document search timeout')), 10000)
        ),
      ]).catch((error): MilvusSearchResult[] => {
        logger.warn(
          'AI',
          `[${contextId}] Document search failed: ${(error as Error).message}`
        );
        return [];
      }),

      Promise.race([
        findRelevantVoiceInMilvus(message, userID, 3),
        new Promise<MilvusSearchResult[]>((_, reject) =>
          setTimeout(() => reject(new Error('Voice search timeout')), 8000)
        ),
      ]).catch((error): MilvusSearchResult[] => {
        logger.warn(
          'AI',
          `[${contextId}] Voice search failed: ${(error as Error).message}`
        );
        return [];
      }),

      Promise.race([
        findRelevantChats(message, username, userID, 3),
        new Promise<MilvusSearchResult[] | boolean>((_, reject) =>
          setTimeout(() => reject(new Error('Chat search timeout')), 8000)
        ),
      ]).catch((error): MilvusSearchResult[] => {
        logger.warn(
          'AI',
          `[${contextId}] Chat search failed: ${(error as Error).message}`
        );
        return [];
      }),
    ] as const;

    const searchResults = await Promise.all(searchPromises);
    const rawContext = searchResults[0];
    const voiceCtx = searchResults[1];
    const chatHistory = Array.isArray(searchResults[2]) ? searchResults[2] : [];

    logger.log('AI', `[${contextId}] Vector searches completed: documents=${Array.isArray(rawContext) ? rawContext.length : 0} voice=${Array.isArray(voiceCtx) ? voiceCtx.length : 0} chat=${Array.isArray(chatHistory) ? chatHistory.length : 0}`);

    // Parallel reranking with error handling
    logger.log('AI', `[${contextId}] Starting reranking process...`);

    const rerankPromises = [
      resultsReranked(rawContext, message, userID, true).catch((error) => {
        logger.warn(
          'AI',
          `[${contextId}] Document reranking failed: ${(error as Error).message}`
        );
        return '- No additional context available due to processing error.';
      }),

      resultsReranked(chatHistory, message, userID).catch((error) => {
        logger.warn(
          'AI',
          `[${contextId}] Chat reranking failed: ${(error as Error).message}`
        );
        return [];
      }),

      resultsReranked(voiceCtx, message, userID).catch((error) => {
        logger.warn(
          'AI',
          `[${contextId}] Voice reranking failed: ${(error as Error).message}`
        );
        return [];
      }),
    ];

    const [contextBody, relChatBody, relVoiceBody] = await Promise.all(rerankPromises);

    logger.log('AI', `[${contextId}] Reranking completed successfully`);

    // Build prompt data with validation
    const promptData: PromptContextData = {
      relChats: Array.isArray(relChatBody) ? relChatBody : [],
      relContext: (contextBody as string) || '- No additional context available.',
      relVoice: Array.isArray(relVoiceBody) ? relVoiceBody : [],
      chat_user: username,
    };

    logger.log('AI', `[${contextId}] Building context prompt...`);

    // Generate prompt with error handling
    let body: Awaited<ReturnType<typeof contextPromptChat>>;
    try {
      body = await contextPromptChat(promptData, message, userID);

      if (!body || !body.messages || !Array.isArray(body.messages)) {
        throw new Error('Invalid prompt body structure');
      }

      logger.log('AI', `[${contextId}] Prompt generated successfully: messageCount=${body.messages.length} model=${body.model} maxTokens=${body.max_tokens}`);
    } catch (promptError) {
      logger.error(
        'AI',
        `[${contextId}] Error generating prompt: ${(promptError as Error).message}`
      );
      throw new Error(`Failed to generate prompt: ${(promptError as Error).message}`);
    }

    // Send completion request with comprehensive error handling
    logger.log('AI', `[${contextId}] Sending completion request to vLLM...`);

    const chatTask = await retryMilvusOperation(
      async () => {
        const startTime = Date.now();

        try {
          const result = await sendChatCompletionRequest(body, modelConfig);

          const elapsedTime = Date.now() - startTime;
          logger.log(
            'AI',
            `[${contextId}] Completion request completed in ${elapsedTime}ms`
          );

          if (!result) {
            throw new Error('Empty response from chat completion');
          }

          if (result.error) {
            throw new Error(`Chat completion error: ${result.error}`);
          }

          if (!result.response || result.response.trim() === '') {
            logger.error('AI', `[${contextId}] Empty response received: hasResponse=${!!result.response} responseLength=${result.response?.length || 0} requestId=${result.requestId}`);
            throw new Error('Chat completion returned empty response');
          }

          return result;
        } catch (requestError) {
          logger.error(
            'AI',
            `[${contextId}] Request error: ${(requestError as Error).message}`
          );
          throw requestError;
        }
      },
      3, // Max retries
      1000 // Initial delay
    );

    logger.log('AI', `[${contextId}] Chat completion successful: responseLength=${chatTask.response?.length || 0} timeToFirstToken=${chatTask.timeToFirstToken} tokensPerSecond=${chatTask.tokensPerSecond} requestId=${chatTask.requestId}`);

    if (chatTask.thoughtProcess) {
      logger.log('AI', `[${contextId}] Thought process received: thoughtLength=${chatTask.thoughtProcess.length} thoughts=${Array.isArray(chatTask.thoughtProcess) ? chatTask.thoughtProcess.length : 'string'}`);
    }

    // Process and validate response
    logger.log('AI', `[${contextId}] Processing response...`);

    const strippedResp = await replyStripped(chatTask.response || '', userID);

    if (!strippedResp || strippedResp.trim() === '') {
      logger.error(
        'AI',
        `[${contextId}] Response stripping resulted in empty text`
      );
      throw new Error('Response processing resulted in empty text');
    }

    const finalResponse: ContextualResponse = {
      response: strippedResp,
      thoughtProcess: chatTask.thoughtProcess,
      metadata: {
        contextId: contextId,
        timeToFirstToken: chatTask.timeToFirstToken,
        tokensPerSecond: chatTask.tokensPerSecond,
        requestId: chatTask.requestId,
        contextUsed: {
          documents: Array.isArray(rawContext) ? rawContext.length : 0,
          voice: Array.isArray(voiceCtx) ? voiceCtx.length : 0,
          chat: Array.isArray(chatHistory) ? chatHistory.length : 0,
        },
        endpoint: modelConfig.endpoint,
        model: modelConfig.model,
      },
    };

    // Cache successful responses
    setCachedResult(responseCacheKey, finalResponse, 10000);

    logger.log('AI', `[${contextId}] Response processing completed successfully: finalLength=${strippedResp.length} cached=true`);

    return finalResponse;
  } catch (error) {
    logger.error(
      'AI',
      `[${contextId}] Error in respondWithContext: ${(error as Error).message}`
    );
    logger.error('AI', `[${contextId}] Stack trace: ${(error as Error).stack}`);

    // Return a contextual fallback response instead of throwing
    const fallbackResponse: ContextualResponse = {
      response: determineFallbackResponse((error as Error).message),
      thoughtProcess: `Error: ${(error as Error).message}`,
      isErrorResponse: true,
      metadata: {
        contextId: contextId,
        errorType: (error as Error).name || 'Unknown',
        errorMessage: (error as Error).message,
      },
    };

    return fallbackResponse;
  }
}

/**
 * Respond to a chat message without context
 */
export async function respondWithoutContext(
  message: string,
  userId: string
): Promise<{ response: string; thoughtProcess?: string }> {
  try {
    const promptData: PromptContextData = {
      relChats: '- No relevant chat context available.',
      relContext: '- No additional context to provide.',
      relVoice: '- No voice conversation history.',
      chat_user: 'User',
    };

    const body = await contextPromptChat(promptData, message, userId);
    const chatTask = await sendChatCompletionRequest(
      body,
      (await retrieveConfigValue('models.chat')) as ModelConfig
    );

    const strippedResp = await replyStripped(chatTask.response || '', userId);
    return {
      response: strippedResp,
      thoughtProcess: chatTask.thoughtProcess,
    };
  } catch (error) {
    logger.log('System', `Error in respondWithoutContext: ${error}`);
    return {
      response: "I'm sorry, I encountered an error processing your request.",
      thoughtProcess: `Error: ${(error as Error).message}`,
    };
  }
}

/**
 * Rerank a message string
 */
export async function rerankString(
  message: string,
  userId: string
): Promise<unknown> {
  const promptRerank = await rerankPrompt(message, userId);
  const modelConfig = await retrieveConfigValue<ModelConfig>('models.rerankTransform');
  if (!modelConfig) {
    throw new Error('Rerank model configuration is missing');
  }
  const chatTask = await sendToolCompletionRequest(promptRerank, modelConfig);
  return chatTask.response;
}

// ==================== MAIN CHAT HANDLERS ====================

/**
 * Main entry point for chat responses
 */
export async function respondToChat(
  messageData: { message: string; user: string },
  userId: string
): Promise<AIChatResponse> {
  try {
    const { message, user } = messageData;
    const formattedDate = new Date().toLocaleString();

    logger.log(
      'AI',
      `Starting respondToChat for user ${userId}: "${message.substring(0, 50)}..."`
    );

    const response = await respondWithContext(message, user, userId);

    if (!response) {
      logger.error(
        'AI',
        `respondWithContext returned null/undefined for user ${userId}`
      );
      return {
        success: false,
        error: 'No response generated from AI system',
        details: 'respondWithContext returned null or undefined',
      };
    }

    if (!response.response || response.response.trim() === '') {
      logger.error(
        'AI',
        `respondWithContext returned empty response for user ${userId}`
      );
      return {
        success: false,
        error: 'AI generated empty response',
        details: 'Response object exists but response field is empty',
      };
    }

    logger.log(
      'AI',
      `AI response generated successfully for user ${userId}: "${response.response.substring(0, 50)}..."`
    );

    // Store the interaction asynchronously
    try {
      const summaryString = `On ${formattedDate}, ${user} said: "${message}". You responded by saying: ${response.response}`;

      addChatMessageAsVector(
        summaryString,
        message,
        user,
        formattedDate,
        response.response,
        userId
      ).catch((err) => {
        logger.error(
          'AI',
          `Error saving chat message vector for user ${userId}: ${(err as Error).message}`
        );
      });
    } catch (vectorError) {
      logger.error(
        'AI',
        `Error preparing chat message vector for user ${userId}: ${(vectorError as Error).message}`
      );
    }

    return {
      success: true,
      text: response.response,
      thoughtProcess: response.thoughtProcess || null,
      metadata: {
        timestamp: formattedDate,
        userId: userId,
        username: user,
      },
    };
  } catch (error) {
    logger.error(
      'AI',
      `Critical error in respondToChat for user ${userId}: ${(error as Error).message}`
    );
    logger.error('AI', `Stack trace: ${(error as Error).stack}`);

    return {
      success: false,
      error: `Failed to process chat: ${(error as Error).message}`,
      details: (error as Error).stack,
    };
  }
}

// ==================== EXPRESSION-ENHANCED RESPONSES ====================

/**
 * Enhanced prompt generation with expression support
 */
async function contextPromptChatWithExpressions(
  promptData: PromptContextData,
  message: string,
  userID: string,
  availableExpressions: string[] = []
): Promise<Awaited<ReturnType<typeof contextPromptChat>>> {
  // Get the base prompt from the original function
  const basePromptBody = await contextPromptChat(promptData, message, userID);

  if (
    !basePromptBody ||
    !basePromptBody.messages ||
    !Array.isArray(basePromptBody.messages)
  ) {
    throw new Error('Invalid base prompt structure');
  }

  // Find the system message to enhance with expression instructions
  const systemMessageIndex = basePromptBody.messages.findIndex(
    (msg) => msg.role === 'system'
  );

  if (systemMessageIndex !== -1 && availableExpressions.length > 0) {
    const originalSystemContent =
      basePromptBody.messages[systemMessageIndex]?.content || '';
    const enhancedSystemContent = generateExpressionPrompt(
      availableExpressions,
      typeof originalSystemContent === 'string' ? originalSystemContent : ''
    );

    if (basePromptBody.messages[systemMessageIndex]) {
      basePromptBody.messages[systemMessageIndex].content = enhancedSystemContent;
    }

    logger.log(
      'Expression',
      `Enhanced system prompt with ${availableExpressions.length} expressions`
    );
  } else {
    logger.log(
      'Expression',
      `No expressions available or no system message found for enhancement`
    );
  }

  return basePromptBody;
}

/**
 * Enhanced respondWithContext that includes expression processing
 */
export async function respondWithContextAndExpressions(
  message: string,
  username: string,
  userID: string,
  availableExpressions: string[] = []
): Promise<ExpressionEnhancedResponse> {
  const contextId = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;

  try {
    logger.log(
      'AI',
      `[${contextId}] Starting respondWithContextAndExpressions for user ${userID}: "${message.substring(0, 50)}..."`
    );

    // Check if we should use cached response
    const responseCacheKey = `response_expr_${userID}_${message}_${username}`;
    const cachedResponse = getCachedResult<ExpressionEnhancedResponse>(responseCacheKey);
    if (cachedResponse) {
      logger.log(
        'AI',
        `[${contextId}] Using cached response from previous identical query`
      );
      return cachedResponse;
    }

    // Validate configuration
    logger.log('AI', `[${contextId}] Validating model configuration...`);

    const modelConfig = (await retrieveConfigValue('models.chat')) as ModelConfig | null;
    if (
      !modelConfig ||
      !modelConfig.endpoint ||
      !modelConfig.apiKey ||
      !modelConfig.model
    ) {
      throw new Error('Incomplete chat model configuration');
    }

    logger.log(
      'AI',
      `[${contextId}] Model configuration validated. Available expressions: ${availableExpressions.length}`
    );

    // Parallel vector searches (same as before)
    logger.log('AI', `[${contextId}] Starting parallel vector searches...`);

    const searchPromises = [
      Promise.race([
        findRelevantDocuments(message, userID, 8),
        new Promise<MilvusSearchResult[]>((_, reject) =>
          setTimeout(() => reject(new Error('Document search timeout')), 10000)
        ),
      ]).catch((): MilvusSearchResult[] => []),

      Promise.race([
        findRelevantVoiceInMilvus(message, userID, 3),
        new Promise<MilvusSearchResult[]>((_, reject) =>
          setTimeout(() => reject(new Error('Voice search timeout')), 8000)
        ),
      ]).catch((): MilvusSearchResult[] => []),

      Promise.race([
        findRelevantChats(message, username, userID, 3),
        new Promise<MilvusSearchResult[]>((_, reject) =>
          setTimeout(() => reject(new Error('Chat search timeout')), 8000)
        ),
      ]).catch((): MilvusSearchResult[] => []),
    ] as const;

    const searchResults2 = await Promise.all(searchPromises);
    const rawContext2 = searchResults2[0];
    const voiceCtx2 = searchResults2[1];
    const chatHistory2 = Array.isArray(searchResults2[2]) ? searchResults2[2] : [];

    // Parallel reranking
    logger.log('AI', `[${contextId}] Starting reranking process...`);

    const rerankPromises = [
      resultsReranked(rawContext2, message, userID, true).catch(
        () => '- No additional context available due to processing error.'
      ),
      resultsReranked(chatHistory2 as MilvusSearchResult[], message, userID).catch(() => []),
      resultsReranked(voiceCtx2, message, userID).catch(() => []),
    ];

    const [contextBody, relChatBody, relVoiceBody] = await Promise.all(rerankPromises);

    // Build prompt data
    const promptData: PromptContextData = {
      relChats: Array.isArray(relChatBody) ? relChatBody : [],
      relContext: (contextBody as string) || '- No additional context available.',
      relVoice: Array.isArray(relVoiceBody) ? relVoiceBody : [],
      chat_user: username,
    };

    logger.log(
      'AI',
      `[${contextId}] Building context prompt with expression support...`
    );

    // Generate prompt with expression enhancement
    let body: Awaited<ReturnType<typeof contextPromptChat>>;
    try {
      body = await contextPromptChatWithExpressions(
        promptData,
        message,
        userID,
        availableExpressions
      );

      if (!body || !body.messages || !Array.isArray(body.messages)) {
        throw new Error('Invalid prompt body structure');
      }

      logger.log(
        'AI',
        `[${contextId}] Enhanced prompt generated with ${availableExpressions.length} expressions available`
      );
    } catch (promptError) {
      logger.error(
        'AI',
        `[${contextId}] Error generating prompt: ${(promptError as Error).message}`
      );
      throw new Error(`Failed to generate prompt: ${(promptError as Error).message}`);
    }

    // Send completion request
    logger.log('AI', `[${contextId}] Sending completion request...`);

    const chatTask = await retryMilvusOperation(
      async () => {
        const startTime = Date.now();

        try {
          const result = await sendChatCompletionRequest(body, modelConfig);
          const elapsedTime = Date.now() - startTime;

          logger.log(
            'AI',
            `[${contextId}] Completion request completed in ${elapsedTime}ms`
          );

          if (
            !result ||
            result.error ||
            !result.response ||
            result.response.trim() === ''
          ) {
            throw new Error(
              result?.error || 'Empty response from chat completion'
            );
          }

          return result;
        } catch (requestError) {
          logger.error(
            'AI',
            `[${contextId}] Request error: ${(requestError as Error).message}`
          );
          throw requestError;
        }
      },
      3, // Max retries
      1000 // Initial delay
    );

    logger.log('AI', `[${contextId}] Chat completion successful`);

    // Process response for expressions
    logger.log('AI', `[${contextId}] Processing response for expressions...`);

    const expressionResult = await processResponseWithExpressions(
      chatTask.response || '',
      availableExpressions,
      { enableDebugLogging: true }
    );

    if (!expressionResult.success) {
      logger.error(
        'AI',
        `[${contextId}] Expression processing failed: ${expressionResult.error}`
      );
      // Fall back to original response without expressions
      const strippedResp = await replyStripped(chatTask.response || '', userID);

      return {
        success: true,
        cleanText: strippedResp,
        expressions: [],
        thoughtProcess: chatTask.thoughtProcess,
        error: expressionResult.error,
      };
    }

    // Strip response text of any remaining artifacts
    const finalCleanText = await replyStripped(
      expressionResult.cleanText,
      userID
    );

    if (!finalCleanText || finalCleanText.trim() === '') {
      logger.error(
        'AI',
        `[${contextId}] Response stripping resulted in empty text`
      );
      throw new Error('Response processing resulted in empty text');
    }

    const finalResponse: ExpressionEnhancedResponse = {
      success: true,
      cleanText: finalCleanText,
      expressions: expressionResult.expressions,
      estimatedDuration: expressionResult.estimatedDuration,
      thoughtProcess: chatTask.thoughtProcess,
      debug: expressionResult.debug,
    };

    // Cache successful responses
    setCachedResult(responseCacheKey, finalResponse, 10000);

    logger.log(
      'AI',
      `[${contextId}] Response processing completed with ${expressionResult.expressions.length} expressions`
    );

    return finalResponse;
  } catch (error) {
    logger.error(
      'AI',
      `[${contextId}] Error in respondWithContextAndExpressions: ${(error as Error).message}`
    );
    logger.error('AI', `[${contextId}] Stack trace: ${(error as Error).stack}`);

    // Return a fallback response
    return {
      success: false,
      cleanText: '',
      expressions: [],
      error: (error as Error).message,
      details: (error as Error).stack,
      contextId: contextId,
    };
  }
}

/**
 * Enhanced respondToChat with expression support
 */
export async function respondToChatWithExpressions(
  messageData: { message: string; user: string },
  userId: string
): Promise<AIChatResponse> {
  try {
    const { message, user } = messageData;
    const formattedDate = new Date().toLocaleString();

    logger.log(
      'AI',
      `Starting respondToChatWithExpressions for user ${userId}: "${message.substring(0, 50)}..."`
    );

    // Get available expressions for this user
    const availableExpressions = getUserExpressions(userId);

    // Enhanced context response with expression support
    const response = await respondWithContextAndExpressions(
      message,
      user,
      userId,
      availableExpressions
    );

    if (!response || !response.success) {
      logger.error(
        'AI',
        `respondWithContextAndExpressions failed for user ${userId}: ${response?.error || 'Unknown error'}`
      );
      return {
        success: false,
        error: response?.error || 'No response generated from AI system',
        details: response?.details || 'respondWithContextAndExpressions failed',
      };
    }

    if (!response.cleanText || response.cleanText.trim() === '') {
      logger.error('AI', `AI generated empty response for user ${userId}`);
      return {
        success: false,
        error: 'AI generated empty response',
        details: 'Response object exists but cleanText field is empty',
      };
    }

    logger.log(
      'AI',
      `AI response with expressions generated for user ${userId}: "${response.cleanText.substring(0, 50)}..." (${response.expressions.length} expressions)`
    );

    // Store the interaction asynchronously
    try {
      const summaryString = `On ${formattedDate}, ${user} said: "${message}". You responded by saying: ${response.cleanText}`;

      addChatMessageAsVector(
        summaryString,
        message,
        user,
        formattedDate,
        response.cleanText,
        userId
      ).catch((err) => {
        logger.error(
          'AI',
          `Error saving chat message vector for user ${userId}: ${(err as Error).message}`
        );
      });
    } catch (vectorError) {
      logger.error(
        'AI',
        `Error preparing chat message vector for user ${userId}: ${(vectorError as Error).message}`
      );
    }

    return {
      success: true,
      text: response.cleanText,
      expressions: response.expressions,
      estimatedDuration: response.estimatedDuration,
      thoughtProcess: response.thoughtProcess || null,
      metadata: {
        timestamp: formattedDate,
        userId: userId,
        username: user,
        expressionCount: response.expressions.length,
        debug: response.debug,
      },
    };
  } catch (error) {
    logger.error(
      'AI',
      `Critical error in respondToChatWithExpressions for user ${userId}: ${(error as Error).message}`
    );
    logger.error('AI', `Stack trace: ${(error as Error).stack}`);

    return {
      success: false,
      error: `Failed to process chat: ${(error as Error).message}`,
      details: (error as Error).stack,
    };
  }
}
