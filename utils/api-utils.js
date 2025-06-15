import axios from 'axios';
import https from 'https';
import { logger } from '../create-global-logger.js';

/**
 * Creates an axios instance with consistent defaults
 * @param {object} options - Configuration options
 * @returns {object} - Configured axios instance
 */
export function createApiClient(options = {}) {
  const {
    baseURL = '',
    timeout = 15000,
    headers = {},
    keepAlive = true
  } = options;
  
  // Create https agent with keep-alive
  const httpsAgent = new https.Agent({
    keepAlive,
    rejectUnauthorized: true,
    timeout: timeout
  });
  
  return axios.create({
    baseURL,
    timeout,
    headers: {
      'User-Agent': 'Enspira/1.0',
      'Accept': 'application/json',
      ...headers
    },
    httpsAgent
  });
}

/**
 * Makes API request with automatic retries
 * @param {function} requestFn - Function that returns a promise (e.g., axios call)
 * @param {object} options - Retry options
 * @returns {Promise<any>} - API response
 */
export async function makeRequestWithRetry(requestFn, options = {}) {
  const {
    maxRetries = 3,
    initialDelay = 500,
    maxDelay = 10000,
    factor = 2,
    retryStatusCodes = [408, 429, 500, 502, 503, 504],
    retryErrorCodes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EPIPE'],
    logContext = "API"
  } = options;
  
  let lastError;
  let delay = initialDelay;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error;
      
      // Determine if error is retryable
      const statusCode = error.response?.status;
      const isRetryable = 
        retryStatusCodes.includes(statusCode) || 
        retryErrorCodes.includes(error.code);
      
      if (isRetryable && attempt < maxRetries - 1) {
        // Calculate backoff with jitter
        const jitterDelay = Math.min(
          maxDelay, 
          delay * (0.75 + Math.random() * 0.5)
        );
        
        logger.warn(
          logContext,
          `Request failed (${statusCode || error.code}). Retrying in ${Math.round(jitterDelay)}ms. Attempt ${attempt + 1}/${maxRetries}`
        );
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, jitterDelay));
        delay *= factor;
      } else {
        break;
      }
    }
  }
  
  throw lastError;
}

/**
 * Simplified form data submission with proper error handling
 * @param {string} url - Target URL
 * @param {object} formData - Form data to submit
 * @param {object} [options] - Additional options
 * @returns {Promise<object>} - Response data
 */
export async function submitFormData(url, formData, options = {}) {
  const {
    method = 'POST',
    headers = {},
    timeout = 30000,
    maxRetries = 3
  } = options;
  
  const requestFn = () => axios({
    method,
    url,
    data: formData,
    headers: {
      ...headers,
      'Content-Type': 'multipart/form-data'
    },
    timeout,
    maxContentLength: 100 * 1024 * 1024, // 100MB
    maxBodyLength: 100 * 1024 * 1024 // 100MB
  });
  
  return makeRequestWithRetry(requestFn, { maxRetries });
}