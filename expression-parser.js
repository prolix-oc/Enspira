// expression-parser.js - Memory Optimized Version
import { retrieveConfigValue } from "./config-helper.js";
import { logger } from "./create-global-logger.js";

// FIXED: Bounded cache for expression patterns with LRU eviction
const MAX_EXPRESSION_CACHE_SIZE = 50;
const expressionCache = new Map();

// FIXED: Add cleanup interval for expression cache
setInterval(() => {
  if (expressionCache.size > MAX_EXPRESSION_CACHE_SIZE) {
    // Remove oldest 20% of entries
    const entriesToRemove = Math.floor(MAX_EXPRESSION_CACHE_SIZE * 0.2);
    const oldestKeys = Array.from(expressionCache.keys()).slice(0, entriesToRemove);
    oldestKeys.forEach(key => expressionCache.delete(key));
  }
}, 300000); // Every 5 minutes

/**
 * FIXED: Parses AI response text for expression tags with size limits and caching
 * @param {string} text - The AI response text containing expression tags
 * @param {string[]} availableExpressions - Array of available expressions from the model
 * @returns {Object} - Object containing cleanText and expressions array
 */
export function parseExpressions(text, availableExpressions = []) {
  // FIXED: Input validation and size limits
  if (!text || typeof text !== 'string') {
    return { cleanText: '', expressions: [] };
  }

  // FIXED: Limit input size to prevent memory issues
  if (text.length > 10000) {
    text = text.substring(0, 10000);
    logger.log('Expression', 'Input text truncated to prevent memory issues');
  }

  // FIXED: Check cache first
  const cacheKey = `${text.substring(0, 100)}_${availableExpressions.join(',')}`;
  if (expressionCache.has(cacheKey)) {
    return expressionCache.get(cacheKey);
  }

  // Expression tag pattern: [EXPRESSION:expressionName] or [EXP:expressionName]
  const expressionRegex = /\[(?:EXPRESSION|EXP):(\w+)\]/gi;
  const expressions = [];
  let cleanText = text;
  let totalRemovedLength = 0;

  // FIXED: Limit the number of matches to prevent excessive processing
  const matches = Array.from(text.matchAll(expressionRegex)).slice(0, 20); // Max 20 expressions
  
  for (const match of matches) {
    const expressionName = match[1].toLowerCase();
    const tagPosition = match.index;
    const tagLength = match[0].length;
    
    // Calculate position in clean text (accounting for previously removed tags)
    const cleanTextPosition = tagPosition - totalRemovedLength;
    
    // FIXED: Validate expression exists in available expressions (case-insensitive)
    const validExpression = availableExpressions.find(
      expr => expr.toLowerCase() === expressionName
    );
    
    if (validExpression || availableExpressions.length === 0) {
      expressions.push({
        expression: validExpression || expressionName,
        textPosition: Math.max(0, cleanTextPosition),
        originalTag: match[0],
        isValid: !!validExpression
      });
    }
    
    // Track total length of removed tags
    totalRemovedLength += tagLength;
  }

  // Remove all expression tags from the text
  cleanText = text.replace(expressionRegex, '');
  
  // Clean up any double spaces that might result from tag removal
  cleanText = cleanText.replace(/\s+/g, ' ').trim();

  const result = { 
    cleanText, 
    expressions: expressions.sort((a, b) => a.textPosition - b.textPosition)
  };

  // FIXED: Cache result with size management
  if (expressionCache.size >= MAX_EXPRESSION_CACHE_SIZE) {
    const firstKey = expressionCache.keys().next().value;
    expressionCache.delete(firstKey);
  }
  expressionCache.set(cacheKey, result);

  logger.log('Expression', `Parsed ${expressions.length} expressions from response`);
  
  return result;
}

/**
 * FIXED: Calculates timing for expressions with input validation
 * @param {Array} expressions - Array of expression objects with textPosition
 * @param {string} text - Clean text without expression tags
 * @param {number} estimatedDuration - Estimated audio duration in seconds
 * @returns {Array} - Array of expressions with calculated timing
 */
