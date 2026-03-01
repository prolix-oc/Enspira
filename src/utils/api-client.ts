/**
 * HTTP client utilities with retry logic and connection pooling
 * @module utils/api-client
 */

import axios, { type AxiosInstance, type AxiosResponse, type AxiosError } from 'axios';
import https from 'https';
import { logger } from '../core/logger.js';

/** Options for creating an API client */
export interface ApiClientOptions {
  /** Base URL for all requests */
  baseURL?: string;
  /** Request timeout in milliseconds (default: 15000) */
  timeout?: number;
  /** Custom headers to include in all requests */
  headers?: Record<string, string>;
  /** Enable HTTP keep-alive (default: true) */
  keepAlive?: boolean;
}

/**
 * Creates an axios instance with consistent defaults and connection pooling
 *
 * @param options - Client configuration options
 * @returns Configured axios instance
 */
export function createApiClient(options: ApiClientOptions = {}): AxiosInstance {
  const {
    baseURL = '',
    timeout = 15000,
    headers = {},
    keepAlive = true,
  } = options;

  // Create https agent with keep-alive for connection reuse
  const httpsAgent = new https.Agent({
    keepAlive,
    rejectUnauthorized: true,
    timeout,
  });

  return axios.create({
    baseURL,
    timeout,
    headers: {
      'User-Agent': 'Enspira/1.0',
      Accept: 'application/json',
      ...headers,
    },
    httpsAgent,
  });
}

/** HTTP status codes that warrant a retry */
const DEFAULT_RETRY_STATUS_CODES = [408, 429, 500, 502, 503, 504] as const;

/** Network error codes that warrant a retry */
const DEFAULT_RETRY_ERROR_CODES = [
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
] as const;

/** Options for request retry behavior */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay between retries in ms (default: 500) */
  initialDelay?: number;
  /** Maximum delay between retries in ms (default: 10000) */
  maxDelay?: number;
  /** Exponential backoff factor (default: 2) */
  factor?: number;
  /** HTTP status codes to retry on */
  retryStatusCodes?: readonly number[];
  /** Network error codes to retry on */
  retryErrorCodes?: readonly string[];
  /** Context for log messages */
  logContext?: string;
}

/**
 * Makes an API request with automatic retries and exponential backoff
 *
 * Implements jittered exponential backoff to prevent thundering herd problems.
 *
 * @param requestFn - Function that returns a promise (e.g., axios call)
 * @param options - Retry behavior options
 * @returns API response
 * @throws Last error if all retries fail
 *
 * @example
 * ```ts
 * const response = await makeRequestWithRetry(
 *   () => axios.get('https://api.example.com/data'),
 *   { maxRetries: 3, logContext: 'ExampleAPI' }
 * );
 * ```
 */
export async function makeRequestWithRetry<T>(
  requestFn: () => Promise<AxiosResponse<T>>,
  options: RetryOptions = {}
): Promise<AxiosResponse<T>> {
  const {
    maxRetries = 3,
    initialDelay = 500,
    maxDelay = 10000,
    factor = 2,
    retryStatusCodes = DEFAULT_RETRY_STATUS_CODES,
    retryErrorCodes = DEFAULT_RETRY_ERROR_CODES,
    logContext = 'API',
  } = options;

  let lastError: Error | undefined;
  let delay = initialDelay;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error as Error;

      const axiosError = error as AxiosError;
      const statusCode = axiosError.response?.status;
      const errorCode = axiosError.code;

      // Determine if error is retryable
      const isRetryable =
        (statusCode !== undefined && retryStatusCodes.includes(statusCode)) ||
        (errorCode !== undefined && retryErrorCodes.includes(errorCode));

      if (isRetryable && attempt < maxRetries - 1) {
        // Calculate backoff with jitter (0.75 to 1.25 multiplier)
        const jitterDelay = Math.min(maxDelay, delay * (0.75 + Math.random() * 0.5));

        logger.warn(
          logContext,
          `Request failed (${statusCode ?? errorCode}). Retrying in ${Math.round(jitterDelay)}ms. Attempt ${attempt + 1}/${maxRetries}`
        );

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, jitterDelay));
        delay *= factor;
      } else {
        break;
      }
    }
  }

  throw lastError;
}

/** HTTP methods for form data submission */
export type HttpMethod = 'POST' | 'PUT' | 'PATCH';

/** Options for form data submission */
export interface FormDataOptions {
  /** HTTP method (default: POST) */
  method?: HttpMethod;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
}

/**
 * Submits form data with proper error handling and retries
 *
 * Handles multipart form data with large file support (up to 100MB).
 *
 * @param url - Target URL
 * @param formData - Form data to submit
 * @param options - Request options
 * @returns Response data
 */
export async function submitFormData<T = unknown>(
  url: string,
  formData: FormData | Record<string, unknown>,
  options: FormDataOptions = {}
): Promise<AxiosResponse<T>> {
  const {
    method = 'POST',
    headers = {},
    timeout = 30000,
    maxRetries = 3,
  } = options;

  const requestFn = () =>
    axios<T>({
      method,
      url,
      data: formData,
      headers: {
        ...headers,
        'Content-Type': 'multipart/form-data',
      },
      timeout,
      maxContentLength: 100 * 1024 * 1024, // 100MB
      maxBodyLength: 100 * 1024 * 1024, // 100MB
    });

  return makeRequestWithRetry<T>(requestFn, { maxRetries });
}

/**
 * Simple GET request with retry logic
 *
 * @param url - URL to fetch
 * @param options - Retry options
 * @returns Response data
 */
export async function fetchWithRetry<T = unknown>(
  url: string,
  options: RetryOptions & { headers?: Record<string, string> } = {}
): Promise<T> {
  const { headers, ...retryOptions } = options;

  const response = await makeRequestWithRetry<T>(
    () =>
      axios.get<T>(url, {
        headers: {
          Accept: 'application/json',
          ...headers,
        },
      }),
    retryOptions
  );

  return response.data;
}

/**
 * POST request with JSON body and retry logic
 *
 * @param url - URL to post to
 * @param data - Request body
 * @param options - Retry options
 * @returns Response data
 */
export async function postWithRetry<T = unknown, D = unknown>(
  url: string,
  data: D,
  options: RetryOptions & { headers?: Record<string, string> } = {}
): Promise<T> {
  const { headers, ...retryOptions } = options;

  const response = await makeRequestWithRetry<T>(
    () =>
      axios.post<T>(url, data, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...headers,
        },
      }),
    retryOptions
  );

  return response.data;
}
