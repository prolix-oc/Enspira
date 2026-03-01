/**
 * LLM Client module for Enspira
 * Manages OpenAI-compatible client pool and completion requests
 * @module core/llm-client
 */

import OpenAI from 'openai';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import { jsonrepair } from 'jsonrepair';
import { performance } from 'node:perf_hooks';
import { logger } from './logger.js';
import { promptTokenizedFromRemote } from './tokenizer.js';
import type {
  ModelConfig,
  ToolCompletionResult,
  ChatCompletionResult,
  CoTCompletionResult,
  BaseLLMRequestBody,
} from '../types/index.js';

/**
 * Converts our internal request body to OpenAI-compatible format
 */
function toOpenAIRequest(
  requestBody: BaseLLMRequestBody
): ChatCompletionCreateParamsStreaming {
  return {
    ...requestBody,
    model: requestBody.model ?? 'gpt-4',
    messages: requestBody.messages.map((msg) => ({
      role: msg.role as 'system' | 'user' | 'assistant',
      content: typeof msg.content === 'string' ? msg.content : '',
    })),
    stream: true as const,
  };
}

// ============================================
// Client Pool Management
// ============================================

/** Maximum number of OpenAI clients in the pool */
const MAX_CLIENT_POOL_SIZE = 5;

/** Client pool storage */
const clientPool = new Map<string, OpenAI>();

/**
 * Gets or creates an OpenAI client from the pool
 * Uses LRU eviction when pool is full
 *
 * @param endpoint - The API endpoint URL
 * @param apiKey - The API key
 * @returns OpenAI client instance
 */
export function getOpenAIClient(endpoint: string, apiKey: string): OpenAI {
  const key = `${endpoint}_${apiKey?.substring(0, 8) ?? 'nokey'}`;

  const existingClient = clientPool.get(key);
  if (existingClient) {
    return existingClient;
  }

  // Remove oldest client if pool is full
  if (clientPool.size >= MAX_CLIENT_POOL_SIZE) {
    const firstKey = clientPool.keys().next().value;
    if (firstKey) {
      const oldClient = clientPool.get(firstKey);
      // Cleanup old client if it has cleanup methods
      if (oldClient && 'destroy' in oldClient && typeof oldClient.destroy === 'function') {
        (oldClient as OpenAI & { destroy: () => void }).destroy();
      }
      clientPool.delete(firstKey);
    }
  }

  const client = new OpenAI({
    baseURL: endpoint,
    apiKey: apiKey,
    timeout: 60000,
    maxRetries: 0,
  });

  clientPool.set(key, client);
  return client;
}

/**
 * Clears the client pool and destroys all clients
 */
export function clearClientPool(): void {
  clientPool.forEach((client) => {
    if ('destroy' in client && typeof client.destroy === 'function') {
      (client as OpenAI & { destroy: () => void }).destroy();
    }
  });
  clientPool.clear();
  logger.log('System', 'OpenAI client pool cleared');
}

/**
 * Gets the current client pool size
 */
export function getClientPoolSize(): number {
  return clientPool.size;
}

// ============================================
// Tool Completion Request
// ============================================

/** Maximum response size for tool requests (25KB) */
const MAX_TOOL_RESPONSE_SIZE = 25000;

/**
 * Sends a chat completion request for tool tasks like query writing and reranking
 * Includes proper memory management and response size limits
 *
 * @param requestBody - The request body for the completion
 * @param modelConfig - Configuration for the model
 * @returns The completion response
 */