export function calculateExpressionTimings(expressions, text, estimatedDuration) {
  // FIXED: Input validation
  if (!expressions || !Array.isArray(expressions) || expressions.length === 0) {
    return [];
  }

  if (!text || typeof text !== 'string') {
    return expressions.map(expr => ({
      ...expr,
      startTime: 0,
      duration: 2.0,
      endTime: 2.0
    }));
  }

  // FIXED: Limit processing for very long text
  const maxTextLength = 5000;
  if (text.length > maxTextLength) {
    text = text.substring(0, maxTextLength);
  }

  const totalCharacters = text.length;
  if (totalCharacters === 0) {
    return expressions.map(expr => ({
      ...expr,
      startTime: 0,
      duration: 2.0,
      endTime: 2.0
    }));
  }

  // FIXED: Validate estimatedDuration
  if (!estimatedDuration || estimatedDuration <= 0 || estimatedDuration > 300) {
    estimatedDuration = Math.max(5, totalCharacters / 200); // Rough fallback estimate
  }

  return expressions.map((expr, index) => {
    // Calculate start time based on character position
    const relativePosition = Math.min(expr.textPosition / totalCharacters, 1.0);
    const startTime = relativePosition * estimatedDuration;
    
    // Calculate expression duration (until next expression or end of audio)
    let duration = 2.0; // Default 2 seconds
    
    if (index < expressions.length - 1) {
      const nextExprPosition = Math.min(expressions[index + 1].textPosition / totalCharacters, 1.0);
      const nextExprStartTime = nextExprPosition * estimatedDuration;
      duration = Math.max(1.0, Math.min(nextExprStartTime - startTime, 10.0)); // FIXED: Cap at 10 seconds
    } else {
      // Last expression - hold until near end of audio
      duration = Math.max(1.0, Math.min(estimatedDuration - startTime - 0.5, 10.0));
    }
    
    return {
      expression: expr.expression,
      startTime: Math.max(0, startTime),
      duration: Math.min(duration, 10.0), // FIXED: Cap duration
      endTime: Math.min(startTime + duration, estimatedDuration),
      textPosition: expr.textPosition,
      isValid: expr.isValid
    };
  });
}

/**
 * FIXED: Estimates audio duration with input validation and limits
 * @param {string} text - Text to estimate duration for
 * @param {Object} options - Options for duration estimation
 * @returns {number} - Estimated duration in seconds
 */
export function estimateAudioDuration(text, options = {}) {
  const {
    wordsPerMinute = 150, // Average speaking rate
    pauseFactor = 1.2,    // Factor for natural pauses
    minimumDuration = 1.0, // Minimum duration in seconds
    maximumDuration = 300  // FIXED: Maximum duration of 5 minutes
  } = options;

  // FIXED: Input validation
  if (!text || typeof text !== 'string') {
    return minimumDuration;
  }

  // FIXED: Limit text size for processing
  if (text.length > 10000) {
    text = text.substring(0, 10000);
  }

  // Count words (simple split by whitespace)
  const wordCount = text.trim().split(/\s+/).filter(word => word.length > 0).length;
  
  // FIXED: Validate word count
  if (wordCount === 0) {
    return minimumDuration;
  }

  // Calculate base duration
  const baseDuration = (wordCount / wordsPerMinute) * 60;
  
  // Apply pause factor for natural speech
  const estimatedDuration = baseDuration * pauseFactor;
  
  // FIXED: Apply both minimum and maximum limits
  return Math.max(minimumDuration, Math.min(estimatedDuration, maximumDuration));
}

/**
 * FIXED: Generates enhanced system prompt with size limits
 * @param {string[]} availableExpressions - Array of available expressions
 * @param {string} basePrompt - Base system prompt
 * @returns {string} - Enhanced prompt with expression instructions
 */
