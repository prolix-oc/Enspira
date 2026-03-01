/**
 * Expression Parser for Enspira
 * Parses AI response text for expression tags and calculates timing
 * @module core/expression-parser
 */

import { logger } from './logger.js';
import type {
  ParsedExpressionTag,
  ExpressionParseOutput,
  TimedExpression,
  AudioDurationOptions,
  ExpressionProcessingOptions,
  ExpressionDebugInfo,
  ExpressionProcessingResult,
  ExpressionCacheStats,
} from '../types/index.js';

// ============================================
// Cache Configuration
// ============================================

/** Maximum cache size for expression patterns */
const MAX_EXPRESSION_CACHE_SIZE = 50;

/** Bounded cache for expression patterns with LRU eviction */
const expressionCache = new Map<string, ExpressionParseOutput>();

// Cleanup interval for expression cache (every 5 minutes)
setInterval(() => {
  if (expressionCache.size > MAX_EXPRESSION_CACHE_SIZE) {
    // Remove oldest 20% of entries
    const entriesToRemove = Math.floor(MAX_EXPRESSION_CACHE_SIZE * 0.2);
    const oldestKeys = Array.from(expressionCache.keys()).slice(
      0,
      entriesToRemove
    );
    oldestKeys.forEach((key) => expressionCache.delete(key));
  }
}, 300000);

// ============================================
// Core Parsing Functions
// ============================================

/**
 * Parses AI response text for expression tags with size limits and caching
 * @param text - The AI response text containing expression tags
 * @param availableExpressions - Array of available expressions from the model
 * @returns Object containing cleanText and expressions array
 */
export function parseExpressions(
  text: string,
  availableExpressions: string[] = []
): ExpressionParseOutput {
  // Input validation and size limits
  if (!text || typeof text !== 'string') {
    return { cleanText: '', expressions: [] };
  }

  // Limit input size to prevent memory issues
  let processedText = text;
  if (processedText.length > 10000) {
    processedText = processedText.substring(0, 10000);
    logger.log('Expression', 'Input text truncated to prevent memory issues');
  }

  // Check cache first
  const cacheKey = `${processedText.substring(0, 100)}_${availableExpressions.join(',')}`;
  const cachedResult = expressionCache.get(cacheKey);
  if (cachedResult) {
    return cachedResult;
  }

  // Expression tag pattern: [EXPRESSION:expressionName] or [EXP:expressionName]
  const expressionRegex = /\[(?:EXPRESSION|EXP):(\w+)\]/gi;
  const expressions: ParsedExpressionTag[] = [];
  let totalRemovedLength = 0;

  // Limit the number of matches to prevent excessive processing
  const matches = Array.from(processedText.matchAll(expressionRegex)).slice(
    0,
    20
  ); // Max 20 expressions

  for (const match of matches) {
    if (!match[1]) continue; // Skip if no capture group
    const expressionName = match[1].toLowerCase();
    const tagPosition = match.index ?? 0;
    const tagLength = match[0].length;

    // Calculate position in clean text (accounting for previously removed tags)
    const cleanTextPosition = tagPosition - totalRemovedLength;

    // Validate expression exists in available expressions (case-insensitive)
    const validExpression = availableExpressions.find(
      (expr) => expr.toLowerCase() === expressionName
    );

    if (validExpression || availableExpressions.length === 0) {
      expressions.push({
        expression: validExpression || expressionName,
        textPosition: Math.max(0, cleanTextPosition),
        originalTag: match[0],
        isValid: !!validExpression,
      });
    }

    // Track total length of removed tags
    totalRemovedLength += tagLength;
  }

  // Remove all expression tags from the text
  let cleanText = processedText.replace(expressionRegex, '');

  // Clean up any double spaces that might result from tag removal
  cleanText = cleanText.replace(/\s+/g, ' ').trim();

  const result: ExpressionParseOutput = {
    cleanText,
    expressions: expressions.sort((a, b) => a.textPosition - b.textPosition),
  };

  // Cache result with size management
  if (expressionCache.size >= MAX_EXPRESSION_CACHE_SIZE) {
    const firstKey = expressionCache.keys().next().value;
    if (firstKey) {
      expressionCache.delete(firstKey);
    }
  }
  expressionCache.set(cacheKey, result);

  logger.log(
    'Expression',
    `Parsed ${expressions.length} expressions from response`
  );

  return result;
}