export async function sendToolCompletionRequest(
  requestBody: BaseLLMRequestBody,
  modelConfig: ModelConfig
): Promise<ToolCompletionResult> {
  const openai = getOpenAIClient(modelConfig.endpoint, modelConfig.apiKey);
  const startTime = performance.now();
  let fullResponse = '';

  let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> | null = null;

  try {
    stream = await openai.chat.completions.create(toOpenAIRequest(requestBody));

    for await (const part of stream) {
      const content = part.choices[0]?.delta?.content;
      if (content) {
        // Check size limit before concatenation
        if (fullResponse.length + content.length > MAX_TOOL_RESPONSE_SIZE) {
          logger.log(
            'API',
            `Tool response approaching ${MAX_TOOL_RESPONSE_SIZE / 1000}KB limit, truncating`
          );
          break;
        }
        fullResponse += content;
      }
    }

    // Calculate total processing time
    const totalTime = (performance.now() - startTime) / 1000;

    // For JSON responses, make sure we have valid JSON
    const responseFormat = requestBody as BaseLLMRequestBody & {
      response_format?: { type: string };
    };
    if (responseFormat.response_format?.type === 'json_schema') {
      if (typeof fullResponse === 'object' && fullResponse !== null) {
        return {
          response: fullResponse,
          rawResponse: JSON.stringify(fullResponse),
          processingTime: totalTime.toFixed(3),
        };
      }

      try {
        const jsonResponse = JSON.parse(fullResponse);
        return {
          response: jsonResponse,
          rawResponse: fullResponse,
          processingTime: totalTime.toFixed(3),
        };
      } catch (jsonError) {
        try {
          const fixedResponse = jsonrepair(fullResponse);
          const jsonResponse = JSON.parse(fixedResponse);
          logger.log('API', 'Fixed malformed JSON in tool response');
          return {
            response: jsonResponse,
            rawResponse: fixedResponse,
            processingTime: totalTime.toFixed(3),
            jsonFixed: true,
          };
        } catch {
          logger.log(
            'API',
            `Failed to parse JSON response: ${jsonError instanceof Error ? jsonError.message : 'Unknown error'}`
          );
          return {
            error: 'JSON parsing failed',
            rawResponse: fullResponse.substring(0, 1000),
            processingTime: totalTime.toFixed(3),
          };
        }
      }
    }

    return {
      response: fullResponse,
      processingTime: totalTime.toFixed(3),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.log('API', `Tool completion error: ${errorMessage}; Model: ${modelConfig.model}`);
    return { error: errorMessage };
  } finally {
    // Ensure stream is properly closed
    if (stream && 'controller' in stream) {
      const streamWithController = stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> & {
        controller?: { abort: () => void };
      };
      if (typeof streamWithController.controller?.abort === 'function') {
        streamWithController.controller.abort();
      }
    }
  }
}

// ============================================
// Chat Completion Request
// ============================================

/** Maximum response size for chat requests (75KB) */
const MAX_CHAT_RESPONSE_SIZE = 75000;

/**
 * Extended delta type to include reasoning_content from some models
 */
interface ExtendedDelta {
  content?: string;
  reasoning_content?: string;
}

/**
 * Sends a chat completion request with streaming support
 * Includes comprehensive error handling and performance metrics
 *
 * @param requestBody - The request body for the completion
 * @param modelConfig - Configuration for the model
 * @param _userObj - Optional user object (unused, kept for compatibility)
 * @returns The completion response with performance metrics
 */
export async function sendChatCompletionRequest(
  requestBody: BaseLLMRequestBody,
  modelConfig: ModelConfig,
  _userObj: unknown = null
): Promise<ChatCompletionResult> {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> | null = null;
  let fullResponse = '';
  let thinkingStuff = '';

  try {
    // Validate model configuration
    logger.log('API', `[${requestId}] Starting chat completion request`);

    if (!modelConfig?.endpoint || !modelConfig?.apiKey || !modelConfig?.model) {
      throw new Error('Invalid model configuration - missing endpoint, apiKey, or model');
    }

    if (!requestBody?.messages?.length) {
      throw new Error('Invalid request body: missing or empty messages array');
    }

    // Use client pool instead of creating new instances
    const openai = getOpenAIClient(modelConfig.endpoint, modelConfig.apiKey);

    const startTime = performance.now();
    let firstTokenTimeElapsed: number | null = null;
    let backendStartTime: number | undefined;

    // Debug logging if enabled
    if (process.env.DEBUG_CHAT_REQUESTS === 'true') {
      logger.log('API', `[${requestId}] Request details: endpoint=${modelConfig.endpoint}, model=${requestBody.model || modelConfig.model}, messageCount=${requestBody.messages.length}`);
    }

    logger.log('API', `[${requestId}] Sending request to vLLM...`);

    try {
      stream = await openai.chat.completions.create(toOpenAIRequest(requestBody));
      logger.log('API', `[${requestId}] Successfully created stream connection to vLLM`);
    } catch (streamError) {
      const errorMessage = streamError instanceof Error ? streamError.message : String(streamError);
      logger.error('API', `[${requestId}] Failed to create stream to vLLM: ${errorMessage}`);

      if (errorMessage.includes('ECONNREFUSED')) {
        throw new Error(
          `Cannot connect to vLLM at ${modelConfig.endpoint} - connection refused. Is vLLM running?`
        );
      } else if (errorMessage.includes('ENOTFOUND')) {
        throw new Error(`Cannot resolve hostname for vLLM endpoint: ${modelConfig.endpoint}`);
      } else if (errorMessage.includes('timeout')) {
        throw new Error(`Connection to vLLM timed out at ${modelConfig.endpoint}`);
      } else {
        throw new Error(`vLLM connection error: ${errorMessage}`);
      }
    }

    logger.log('API', `[${requestId}] Processing response stream...`);

    try {
      for await (const part of stream) {
        const delta = part.choices[0]?.delta as ExtendedDelta | undefined;
        const content = delta?.content;
        const thinkContent = delta?.reasoning_content;

        if (content) {
          if (firstTokenTimeElapsed === null) {
            firstTokenTimeElapsed = (performance.now() - startTime) / 1000;
            backendStartTime = performance.now();
            logger.log(
              'API',
              `[${requestId}] First token received after ${firstTokenTimeElapsed.toFixed(3)} seconds`
            );
          }

          // Check size before concatenation
          if (fullResponse.length + content.length > MAX_CHAT_RESPONSE_SIZE) {
            logger.log(
              'API',
              `[${requestId}] Response exceeded ${MAX_CHAT_RESPONSE_SIZE / 1000}KB limit, truncating`
            );
            fullResponse += '\n\n[Response truncated due to length limits]';
            break;
          }
          fullResponse += content;
        } else if (thinkContent) {
          if (firstTokenTimeElapsed === null) {
            firstTokenTimeElapsed = (performance.now() - startTime) / 1000;
            backendStartTime = performance.now();
            logger.log(
              'API',
              `[${requestId}] First thought token received after ${firstTokenTimeElapsed.toFixed(3)} seconds`
            );
          }

          // Check size before concatenation
          if (thinkingStuff.length + thinkContent.length > MAX_CHAT_RESPONSE_SIZE) {
            logger.log(
              'API',
              `[${requestId}] Thinking response exceeded ${MAX_CHAT_RESPONSE_SIZE / 1000}KB limit, truncating`
            );
            thinkingStuff += '\n\n[Response truncated due to length limits]';
            break;
          }
          thinkingStuff += thinkContent;
        }
      }
    } catch (streamProcessError) {
      const errorMessage =
        streamProcessError instanceof Error ? streamProcessError.message : String(streamProcessError);
      logger.error(
        'API',
        `[${requestId}] Error processing stream: ${errorMessage}, responseLength=${fullResponse.length}`
      );

      if (fullResponse.length === 0 && thinkingStuff.length === 0) {
        throw new Error(`Stream processing failed: ${errorMessage}`);
      } else {
        logger.warn(
          'API',
          `[${requestId}] Stream ended with error but got partial response (${fullResponse.length} chars)`
        );
      }
    }

    const backendTimeElapsed = backendStartTime ? (performance.now() - backendStartTime) / 1000 : 0;

    logger.log(
      'API',
      `[${requestId}] Response completed: responseLength=${fullResponse.length}, thoughtResponseLength=${thinkingStuff.length}, firstTokenTime=${firstTokenTimeElapsed?.toFixed(3)}, totalTime=${((performance.now() - startTime) / 1000).toFixed(3)}, backendTime=${backendTimeElapsed.toFixed(3)}`
    );

    if (!fullResponse || fullResponse.trim() === '') {
      throw new Error('Received empty response from vLLM');
    }

    // Tokenization with error handling
    let generatedTokens: number;
    try {
      generatedTokens = await promptTokenizedFromRemote(fullResponse);
    } catch (tokenizationError) {
      const errorMessage =
        tokenizationError instanceof Error ? tokenizationError.message : String(tokenizationError);
      logger.warn('API', `[${requestId}] Tokenization failed: ${errorMessage}`);
      generatedTokens = Math.ceil(fullResponse.length / 4);
    }

    let backendTokensPerSecond: string | number = 0;
    if (backendTimeElapsed > 0 && generatedTokens > 0) {
      backendTokensPerSecond = (generatedTokens / backendTimeElapsed).toFixed(2);
    }

    // Enhanced thought process extraction
    let thoughtProcess = '';
    let finalResponse = '';

    const startTag = '<think>';
    const endTag = ' </think>';
    const startTagIndex = fullResponse.indexOf(startTag);
    const endTagIndex = fullResponse.indexOf(endTag);

    if (startTagIndex !== -1 && endTagIndex !== -1 && endTagIndex > startTagIndex) {
      thoughtProcess = fullResponse.substring(startTagIndex + startTag.length, endTagIndex).trim();
      finalResponse = fullResponse.substring(endTagIndex + endTag.length).trim();
    } else if (startTagIndex === -1 && endTagIndex !== -1) {
      thoughtProcess = fullResponse.substring(0, endTagIndex).trim();
      finalResponse = fullResponse.substring(endTagIndex + endTag.length).trim();
    } else if (fullResponse.includes(' \n</think>')) {
      let currentPos = 0;
      const thoughts: string[] = [];
      let lastEndTagPos = -1;

      while (true) {
        const nextStartTag = fullResponse.indexOf(startTag, currentPos);
        const nextEndTag = fullResponse.indexOf(endTag, currentPos);

        if (nextEndTag === -1) break;
        lastEndTagPos = nextEndTag;

        if (nextStartTag !== -1 && nextStartTag < nextEndTag) {
          thoughts.push(fullResponse.substring(nextStartTag + startTag.length, nextEndTag).trim());
          currentPos = nextEndTag + endTag.length;
        } else {
          if (thoughts.length === 0 && nextStartTag === -1) {
            thoughts.push(fullResponse.substring(0, nextEndTag).trim());
          } else {
            thoughts.push(fullResponse.substring(currentPos, nextEndTag).trim());
          }
          currentPos = nextEndTag + endTag.length;
        }
      }

      thoughtProcess = thoughts.join('\n');
      if (lastEndTagPos !== -1) {
        finalResponse = fullResponse.substring(lastEndTagPos + endTag.length).trim();
      } else {
        finalResponse = fullResponse;
      }
    } else {
      finalResponse = fullResponse.trim();
    }

    logger.log(
      'API',
      `[${requestId}] Request completed successfully: finalResponseLength=${finalResponse.length}, thoughtProcessLength=${thoughtProcess.length}, tokensPerSecond=${backendTokensPerSecond}`
    );

    return {
      response: finalResponse,
      thoughtProcess,
      timeToFirstToken: firstTokenTimeElapsed ? firstTokenTimeElapsed.toFixed(3) : null,
      tokensPerSecond: backendTokensPerSecond,
      requestId: requestId,
      metadata: {
        totalTokens: generatedTokens,
        totalTime: ((performance.now() - startTime) / 1000).toFixed(3),
        endpoint: modelConfig.endpoint,
        model: requestBody.model || modelConfig.model,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      'API',
      `[${requestId}] OpenAI chat completion error: ${errorMessage}, model=${modelConfig?.model || 'unknown'}, endpoint=${modelConfig?.endpoint || 'unknown'}`
    );

    return {
      error: errorMessage,
      requestId: requestId,
      details: {
        endpoint: modelConfig?.endpoint,
        model: modelConfig?.model,
        hasApiKey: !!modelConfig?.apiKey,
      },
    };
  } finally {
    // Ensure proper cleanup
    if (stream && 'controller' in stream) {
      const streamWithController = stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> & {
        controller?: { abort: () => void };
      };
      if (typeof streamWithController.controller?.abort === 'function') {
        streamWithController.controller.abort();
      }
    }
  }
}

// ============================================
// Chain of Thought Completion Request
// ============================================

/** Maximum response size for CoT requests (50KB) */
const MAX_COT_RESPONSE_SIZE = 50000;

/**
 * Sends a chat completion request designed for chain-of-thought responses
 * Parses structured JSON responses with thought arrays
 *
 * @param requestBody - The request body for the completion
 * @param modelConfig - Configuration for the model
 * @returns The completion response with parsed thoughts
 */
export async function sendChatCompletionRequestCoT(
  requestBody: BaseLLMRequestBody,
  modelConfig: ModelConfig
): Promise<CoTCompletionResult> {
  const openai = getOpenAIClient(modelConfig.endpoint, modelConfig.apiKey);
  const startTime = performance.now();
  let firstTokenTimeElapsed: number | null = null;
  let backendStartTime: number | undefined;
  let fullResponse = '';
  let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> | null = null;

  try {
    stream = await openai.chat.completions.create(toOpenAIRequest(requestBody));

    for await (const part of stream) {
      const content = part.choices[0]?.delta?.content;
      if (content) {
        if (firstTokenTimeElapsed === null) {
          firstTokenTimeElapsed = (performance.now() - startTime) / 1000;
          backendStartTime = performance.now();
        }

        // Size limit check
        if (fullResponse.length + content.length > MAX_COT_RESPONSE_SIZE) {
          logger.log('API', 'CoT response approaching 50KB limit, truncating');
          break;
        }
        fullResponse += content;
      }
    }

    const backendTimeElapsed = backendStartTime ? (performance.now() - backendStartTime) / 1000 : 0;

    // Tokenize the full response
    let generatedTokens: number;
    try {
      generatedTokens = await promptTokenizedFromRemote(fullResponse, modelConfig.modelType);
    } catch (tokenizationError) {
      const errorMessage =
        tokenizationError instanceof Error ? tokenizationError.message : String(tokenizationError);
      logger.log('API', `Error tokenizing CoT response: ${errorMessage}. Using character-based estimate.`);
      generatedTokens = Math.ceil(fullResponse.length / 4);
    }

    let backendTokensPerSecond: string | number = 0;
    if (backendTimeElapsed > 0 && generatedTokens > 0) {
      backendTokensPerSecond = (generatedTokens / backendTimeElapsed).toFixed(2);
    }

    // Attempt to parse the JSON response with multiple fallback mechanisms
    interface CoTResponse {
      thoughts?: string[] | Array<{ thought: string }>;
      final_response?: string;
      response?: string;
    }

    let formattedResponse: CoTResponse;
    let thoughtsArray: string[] = [];
    let fullOutput: string = '';

    try {
      try {
        formattedResponse = JSON.parse(fullResponse) as CoTResponse;
      } catch {
        logger.log('API', 'Initial JSON parse failed, trying jsonrepair');
        const fixedResponse = jsonrepair(fullResponse);
        formattedResponse = JSON.parse(fixedResponse) as CoTResponse;
      }

      // Process thoughts array safely
      if (formattedResponse.thoughts) {
        if (Array.isArray(formattedResponse.thoughts)) {
          const firstItem = formattedResponse.thoughts[0];
          if (
            firstItem &&
            typeof firstItem === 'object' &&
            'thought' in firstItem
          ) {
            // Array of objects with thought property
            thoughtsArray = (formattedResponse.thoughts as Array<{ thought: string }>)
              .map((t) => t.thought)
              .filter((thought) => thought && thought !== '');
          } else {
            // Array of strings
            thoughtsArray = (formattedResponse.thoughts as string[]).filter(
              (thought) => thought && thought !== ''
            );
          }
        } else {
          logger.log('API', 'Invalid thoughts format in response, using empty array');
          thoughtsArray = [];
        }
      }

      fullOutput = formattedResponse.final_response || formattedResponse.response || '';

      // More aggressive truncation
      if (fullOutput && fullOutput.length > MAX_COT_RESPONSE_SIZE) {
        logger.log('API', `CoT response too large (${fullOutput.length} bytes), truncating`);
        fullOutput = fullOutput.substring(0, MAX_COT_RESPONSE_SIZE) + '\n[Response truncated due to length...]';
      }
    } catch (parseError) {
      const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
      logger.log(
        'API',
        `Error parsing JSON response: ${errorMessage}; Response: ${fullResponse.substring(0, 500)}...`,
        'error'
      );

      try {
        const finalResponseMatch = fullResponse.match(/"final_response"\s*:\s*"([^"]+)"/);
        if (finalResponseMatch && finalResponseMatch[1]) {
          fullOutput = finalResponseMatch[1];
        } else {
          fullOutput = 'I apologize, but I encountered an error processing your message.';
        }
        logger.error('API', 'All JSON parsing attempts failed. Constructed basic response.');
        thoughtsArray = ['Error parsing JSON response'];
      } catch (emergencyError) {
        const emergencyMessage =
          emergencyError instanceof Error ? emergencyError.message : String(emergencyError);
        logger.error('API', `Emergency parsing also failed: ${emergencyMessage}`);
        return {
          error: `Error parsing JSON: ${errorMessage}`,
          rawResponse: fullResponse.substring(0, 1000),
        };
      }
    }

    return {
      response: fullOutput,
      thoughtProcess: thoughtsArray,
      timeToFirstToken: firstTokenTimeElapsed ? firstTokenTimeElapsed.toFixed(2) : null,
      tokensPerSecond: backendTokensPerSecond,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.log(
      'API',
      `OpenAI chat completion error: ${errorMessage}; Model Config: ${JSON.stringify(modelConfig)}`,
      'error'
    );
    return { error: errorMessage };
  } finally {
    // Ensure proper cleanup
    if (stream && 'controller' in stream) {
      const streamWithController = stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> & {
        controller?: { abort: () => void };
      };
      if (typeof streamWithController.controller?.abort === 'function') {
        streamWithController.controller.abort();
      }
    }
  }
}