export function generateExpressionPrompt(availableExpressions, basePrompt) {
  // FIXED: Input validation
  if (!basePrompt || typeof basePrompt !== 'string') {
    basePrompt = "";
  }

  if (!availableExpressions || !Array.isArray(availableExpressions) || availableExpressions.length === 0) {
    return basePrompt;
  }

  // FIXED: Limit the number of expressions to prevent prompt bloat
  const limitedExpressions = availableExpressions.slice(0, 50); // Max 50 expressions

  const expressionInstructions = `
You can enhance your responses with facial expressions using expression tags. Use the format [EXPRESSION:name] to trigger expressions.

Available expressions: ${limitedExpressions.join(', ')}

Expression Guidelines:
- Use expressions that match the emotional context naturally
- Place expression tags at the beginning of sentences or emotional shifts
- Maximum 1 expression per sentence to avoid overwhelming
- Default to 'neutral' when uncertain about appropriate expression
- Examples:
  * "[EXPRESSION:happy] That's wonderful news!"
  * "[EXPRESSION:thoughtful] Let me consider your question. [EXPRESSION:excited] I have a great idea!"
  * "[EXPRESSION:concerned] I'm worried about that issue."

Remember: Expressions should feel natural and enhance communication, not distract from it.`;

  // FIXED: Limit total prompt size
  const maxPromptSize = 20000; // 20KB limit
  const combinedPrompt = basePrompt + '\n\n' + expressionInstructions;
  
  if (combinedPrompt.length > maxPromptSize) {
    logger.log('Expression', 'Expression prompt truncated due to size limit');
    return basePrompt.substring(0, maxPromptSize - expressionInstructions.length) + '\n\n' + expressionInstructions;
  }

  return combinedPrompt;
}

/**
 * FIXED: Validates and filters expressions with input validation
 * @param {Array} expressions - Array of expression objects
 * @param {string[]} availableExpressions - Valid expressions from the model
 * @returns {Array} - Filtered array of valid expressions
 */
export function validateExpressions(expressions, availableExpressions) {
  // FIXED: Input validation
  if (!expressions || !Array.isArray(expressions)) {
    return [];
  }

  if (!availableExpressions || !Array.isArray(availableExpressions) || availableExpressions.length === 0) {
    // If no available expressions defined, pass all through
    return expressions.slice(0, 20); // FIXED: Limit to 20 expressions
  }

  const validExpressions = expressions.filter(expr => {
    if (!expr || typeof expr.expression !== 'string') {
      return false;
    }

    const isValid = availableExpressions.some(
      available => available.toLowerCase() === expr.expression.toLowerCase()
    );
    
    if (!isValid) {
      logger.log('Expression', `Filtered invalid expression: ${expr.expression}`);
    }
    
    return isValid;
  }).slice(0, 20); // FIXED: Limit to 20 expressions

  logger.log('Expression', `Validated ${validExpressions.length}/${expressions.length} expressions`);
  
  return validExpressions;
}

/**
 * FIXED: Creates expression debug information with size limits
 * @param {string} originalText - Original AI response with tags
 * @param {string} cleanText - Text with tags removed
 * @param {Array} expressions - Parsed expressions
 * @param {string[]} availableExpressions - Available model expressions
 * @returns {Object} - Debug information object
 */
export function createExpressionDebugInfo(originalText, cleanText, expressions, availableExpressions) {
  // FIXED: Input validation and size limits
  const safeOriginalLength = originalText ? Math.min(originalText.length, 100000) : 0;
  const safeCleanLength = cleanText ? Math.min(cleanText.length, 100000) : 0;
  const safeExpressions = Array.isArray(expressions) ? expressions.slice(0, 20) : [];
  const safeAvailableCount = Array.isArray(availableExpressions) ? Math.min(availableExpressions.length, 200) : 0;

  return {
    originalLength: safeOriginalLength,
    cleanLength: safeCleanLength,
    removedCharacters: safeOriginalLength - safeCleanLength,
    expressionCount: safeExpressions.length,
    validExpressions: safeExpressions.filter(e => e && e.isValid).length,
    invalidExpressions: safeExpressions
      .filter(e => e && !e.isValid)
      .map(e => e.expression)
      .slice(0, 10), // FIXED: Limit invalid expressions list
    availableExpressionCount: safeAvailableCount,
    expressionCoverage: safeExpressions.length > 0 && safeCleanLength > 0 ? 
      (safeExpressions[safeExpressions.length - 1].textPosition / safeCleanLength * 100).toFixed(1) + '%' : '0%'
  };
}

