/**
 * Replaces placeholders in template strings
 * @param {string} template - Template string with placeholders
 * @param {object} replacements - Map of placeholders to values
 * @returns {string} - Processed string
 */
export function replacePlaceholders(template, replacements) {
    if (!template) return '';
    
    let result = template;
    for (const [placeholder, value] of Object.entries(replacements)) {
      // Skip undefined values
      if (value === undefined) continue;
      
      // Convert null to empty string
      const replacement = value === null ? '' : value;
      
      // Use global regex for all occurrences
      result = result.replace(
        new RegExp(escapeRegExp(placeholder), 'g'), 
        replacement
      );
    }
    
    return result;
  }
  
  /**
   * Escapes special characters in string for regex
   * @param {string} string - String to escape
   * @returns {string} - Escaped string
   */
  export function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  
  /**
   * Transforms TTS text by handling acronyms and special formats
   * @param {string} input - Input string
   * @param {object} [options] - Transformation options
   * @returns {object} - Transformed string and statistics
   */
  export function transformTtsText(input, options = {}) {
    const {
      acronymExceptions = ["GOATs", "LOL", "LMAO"],
      separateWithDots = true
    } = options;
    
    const acronymRegex = /\b([A-Z]{2,})(?!\w)/g;
    const jsRegex = /\.js\b/gi;
    
    let acronymCount = 0;
    let jsCount = 0;
    
    let transformed = input.replace(acronymRegex, (match) => {
      if (acronymExceptions.includes(match)) {
        return match;
      }
      
      acronymCount++;
      
      if (separateWithDots) {
        let result = match.slice(0, -1).split("").join(".") + "." + match.slice(-1);
        if (match.endsWith("S") && match.length > 2) {
          const base = match.slice(0, -1).split("").join(".");
          result = `${base}'s`;
        }
        return result;
      } else {
        // Alternate transformation: spell out with spaces
        return match.split("").join(" ");
      }
    });
    
    transformed = transformed.replace(jsRegex, (match) => {
      jsCount++;
      return ".J.S";
    });
    
    return { 
      text: transformed, 
      stats: {
        acronymCount,
        jsCount
      }
    };
  }
  
  /**
   * Formats a string for fixed character limit
   * @param {string} input - Input string
   * @param {number} maxLength - Maximum length
   * @returns {string} - Truncated string
   */
  export function truncateWithEllipsis(input, maxLength) {
    if (!input || input.length <= maxLength) {
      return input;
    }
    
    // Find a good breaking point
    const breakPoint = input.lastIndexOf(' ', maxLength - 3);
    if (breakPoint > maxLength * 0.7) {
      return input.substring(0, breakPoint) + '...';
    }
    
    // If no good breaking point, just truncate
    return input.substring(0, maxLength - 3) + '...';
  }