/**
 * Token counting utilities using tiktoken for OpenAI-compatible models
 * with remote tokenization fallback for custom models
 * @module core/tokenizer
 */

import axios from 'axios';
import {
  get_encoding,
  encoding_for_model,
  type Tiktoken,
  type TiktokenEncoding,
  type TiktokenModel,
} from 'tiktoken';
import { retrieveConfigValue } from './config.js';
import { logger } from './logger.js';

/** Supported encoding types */
export type EncodingType = TiktokenEncoding;

/** Chat message structure for token counting - accepts both string and array content */
export interface ChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
}

/** Request body with messages for token counting */
export interface MessageRequestBody {
  messages: ChatMessage[];
}

/** Cached tiktoken encoders */
const encoderCache = new Map<string, Tiktoken>();

/** Default encoding for unknown models */
const DEFAULT_ENCODING: TiktokenEncoding = 'cl100k_base';

/**
 * Model name patterns to tiktoken encoding mapping
 * Used to infer the correct tokenizer for common model patterns
 */
const MODEL_ENCODING_PATTERNS: Array<[RegExp, TiktokenEncoding]> = [
  // GPT-4o family
  [/gpt-4o/i, 'o200k_base'],
  [/o1/i, 'o200k_base'],
  [/o3/i, 'o200k_base'],
  [/o4/i, 'o200k_base'],
  // GPT-4 family
  [/gpt-4/i, 'cl100k_base'],
  // GPT-3.5 family
  [/gpt-3\.5/i, 'cl100k_base'],
  [/gpt-35/i, 'cl100k_base'],
  // Claude models (use cl100k_base as approximation)
  [/claude/i, 'cl100k_base'],
  // Embedding models
  [/text-embedding/i, 'cl100k_base'],
  // Legacy models
  [/davinci|curie|babbage|ada/i, 'p50k_base'],
  [/code-/i, 'p50k_base'],
];

/**
 * Gets the appropriate encoding for a model name
 *
 * @param modelName - The model identifier
 * @returns The tiktoken encoding name to use
 */
export function getEncodingForModel(modelName: string): TiktokenEncoding {
  // Try direct model lookup first (for known OpenAI models)
  try {
    // Check if it's a known tiktoken model
    const encoding = encoding_for_model(modelName as TiktokenModel);
    encoding.free(); // Free the test encoder
    return get_encoding_name_for_model(modelName);
  } catch {
    // Not a known model, try pattern matching
  }

  // Pattern matching for common model naming conventions
  for (const [pattern, encoding] of MODEL_ENCODING_PATTERNS) {
    if (pattern.test(modelName)) {
      return encoding;
    }
  }

  // Default to cl100k_base (GPT-4 tokenizer) for unknown models
  return DEFAULT_ENCODING;
}

/**
 * Helper to get the encoding name for a known model
 */
function get_encoding_name_for_model(model: string): TiktokenEncoding {
  try {
    // Create encoder and get its name
    const enc = encoding_for_model(model as TiktokenModel);
    const name = enc.name as TiktokenEncoding | undefined;
    enc.free();
    return name ?? DEFAULT_ENCODING;
  } catch {
    return DEFAULT_ENCODING;
  }
}

/**
 * Gets or creates a cached tiktoken encoder
 *
 * @param encoding - The encoding name
 * @returns The tiktoken encoder instance
 */
export function getEncoder(encoding: TiktokenEncoding = DEFAULT_ENCODING): Tiktoken {
  const cached = encoderCache.get(encoding);
  if (cached) {
    return cached;
  }

  const encoder = get_encoding(encoding);
  encoderCache.set(encoding, encoder);
  return encoder;
}

/**
 * Gets or creates an encoder for a specific model
 *
 * @param modelName - The model identifier
 * @returns The tiktoken encoder instance
 */
export function getEncoderForModel(modelName: string): Tiktoken {
  const encoding = getEncodingForModel(modelName);
  return getEncoder(encoding);
}

/**
 * Counts tokens in a text string
 *
 * @param text - The text to tokenize
 * @param modelType - The model name (used to select tokenizer)
 * @returns The token count
 *
 * @example
 * ```ts
 * const count = countTokens('Hello, world!', 'gpt-4');
 * console.log(`Token count: ${count}`);
 * ```
 */
export function countTokens(text: string, modelType = 'gpt-4'): number {
  try {
    const encoder = getEncoderForModel(modelType);
    const tokens = encoder.encode(text);
    return tokens.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Tokenizer', `Error counting tokens: ${message}`);
    // Fallback: rough estimate of 4 chars per token
    return Math.ceil(text.length / 4);
  }
}

/**
 * Counts tokens for a prompt combination (system + user + context)
 *
 * @param systemPrompt - The system prompt
 * @param userPrompt - The user message
 * @param modelType - The model name
 * @param contextPrompt - Optional context/RAG content
 * @returns The total token count
 */
export function getPromptCount(
  systemPrompt: string | object,
  userPrompt: string | object,
  modelType: string,
  contextPrompt: string | object = ''
): number {
  try {
    const encoder = getEncoderForModel(modelType);

    const systemText =
      typeof systemPrompt === 'string' ? systemPrompt : JSON.stringify(systemPrompt);
    const userText =
      typeof userPrompt === 'string' ? userPrompt : JSON.stringify(userPrompt);
    const contextText =
      typeof contextPrompt === 'string' ? contextPrompt : JSON.stringify(contextPrompt);

    const systemTokens = encoder.encode(systemText).length;
    const userTokens = encoder.encode(userText).length;
    const contextTokens = contextText ? encoder.encode(contextText).length : 0;

    return systemTokens + userTokens + contextTokens;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Tokenizer', `Error during tokenization for model ${modelType}: ${message}`);
    // Fallback estimate
    const totalText = String(systemPrompt) + String(userPrompt) + String(contextPrompt);
    return Math.ceil(totalText.length / 4);
  }
}