/**
 * Calculates timing for expressions with input validation
 * @param expressions - Array of expression objects with textPosition
 * @param text - Clean text without expression tags
 * @param estimatedDuration - Estimated audio duration in seconds
 * @returns Array of expressions with calculated timing
 */
export function calculateExpressionTimings(
  expressions: ParsedExpressionTag[],
  text: string,
  estimatedDuration: number
): TimedExpression[] {
  // Input validation
  if (!expressions || !Array.isArray(expressions) || expressions.length === 0) {
    return [];
  }

  if (!text || typeof text !== 'string') {
    return expressions.map((expr) => ({
      expression: expr.expression,
      startTime: 0,
      duration: 2.0,
      endTime: 2.0,
      textPosition: expr.textPosition,
      isValid: expr.isValid,
    }));
  }

  // Limit processing for very long text
  const maxTextLength = 5000;
  const processedText =
    text.length > maxTextLength ? text.substring(0, maxTextLength) : text;

  const totalCharacters = processedText.length;
  if (totalCharacters === 0) {
    return expressions.map((expr) => ({
      expression: expr.expression,
      startTime: 0,
      duration: 2.0,
      endTime: 2.0,
      textPosition: expr.textPosition,
      isValid: expr.isValid,
    }));
  }

  // Validate estimatedDuration
  let duration = estimatedDuration;
  if (!duration || duration <= 0 || duration > 300) {
    duration = Math.max(5, totalCharacters / 200); // Rough fallback estimate
  }

  return expressions.map((expr, index) => {
    // Calculate start time based on character position
    const relativePosition = Math.min(expr.textPosition / totalCharacters, 1.0);
    const startTime = relativePosition * duration;

    // Calculate expression duration (until next expression or end of audio)
    let exprDuration = 2.0; // Default 2 seconds

    if (index < expressions.length - 1) {
      const nextExpr = expressions[index + 1];
      const nextExprPosition = nextExpr
        ? Math.min(nextExpr.textPosition / totalCharacters, 1.0)
        : 1.0;
      const nextExprStartTime = nextExprPosition * duration;
      exprDuration = Math.max(
        1.0,
        Math.min(nextExprStartTime - startTime, 10.0)
      ); // Cap at 10 seconds
    } else {
      // Last expression - hold until near end of audio
      exprDuration = Math.max(1.0, Math.min(duration - startTime - 0.5, 10.0));
    }

    return {
      expression: expr.expression,
      startTime: Math.max(0, startTime),
      duration: Math.min(exprDuration, 10.0), // Cap duration
      endTime: Math.min(startTime + exprDuration, duration),
      textPosition: expr.textPosition,
      isValid: expr.isValid,
    };
  });
}

/**
 * Estimates audio duration with input validation and limits
 * @param text - Text to estimate duration for
 * @param options - Options for duration estimation
 * @returns Estimated duration in seconds
 */
export function estimateAudioDuration(
  text: string,
  options: AudioDurationOptions = {}
): number {
  const {
    wordsPerMinute = 150, // Average speaking rate
    pauseFactor = 1.2, // Factor for natural pauses
    minimumDuration = 1.0, // Minimum duration in seconds
    maximumDuration = 300, // Maximum duration of 5 minutes
  } = options;

  // Input validation
  if (!text || typeof text !== 'string') {
    return minimumDuration;
  }

  // Limit text size for processing
  const processedText =
    text.length > 10000 ? text.substring(0, 10000) : text;

  // Count words (simple split by whitespace)
  const wordCount = processedText
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;

  // Validate word count
  if (wordCount === 0) {
    return minimumDuration;
  }

  // Calculate base duration
  const baseDuration = (wordCount / wordsPerMinute) * 60;

  // Apply pause factor for natural speech
  const estimatedDuration = baseDuration * pauseFactor;

  // Apply both minimum and maximum limits
  return Math.max(minimumDuration, Math.min(estimatedDuration, maximumDuration));
}

