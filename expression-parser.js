// expression-parser.js
import { retrieveConfigValue } from "./config-helper.js";

/**
 * Parses AI response text for expression tags and extracts clean text with expression metadata
 * @param {string} text - The AI response text containing expression tags
 * @param {string[]} availableExpressions - Array of available expressions from the model
 * @returns {Object} - Object containing cleanText and expressions array
 */
export function parseExpressions(text, availableExpressions = []) {
  if (!text || typeof text !== 'string') {
    return { cleanText: '', expressions: [] };
  }

  // Expression tag pattern: [EXPRESSION:expressionName] or [EXP:expressionName]
  const expressionRegex = /\[(?:EXPRESSION|EXP):(\w+)\]/gi;
  const expressions = [];
  let cleanText = text;
  let totalRemovedLength = 0;

  // Find all expression matches with their positions
  const matches = Array.from(text.matchAll(expressionRegex));
  
  for (const match of matches) {
    const expressionName = match[1].toLowerCase();
    const tagPosition = match.index;
    const tagLength = match[0].length;
    
    // Calculate position in clean text (accounting for previously removed tags)
    const cleanTextPosition = tagPosition - totalRemovedLength;
    
    // Validate expression exists in available expressions (case-insensitive)
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

  logger.log('Expression', `Parsed ${expressions.length} expressions from response`);
  
  return { 
    cleanText, 
    expressions: expressions.sort((a, b) => a.textPosition - b.textPosition)
  };
}

/**
 * Calculates timing for expressions based on text positions and estimated audio duration
 * @param {Array} expressions - Array of expression objects with textPosition
 * @param {string} text - Clean text without expression tags
 * @param {number} estimatedDuration - Estimated audio duration in seconds
 * @returns {Array} - Array of expressions with calculated timing
 */
export function calculateExpressionTimings(expressions, text, estimatedDuration) {
  if (!expressions || expressions.length === 0) {
    return [];
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

  return expressions.map((expr, index) => {
    // Calculate start time based on character position
    const relativePosition = expr.textPosition / totalCharacters;
    const startTime = relativePosition * estimatedDuration;
    
    // Calculate expression duration (until next expression or end of audio)
    let duration = 2.0; // Default 2 seconds
    
    if (index < expressions.length - 1) {
      const nextExprStartTime = (expressions[index + 1].textPosition / totalCharacters) * estimatedDuration;
      duration = Math.max(1.0, nextExprStartTime - startTime);
    } else {
      // Last expression - hold until near end of audio
      duration = Math.max(1.0, estimatedDuration - startTime - 0.5);
    }
    
    return {
      expression: expr.expression,
      startTime: Math.max(0, startTime),
      duration: duration,
      endTime: startTime + duration,
      textPosition: expr.textPosition,
      isValid: expr.isValid
    };
  });
}

/**
 * Estimates audio duration based on text length and speaking rate
 * @param {string} text - Text to estimate duration for
 * @param {Object} options - Options for duration estimation
 * @returns {number} - Estimated duration in seconds
 */
export function estimateAudioDuration(text, options = {}) {
  const {
    wordsPerMinute = 150, // Average speaking rate
    pauseFactor = 1.2,    // Factor for natural pauses
    minimumDuration = 1.0  // Minimum duration in seconds
  } = options;

  if (!text || typeof text !== 'string') {
    return minimumDuration;
  }

  // Count words (simple split by whitespace)
  const wordCount = text.trim().split(/\s+/).length;
  
  // Calculate base duration
  const baseDuration = (wordCount / wordsPerMinute) * 60;
  
  // Apply pause factor for natural speech
  const estimatedDuration = baseDuration * pauseFactor;
  
  return Math.max(minimumDuration, estimatedDuration);
}

/**
 * Generates enhanced system prompt with expression instructions
 * @param {string[]} availableExpressions - Array of available expressions
 * @param {string} basePrompt - Base system prompt
 * @returns {string} - Enhanced prompt with expression instructions
 */
export function generateExpressionPrompt(availableExpressions, basePrompt) {
  if (!availableExpressions || availableExpressions.length === 0) {
    return basePrompt;
  }

  const expressionInstructions = `
You can enhance your responses with facial expressions using expression tags. Use the format [EXPRESSION:name] to trigger expressions.

Available expressions: ${availableExpressions.join(', ')}

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

  return basePrompt + '\n\n' + expressionInstructions;
}

/**
 * Validates and filters expressions based on available model expressions
 * @param {Array} expressions - Array of expression objects
 * @param {string[]} availableExpressions - Valid expressions from the model
 * @returns {Array} - Filtered array of valid expressions
 */
export function validateExpressions(expressions, availableExpressions) {
  if (!expressions || !Array.isArray(expressions)) {
    return [];
  }

  if (!availableExpressions || availableExpressions.length === 0) {
    // If no available expressions defined, pass all through
    return expressions;
  }

  const validExpressions = expressions.filter(expr => {
    const isValid = availableExpressions.some(
      available => available.toLowerCase() === expr.expression.toLowerCase()
    );
    
    if (!isValid) {
      logger.log('Expression', `Filtered invalid expression: ${expr.expression}`);
    }
    
    return isValid;
  });

  logger.log('Expression', `Validated ${validExpressions.length}/${expressions.length} expressions`);
  
  return validExpressions;
}

/**
 * Creates expression debug information for logging and troubleshooting
 * @param {string} originalText - Original AI response with tags
 * @param {string} cleanText - Text with tags removed
 * @param {Array} expressions - Parsed expressions
 * @param {string[]} availableExpressions - Available model expressions
 * @returns {Object} - Debug information object
 */
export function createExpressionDebugInfo(originalText, cleanText, expressions, availableExpressions) {
  return {
    originalLength: originalText.length,
    cleanLength: cleanText.length,
    removedCharacters: originalText.length - cleanText.length,
    expressionCount: expressions.length,
    validExpressions: expressions.filter(e => e.isValid).length,
    invalidExpressions: expressions.filter(e => !e.isValid).map(e => e.expression),
    availableExpressionCount: availableExpressions?.length || 0,
    expressionCoverage: expressions.length > 0 ? 
      (expressions[expressions.length - 1].textPosition / cleanText.length * 100).toFixed(1) + '%' : '0%'
  };
}

/**
 * Main function to process AI response with expressions
 * @param {string} aiResponse - Raw AI response text
 * @param {string[]} availableExpressions - Available expressions from model
 * @param {Object} options - Processing options
 * @returns {Object} - Processed response with expressions
 */
export async function processResponseWithExpressions(aiResponse, availableExpressions = [], options = {}) {
  try {
    const {
      enableDebugLogging = true,
      estimateDuration = true,
      validateExpressionList = true
    } = options;

    // Parse expressions from the AI response
    const { cleanText, expressions } = parseExpressions(aiResponse, availableExpressions);
    
    // Validate expressions if validation is enabled
    const validatedExpressions = validateExpressionList ? 
      validateExpressions(expressions, availableExpressions) : expressions;
    
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
      createExpressionDebugInfo(aiResponse, cleanText, expressions, availableExpressions) : null;

    if (enableDebugLogging && debugInfo) {
      logger.log('Expression', `Response processing complete:`, debugInfo);
    }

    return {
      success: true,
      originalText: aiResponse,
      cleanText: cleanText,
      expressions: timedExpressions,
      estimatedDuration: estimatedDuration,
      debug: debugInfo
    };

  } catch (error) {
    logger.error('Expression', `Error processing response with expressions: ${error.message}`);
    
    return {
      success: false,
      originalText: aiResponse,
      cleanText: aiResponse, // Fallback to original text
      expressions: [],
      error: error.message
    };
  }
}

export default {
  parseExpressions,
  calculateExpressionTimings,
  estimateAudioDuration,
  generateExpressionPrompt,
  validateExpressions,
  processResponseWithExpressions,
  createExpressionDebugInfo
};