/**
 * Counts total tokens in a request body's messages array
 *
 * @param requestBody - Request body containing messages
 * @param modelType - The model name
 * @returns The total token count across all messages
 */
export function getPromptTokens(
  requestBody: MessageRequestBody,
  modelType: string
): number {
  try {
    const encoder = getEncoderForModel(modelType);
    let totalTokens = 0;

    for (const message of requestBody.messages) {
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      const tokens = encoder.encode(content);
      totalTokens += tokens.length;
    }

    return totalTokens;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error('Tokenizer', `Error during tokenization for model ${modelType}: ${errMsg}`);
    // Fallback estimate
    const totalText = requestBody.messages.map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('');
    return Math.ceil(totalText.length / 4);
  }
}

/**
 * Counts tokens in an output message
 *
 * @param message - The message text
 * @param modelType - The model name
 * @returns The token count
 */
export function getOutputTokens(message: string, modelType: string): number {
  return countTokens(message, modelType);
}

/**
 * Tokenizes using the remote model server's tokenization endpoint
 *
 * Useful for local models (Llama, Mistral, etc.) that have their own tokenizers.
 * Falls back to local tokenization if the remote call fails.
 *
 * @param messages - The messages to tokenize
 * @returns The token count from the remote server
 *
 * @example
 * ```ts
 * const messages = [{ role: 'user', content: 'Hello!' }];
 * const count = await promptTokenizedFromRemote(messages);
 * ```
 */
export async function promptTokenizedFromRemote(
  input: ChatMessage[] | string,
  _modelType?: string
): Promise<number> {
  const baseURL = await retrieveConfigValue<string>('models.chat.endpoint');
  const isVllm = await retrieveConfigValue<boolean>('models.chat.isVllm');
  const modelName = await retrieveConfigValue<string>('models.chat.model');

  // Convert string input to a messages array for consistent handling
  const messages: ChatMessage[] | string =
    typeof input === 'string' ? input : input;

  if (!baseURL || !modelName) {
    logger.warn('Tokenizer', 'Missing endpoint or model config, using local tokenization');
    const encoder = getEncoderForModel(modelName ?? 'gpt-4');
    if (typeof messages === 'string') {
      return encoder.encode(messages).length;
    }
    let total = 0;
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      total += encoder.encode(content).length;
    }
    return total;
  }

  // Build the tokenization endpoint URL
  let fullUrl = `${baseURL}/tokenize`;
  if (isVllm) {
    // vLLM uses a different URL pattern
    fullUrl = fullUrl.replace('/v1', '');
  }

  const reqBody = {
    messages,
    model: modelName,
  };

  try {
    const response = await axios.post<{ count: number }>(fullUrl, reqBody, {
      headers: {
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      timeout: 5000,
    });

    return response.data.count;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(
      'Tokenizer',
      `Remote tokenization failed for model ${modelName}: ${errorMessage}. Falling back to local.`
    );
    // Fallback to local tokenization
    const encoder = getEncoderForModel(modelName);
    if (typeof messages === 'string') {
      return encoder.encode(messages).length;
    }
    let total = 0;
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      total += encoder.encode(content).length;
    }
    return total;
  }
}

/**
 * Encodes text to token IDs
 *
 * @param text - The text to encode
 * @param modelType - The model name
 * @returns Array of token IDs
 */
export function encode(text: string, modelType = 'gpt-4'): Uint32Array {
  const encoder = getEncoderForModel(modelType);
  return encoder.encode(text);
}

/**
 * Decodes token IDs back to text
 *
 * @param tokens - The token IDs to decode
 * @param modelType - The model name
 * @returns The decoded text
 */
export function decode(tokens: Uint32Array, modelType = 'gpt-4'): string {
  const encoder = getEncoderForModel(modelType);
  const bytes = encoder.decode(tokens);
  return new TextDecoder().decode(bytes);
}

/**
 * Truncates text to fit within a token limit
 *
 * @param text - The text to truncate
 * @param maxTokens - Maximum number of tokens
 * @param modelType - The model name
 * @returns The truncated text
 */
export function truncateToTokenLimit(
  text: string,
  maxTokens: number,
  modelType = 'gpt-4'
): string {
  const encoder = getEncoderForModel(modelType);
  const tokens = encoder.encode(text);

  if (tokens.length <= maxTokens) {
    return text;
  }

  // Truncate tokens and decode
  const truncatedTokens = tokens.slice(0, maxTokens);
  const bytes = encoder.decode(truncatedTokens);
  return new TextDecoder().decode(bytes);
}

/**
 * Clears the encoder cache to free memory
 */
export function clearEncoderCache(): void {
  for (const encoder of encoderCache.values()) {
    encoder.free();
  }
  encoderCache.clear();
}

/**
 * Gets statistics about cached encoders
 */
export function getEncoderCacheStats(): { size: number; encodings: string[] } {
  return {
    size: encoderCache.size,
    encodings: Array.from(encoderCache.keys()),
  };
}

export default {
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
};