/**
 * Generates enhanced system prompt with size limits
 * @param availableExpressions - Array of available expressions
 * @param basePrompt - Base system prompt
 * @returns Enhanced prompt with expression instructions
 */
export function generateExpressionPrompt(
  availableExpressions: string[],
  basePrompt: string
): string {
  // Input validation
  let prompt = basePrompt;
  if (!prompt || typeof prompt !== 'string') {
    prompt = '';
  }

  if (
    !availableExpressions ||
    !Array.isArray(availableExpressions) ||
    availableExpressions.length === 0
  ) {
    return prompt;
  }

  // Limit the number of expressions to prevent prompt bloat
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

  // Limit total prompt size
  const maxPromptSize = 20000; // 20KB limit
  const combinedPrompt = prompt + '\n\n' + expressionInstructions;

  if (combinedPrompt.length > maxPromptSize) {
    logger.log('Expression', 'Expression prompt truncated due to size limit');
    return (
      prompt.substring(0, maxPromptSize - expressionInstructions.length) +
      '\n\n' +
      expressionInstructions
    );
  }

  return combinedPrompt;
}

/**
 * Validates and filters expressions with input validation
 * @param expressions - Array of expression objects
 * @param availableExpressions - Valid expressions from the model
 * @returns Filtered array of valid expressions
 */
export function validateExpressions(
  expressions: ParsedExpressionTag[],
  availableExpressions: string[]
): ParsedExpressionTag[] {
  // Input validation
  if (!expressions || !Array.isArray(expressions)) {
    return [];
  }

  if (
    !availableExpressions ||
    !Array.isArray(availableExpressions) ||
    availableExpressions.length === 0
  ) {
    // If no available expressions defined, pass all through
    return expressions.slice(0, 20); // Limit to 20 expressions
  }

  const validExpressions = expressions
    .filter((expr) => {
      if (!expr || typeof expr.expression !== 'string') {
        return false;
      }

      const isValid = availableExpressions.some(
        (available) =>
          available.toLowerCase() === expr.expression.toLowerCase()
      );

      if (!isValid) {
        logger.log(
          'Expression',
          `Filtered invalid expression: ${expr.expression}`
        );
      }

      return isValid;
    })
    .slice(0, 20); // Limit to 20 expressions

  logger.log(
    'Expression',
    `Validated ${validExpressions.length}/${expressions.length} expressions`
  );

  return validExpressions;
}

/**
 * Creates expression debug information with size limits
 * @param originalText - Original AI response with tags
 * @param cleanText - Text with tags removed
 * @param expressions - Parsed expressions
 * @param availableExpressions - Available model expressions
 * @returns Debug information object
 */
export function createExpressionDebugInfo(
  originalText: string,
  cleanText: string,
  expressions: ParsedExpressionTag[],
  availableExpressions: string[]
): ExpressionDebugInfo {
  // Input validation and size limits
  const safeOriginalLength = originalText
    ? Math.min(originalText.length, 100000)
    : 0;
  const safeCleanLength = cleanText
    ? Math.min(cleanText.length, 100000)
    : 0;
  const safeExpressions = Array.isArray(expressions)
    ? expressions.slice(0, 20)
    : [];
  const safeAvailableCount = Array.isArray(availableExpressions)
    ? Math.min(availableExpressions.length, 200)
    : 0;

  return {
    originalLength: safeOriginalLength,
    cleanLength: safeCleanLength,
    removedCharacters: safeOriginalLength - safeCleanLength,
    expressionCount: safeExpressions.length,
    validExpressions: safeExpressions.filter((e) => e && e.isValid).length,
    invalidExpressions: safeExpressions
      .filter((e) => e && !e.isValid)
      .map((e) => e.expression)
      .slice(0, 10), // Limit invalid expressions list
    availableExpressionCount: safeAvailableCount,
    expressionCoverage:
      safeExpressions.length > 0 && safeCleanLength > 0
        ? (() => {
            const lastExpr = safeExpressions[safeExpressions.length - 1];
            return lastExpr
              ? ((lastExpr.textPosition / safeCleanLength) * 100).toFixed(1) + '%'
              : '0%';
          })()
        : '0%',
  };
}

