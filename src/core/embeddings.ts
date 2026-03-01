/**
 * Embedding Generation
 * Handles text-to-embedding conversion using configurable embedding APIs
 */

import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';

import { logger } from './logger.js';
import { retrieveConfigValue } from './config.js';
import { axiosRequestWithRetry } from './data-helper.js';

// ==================== EMBEDDING GENERATION ====================

/**
 * Embedding API response data structure
 */
interface EmbeddingResponseData {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage?: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/**
 * Get message embedding(s) from the configured embedding API
 * @param message - Single message or array of messages to embed
 * @returns Embedding array or array of embedding arrays
 */
export async function getMessageEmbedding(
  message: string
): Promise<number[]>;
export async function getMessageEmbedding(
  message: string[]
): Promise<number[][]>;
export async function getMessageEmbedding(
  message: string | string[]
): Promise<number[] | number[][]> {
  const embeddingData = {
    input: Array.isArray(message) ? message : [message],
    model: await retrieveConfigValue('models.embedding.model'),
  };

  try {
    const config: AxiosRequestConfig = {
      method: 'post',
      url: `${await retrieveConfigValue('models.embedding.endpoint')}/embeddings`,
      data: embeddingData,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await retrieveConfigValue('models.embedding.apiKey')}`,
      },
      timeout: 30000,
    };

    const response = await axiosRequestWithRetry<EmbeddingResponseData>(config, 3, 1000);
    const embeddingResp = response.data.data;

    return embeddingResp.length > 1
      ? embeddingResp.map((item) => item.embedding)
      : embeddingResp[0]?.embedding ?? [];
  } catch (error) {
    logger.log('System', `Error generating embedding: ${error}`);
    throw error;
  }
}

/**
 * Get binary embedding buffer from text
 * Useful for Milvus BinaryVector fields
 * @param text - Text to embed
 * @returns Buffer containing the embedding
 */
export async function getBinaryEmbedding(text: string): Promise<Buffer> {
  const embedding = await getMessageEmbedding(text);
  return Buffer.from(embedding);
}

/**
 * Batch embed multiple texts efficiently
 * @param texts - Array of texts to embed
 * @param batchSize - Number of texts per API call
 * @returns Array of embeddings
 */
export async function batchGetEmbeddings(
  texts: string[],
  batchSize: number = 10
): Promise<number[][]> {
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const embeddings = await getMessageEmbedding(batch);

    // Handle both single and multiple embeddings
    if (batch.length === 1) {
      // When batch has 1 item, embeddings is number[][] with 1 element
      const firstEmbedding = (embeddings as number[][])[0];
      if (firstEmbedding) results.push(firstEmbedding);
    } else {
      results.push(...(embeddings as number[][]));
    }
  }

  return results;
}

/**
 * Calculate cosine similarity between two embeddings
 * @param a - First embedding
 * @param b - Second embedding
 * @returns Similarity score between -1 and 1
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Embeddings must have the same dimension');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i] ?? 0;
    const bVal = b[i] ?? 0;
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Calculate Euclidean distance between two embeddings
 * @param a - First embedding
 * @param b - Second embedding
 * @returns Distance (lower is more similar)
 */
export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Embeddings must have the same dimension');
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const aVal = a[i] ?? 0;
    const bVal = b[i] ?? 0;
    const diff = aVal - bVal;
    sum += diff * diff;
  }

  return Math.sqrt(sum);
}

/**
 * Normalize an embedding vector to unit length
 * @param embedding - Embedding to normalize
 * @returns Normalized embedding
 */
export function normalizeEmbedding(embedding: number[]): number[] {
  let norm = 0;
  for (const val of embedding) {
    norm += val * val;
  }
  norm = Math.sqrt(norm);

  if (norm === 0) return embedding;

  return embedding.map((val) => val / norm);
}

/**
 * Check if embedding API is available and working
 * @returns True if the API is healthy
 */
export async function checkEmbeddingHealth(): Promise<boolean> {
  try {
    const apiKeyType = await retrieveConfigValue('models.embedding.apiKeyType');
    const endpoint = await retrieveConfigValue('models.embedding.endpoint');

    if (apiKeyType === 'infinity') {
      const response = await axios.get(`${endpoint}/models`, {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        validateStatus: (status) => status < 500,
        timeout: 5000,
      });

      return response.status === 200 && response.data?.data !== undefined;
    } else if (apiKeyType === 'enspiraEmb') {
      const response = await axios.get(`${endpoint}/health`, {
        headers: {
          Authorization: `Bearer ${await retrieveConfigValue('models.embedding.apiKey')}`,
        },
        timeout: 5000,
      });
      return response.status === 200;
    } else {
      // Default OpenAI-compatible check - try a simple embedding
      await getMessageEmbedding('test');
      return true;
    }
  } catch (error) {
    logger.log('Embedding', `Health check failed: ${(error as Error).message}`);
    return false;
  }
}

/**
 * Get the dimension of embeddings from the current model
 * @returns Embedding dimension
 */
export async function getEmbeddingDimension(): Promise<number> {
  try {
    const testEmbedding = await getMessageEmbedding('test');
    return testEmbedding.length;
  } catch {
    // Default to common dimension
    return 1024;
  }
}