/**
 * FIXED: Main function to process AI response with expressions - memory optimized
 * @param {string} aiResponse - Raw AI response text
 * @param {string[]} availableExpressions - Available expressions from model
 * @param {Object} options - Processing options
 * @returns {Object} - Processed response with expressions
 */
export async function processResponseWithExpressions(aiResponse, availableExpressions = [], options = {}) {
  try {
    const {
      enableDebugLogging = false, // FIXED: Default to false to reduce logging overhead
      estimateDuration = true,
      validateExpressionList = true,
      maxProcessingTime = 5000 // FIXED: Add timeout to prevent long processing
    } = options;

    // FIXED: Add timeout wrapper
    const processWithTimeout = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Expression processing timeout'));
      }, maxProcessingTime);

      // Start processing
      processExpressions()
        .then(result => {
          clearTimeout(timeout);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timeout);
          reject(error);
        });
    });

    async function processExpressions() {
      // FIXED: Input validation and size limits
      if (!aiResponse || typeof aiResponse !== 'string') {
        throw new Error('Invalid AI response input');
      }

      // FIXED: Limit input size early
      let processedResponse = aiResponse;
      if (processedResponse.length > 15000) {
        processedResponse = processedResponse.substring(0, 15000);
        logger.log('Expression', 'AI response truncated for expression processing');
      }

      // Parse expressions from the AI response
      const { cleanText, expressions } = parseExpressions(processedResponse, availableExpressions);
      
      // Validate expressions if validation is enabled
      const validatedExpressions = validateExpressionList ? 
        validateExpressions(expressions, availableExpressions) : expressions.slice(0, 20);
      
      // Estimate audio duration for timing calculations
      let estimatedDuration = 0;
      let timedExpressions = [];
      
      if (estimateDuration && cleanText) {
        estimatedDuration = estimateAudioDuration(cleanText);
        timedExpressions = calculateExpressionTimings(validatedExpressions, cleanText, estimatedDuration);
      } else {
        timedExpressions = validatedExpressions;
      }

      // Create debug information
      const debugInfo = enableDebugLogging ? 
        createExpressionDebugInfo(processedResponse, cleanText, expressions, availableExpressions) : null;

      if (enableDebugLogging && debugInfo) {
        logger.log('Expression', `Response processing complete:`, debugInfo);
      }

      return {
        success: true,
        originalText: processedResponse,
        cleanText: cleanText,
        expressions: timedExpressions,
        estimatedDuration: estimatedDuration,
        debug: debugInfo
      };
    }

    return await processWithTimeout;

  } catch (error) {
    logger.error('Expression', `Error processing response with expressions: ${error.message}`);
    
    // FIXED: Return fallback response instead of original to prevent memory issues
    const fallbackText = aiResponse && typeof aiResponse === 'string' 
      ? aiResponse.substring(0, 5000) // Limit fallback size
      : '';
    
    return {
      success: false,
      originalText: fallbackText,
      cleanText: fallbackText,
      expressions: [],
      error: error.message
    };
  }
}

/**
 * FIXED: Clear expression cache manually
 */
export function clearExpressionCache() {
  const size = expressionCache.size;
  expressionCache.clear();
  logger.log('Expression', `Expression cache cleared (${size} entries)`);
  return size;
}

/**
 * FIXED: Get expression processing statistics
 */
export function getExpressionStats() {
  return {
    cacheSize: expressionCache.size,
    maxCacheSize: MAX_EXPRESSION_CACHE_SIZE,
    cacheKeys: Array.from(expressionCache.keys()).slice(0, 5) // Sample of cache keys
  };
}

export default {
  parseExpressions,
  calculateExpressionTimings,
  estimateAudioDuration,
  generateExpressionPrompt,
  validateExpressions,
  processResponseWithExpressions,
  createExpressionDebugInfo,
  clearExpressionCache,
  getExpressionStats
};