/**
 * Main function to process AI response with expressions - memory optimized
 * @param aiResponse - Raw AI response text
 * @param availableExpressions - Available expressions from model
 * @param options - Processing options
 * @returns Processed response with expressions
 */
export async function processResponseWithExpressions(
  aiResponse: string,
  availableExpressions: string[] = [],
  options: ExpressionProcessingOptions = {}
): Promise<ExpressionProcessingResult> {
  try {
    const {
      enableDebugLogging = false, // Default to false to reduce logging overhead
      estimateDuration = true,
      validateExpressionList = true,
      maxProcessingTime = 5000, // Add timeout to prevent long processing
    } = options;

    // Add timeout wrapper
    const processWithTimeout = new Promise<ExpressionProcessingResult>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Expression processing timeout'));
        }, maxProcessingTime);

        // Start processing
        processExpressions()
          .then((result) => {
            clearTimeout(timeout);
            resolve(result);
          })
          .catch((error) => {
            clearTimeout(timeout);
            reject(error);
          });
      }
    );

    async function processExpressions(): Promise<ExpressionProcessingResult> {
      // Input validation and size limits
      if (!aiResponse || typeof aiResponse !== 'string') {
        throw new Error('Invalid AI response input');
      }

      // Limit input size early
      let processedResponse = aiResponse;
      if (processedResponse.length > 15000) {
        processedResponse = processedResponse.substring(0, 15000);
        logger.log(
          'Expression',
          'AI response truncated for expression processing'
        );
      }

      // Parse expressions from the AI response
      const { cleanText, expressions } = parseExpressions(
        processedResponse,
        availableExpressions
      );

      // Validate expressions if validation is enabled
      const validatedExpressions = validateExpressionList
        ? validateExpressions(expressions, availableExpressions)
        : expressions.slice(0, 20);

      // Estimate audio duration for timing calculations
      let estimatedDurationValue = 0;
      let timedExpressions: TimedExpression[] = [];

      if (estimateDuration && cleanText) {
        estimatedDurationValue = estimateAudioDuration(cleanText);
        timedExpressions = calculateExpressionTimings(
          validatedExpressions,
          cleanText,
          estimatedDurationValue
        );
      } else {
        // Convert to TimedExpression without timing
        timedExpressions = validatedExpressions.map((expr) => ({
          expression: expr.expression,
          startTime: 0,
          duration: 2.0,
          endTime: 2.0,
          textPosition: expr.textPosition,
          isValid: expr.isValid,
        }));
      }

      // Create debug information
      const debugInfo = enableDebugLogging
        ? createExpressionDebugInfo(
            processedResponse,
            cleanText,
            expressions,
            availableExpressions
          )
        : null;

      if (enableDebugLogging && debugInfo) {
        logger.log(
          'Expression',
          `Response processing complete: ${JSON.stringify(debugInfo)}`
        );
      }

      return {
        success: true,
        originalText: processedResponse,
        cleanText: cleanText,
        expressions: timedExpressions,
        estimatedDuration: estimatedDurationValue,
        debug: debugInfo,
      };
    }

    return await processWithTimeout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      'Expression',
      `Error processing response with expressions: ${message}`
    );

    // Return fallback response instead of original to prevent memory issues
    const fallbackText =
      aiResponse && typeof aiResponse === 'string'
        ? aiResponse.substring(0, 5000) // Limit fallback size
        : '';

    return {
      success: false,
      originalText: fallbackText,
      cleanText: fallbackText,
      expressions: [],
      error: message,
    };
  }
}

/**
 * Clear expression cache manually
 * @returns Number of entries cleared
 */
export function clearExpressionCache(): number {
  const size = expressionCache.size;
  expressionCache.clear();
  logger.log('Expression', `Expression cache cleared (${size} entries)`);
  return size;
}

/**
 * Get expression processing statistics
 * @returns Cache statistics object
 */
export function getExpressionStats(): ExpressionCacheStats {
  return {
    cacheSize: expressionCache.size,
    maxCacheSize: MAX_EXPRESSION_CACHE_SIZE,
    cacheKeys: Array.from(expressionCache.keys()).slice(0, 5), // Sample of cache keys
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
  getExpressionStats,
};
