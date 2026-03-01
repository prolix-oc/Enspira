/**
 * String manipulation utilities
 * @module utils/strings
 */

/** Map of placeholder strings to their replacement values */
export type PlaceholderMap = Record<string, string | number | boolean | null | undefined>;

/**
 * Replaces placeholders in template strings
 *
 * @param template - Template string with placeholders
 * @param replacements - Map of placeholders to values
 * @returns Processed string with placeholders replaced
 *
 * @example
 * ```ts
 * replacePlaceholders('Hello {{name}}!', { '{{name}}': 'World' });
 * // Returns: 'Hello World!'
 * ```
 */
export function replacePlaceholders(
  template: string | null | undefined,
  replacements: PlaceholderMap
): string {
  if (!template) return '';

  let result = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    // Skip undefined values
    if (value === undefined) continue;

    // Convert null to empty string, others to string
    const replacement = value === null ? '' : String(value);

    // Use global regex for all occurrences
    result = result.replace(new RegExp(escapeRegExp(placeholder), 'g'), replacement);
  }

  return result;
}

/**
 * Escapes special characters in string for use in RegExp
 *
 * @param str - String to escape
 * @returns Escaped string safe for RegExp
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Default acronyms that should not be transformed */
const DEFAULT_ACRONYM_EXCEPTIONS = ['GOATs', 'LOL', 'LMAO'] as const;

/** Options for TTS text transformation */
export interface TtsTransformOptions {
  /** Acronyms to skip transformation (default: GOATs, LOL, LMAO) */
  acronymExceptions?: readonly string[];
  /** Separate acronym letters with dots (default: true) */
  separateWithDots?: boolean;
}

/** Statistics from TTS transformation */
export interface TtsTransformStats {
  /** Number of acronyms transformed */
  acronymCount: number;
  /** Number of .js occurrences transformed */
  jsCount: number;
}

/** Result of TTS text transformation */
export interface TtsTransformResult {
  /** Transformed text */
  text: string;
  /** Transformation statistics */
  stats: TtsTransformStats;
}

/**
 * Transforms TTS text by handling acronyms and special formats
 *
 * Converts uppercase acronyms to a more pronounceable format:
 * - With dots: "NASA" → "N.A.S.A"
 * - Without dots: "NASA" → "N A S A"
 *
 * Also handles .js file extensions: ".js" → ".J.S"
 *
 * @param input - Input string
 * @param options - Transformation options
 * @returns Transformed string and statistics
 *
 * @example
 * ```ts
 * transformTtsText('Check the NASA API docs.js');
 * // Returns: { text: 'Check the N.A.S.A A.P.I docs.J.S', stats: { acronymCount: 2, jsCount: 1 } }
 * ```
 */
export function transformTtsText(
  input: string,
  options: TtsTransformOptions = {}
): TtsTransformResult {
  const {
    acronymExceptions = DEFAULT_ACRONYM_EXCEPTIONS,
    separateWithDots = true,
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
      // Handle plural acronyms (ending in S)
      if (match.endsWith('S') && match.length > 2) {
        const base = match.slice(0, -1).split('').join('.');
        return `${base}'s`;
      }
      return match.slice(0, -1).split('').join('.') + '.' + match.slice(-1);
    } else {
      // Spell out with spaces
      return match.split('').join(' ');
    }
  });

  transformed = transformed.replace(jsRegex, () => {
    jsCount++;
    return '.J.S';
  });

  return {
    text: transformed,
    stats: {
      acronymCount,
      jsCount,
    },
  };
}

/**
 * Truncates a string to a maximum length with ellipsis
 *
 * Attempts to break at word boundaries when possible.
 *
 * @param input - Input string
 * @param maxLength - Maximum length including ellipsis
 * @returns Truncated string
 *
 * @example
 * ```ts
 * truncateWithEllipsis('Hello wonderful world', 15);
 * // Returns: 'Hello...'
 * ```
 */
export function truncateWithEllipsis(
  input: string | null | undefined,
  maxLength: number
): string {
  if (!input || input.length <= maxLength) {
    return input ?? '';
  }

  // Find a good breaking point (word boundary)
  const breakPoint = input.lastIndexOf(' ', maxLength - 3);
  if (breakPoint > maxLength * 0.7) {
    return input.substring(0, breakPoint) + '...';
  }

  // If no good breaking point, just truncate
  return input.substring(0, maxLength - 3) + '...';
}

/**
 * Capitalizes the first letter of a string
 *
 * @param str - Input string
 * @returns String with first letter capitalized
 */
export function capitalize(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Converts a string to kebab-case
 *
 * @param str - Input string
 * @returns Kebab-cased string
 */
export function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

/**
 * Converts a string to camelCase
 *
 * @param str - Input string
 * @returns CamelCased string
 */
export function toCamelCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[-_\s]+(.)?/g, (_, char) => (char ? char.toUpperCase() : ''));
}

/**
 * Removes extra whitespace and normalizes line breaks
 *
 * @param str - Input string
 * @returns Normalized string
 */
export function normalizeWhitespace(str: string): string {
  return str.replace(/\s+/g, ' ').trim();
}
