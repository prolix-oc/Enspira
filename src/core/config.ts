/**
 * Configuration management with type-safe accessors and fuzzy key matching
 * @module core/config
 */

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import levenshtein from 'fast-levenshtein';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Supported configuration value types */
export type ConfigValueType = 'string' | 'number' | 'boolean' | 'object';

/** Generic configuration object type */
export type ConfigObject = Record<string, unknown>;

/** Result of a fuzzy key search */
export interface FuzzyMatchResult {
  /** The matched key path */
  key: string | null;
  /** Levenshtein distance (lower is closer match) */
  distance: number;
}

/** Path to the configuration file */
const CONFIG_FILE_PATH = path.resolve(__dirname, '../../config/config.json');

/** Cached configuration object */
let configCache: ConfigObject | null = null;

/** Store original data types for proper value conversion */
const originalConfigTypes: Record<string, ConfigValueType> = {};

/**
 * Loads the configuration file into memory
 *
 * @returns The configuration object
 *
 * @example
 * ```ts
 * const config = await loadConfig();
 * console.log(config.models.chat.model);
 * ```
 */
export async function loadConfig(): Promise<ConfigObject> {
  if (configCache) {
    return configCache;
  }

  try {
    configCache = (await fs.readJSON(CONFIG_FILE_PATH)) as ConfigObject;
    storeOriginalTypes(configCache);
    return configCache;
  } catch {
    configCache = {};
    return configCache;
  }
}

/**
 * Recursively stores the original types of all configuration values
 *
 * @param obj - The configuration object to analyze
 * @param parentKey - Parent key path for nested values
 */
function storeOriginalTypes(obj: ConfigObject, parentKey = ''): void {
  for (const key in obj) {
    const value = obj[key];
    const fullPath = parentKey ? `${parentKey}.${key}` : key;

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      storeOriginalTypes(value as ConfigObject, fullPath);
    } else {
      originalConfigTypes[fullPath] = typeof value as ConfigValueType;
    }
  }
}

/**
 * Converts a string value to its original type
 *
 * @param value - The input value (possibly string)
 * @param originalType - The expected target type
 * @returns The converted value
 */
function convertValueToOriginalType(
  value: unknown,
  originalType: ConfigValueType
): unknown {
  if (typeof value === originalType) {
    return value;
  }

  const stringValue = String(value);

  switch (originalType) {
    case 'number': {
      const num = parseFloat(stringValue);
      return isNaN(num) ? 0 : num;
    }
    case 'boolean':
      return (
        stringValue === 'true' ||
        stringValue === '1' ||
        value === 1 ||
        value === true
      );
    case 'string':
      return stringValue;
    default:
      return value;
  }
}

/**
 * Extracts all dot-notation paths from a nested object
 *
 * @param obj - The object to extract paths from
 * @param parentKey - Parent key for recursion
 * @returns Array of all dot-notation paths
 */
function extractAllPaths(obj: ConfigObject, parentKey = ''): string[] {
  let paths: string[] = [];

  for (const key in obj) {
    const fullPath = parentKey ? `${parentKey}.${key}` : key;
    const value = obj[key];

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      paths = paths.concat(extractAllPaths(value as ConfigObject, fullPath));
    } else {
      paths.push(fullPath);
    }
  }

  return paths;
}

/**
 * Finds the closest matching configuration key using Levenshtein distance
 *
 * Enables fuzzy matching for configuration paths, allowing minor typos
 * or case differences to still find the correct key.
 *
 * @param inputPath - The path to search for
 * @param config - The configuration object to search in
 * @param threshold - Maximum edit distance for a match (default: 2)
 * @returns The closest matching key path or null
 */
export function findClosestKey(
  inputPath: string,
  config: ConfigObject,
  threshold = 2
): string | null {
  const keys = extractAllPaths(config);
  const lowerInputPath = inputPath.toLowerCase();

  // Check for exact match first (case-insensitive)
  const exactMatch = keys.find((key) => key.toLowerCase() === lowerInputPath);
  if (exactMatch) {
    return exactMatch;
  }

  // Find closest match using Levenshtein distance
  const closestMatch = keys.reduce<FuzzyMatchResult>(
    (bestMatch, key) => {
      const distance = levenshtein.get(lowerInputPath, key.toLowerCase());
      if (distance < bestMatch.distance) {
        return { key, distance };
      }
      return bestMatch;
    },
    { key: null, distance: Infinity }
  );

  return closestMatch.distance <= threshold ? closestMatch.key : null;
}

/**
 * Forces a reload of the configuration from disk
 */
export async function reloadConfig(): Promise<void> {
  configCache = null;
  await loadConfig();
}

/**
 * Retrieves a value from the configuration using dot notation
 *
 * @param configPath - Dot-notation path to the value (e.g., "models.chat.model")
 * @returns The value at the specified path, or undefined if not found
 *
 * @example
 * ```ts
 * const model = await retrieveConfigValue('models.chat.model');
 * const temperature = await retrieveConfigValue('samplers.temperature');
 * ```
 */
export async function retrieveConfigValue<T = unknown>(
  configPath: string
): Promise<T | undefined> {
  await reloadConfig();

  const pathParts = configPath.split('.');
  let value: unknown = configCache;

  for (const part of pathParts) {
    if (value === null || typeof value !== 'object') {
      return undefined;
    }
    const obj = value as Record<string, unknown>;
    if (obj[part] === undefined) {
      return undefined;
    }
    value = obj[part];
  }

  // Return objects directly
  if (typeof value === 'object' && value !== null) {
    return value as T;
  }

  // Convert to original type if known
  const originalType = originalConfigTypes[configPath];
  if (originalType) {
    return convertValueToOriginalType(value, originalType) as T;
  }

  return value as T;
}

/**
 * Saves a value to the configuration with type conversion and fuzzy key matching
 *
 * @param configPath - Dot-notation path to save the value at
 * @param userInput - The value to save (will be converted to original type)
 * @returns True if save was successful, false otherwise
 *
 * @example
 * ```ts
 * await saveConfigValue('samplers.temperature', '0.7');
 * await saveConfigValue('models.chat.maxTokens', 4096);
 * ```
 */
export async function saveConfigValue(
  configPath: string,
  userInput: unknown
): Promise<boolean> {
  if (!configCache) {
    await loadConfig();
  }

  // Use fuzzy matching to find the actual key
  const inferredPath = findClosestKey(configPath, configCache!);
  if (!inferredPath) {
    return false;
  }

  const pathParts = inferredPath.split('.');
  let obj: Record<string, unknown> = configCache!;

  // Navigate to the parent object
  for (let i = 0; i < pathParts.length - 1; i++) {
    const part = pathParts[i]!;
    if (!obj[part] || typeof obj[part] !== 'object') {
      obj[part] = {};
    }
    obj = obj[part] as Record<string, unknown>;
  }

  const key = pathParts[pathParts.length - 1]!;
  const originalType = originalConfigTypes[inferredPath];

  if (!originalType) {
    throw new Error(`Unknown configuration path: ${inferredPath}`);
  }

  // Convert to the original type
  const convertedValue = convertValueToOriginalType(userInput, originalType);
  obj[key] = convertedValue;

  try {
    await saveConfigToDisk();
    await reloadConfig();
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes the current configuration cache to disk
 */
export async function saveConfigToDisk(): Promise<void> {
  if (configCache) {
    await fs.writeJSON(CONFIG_FILE_PATH, configCache, { spaces: 2 });
  }
}

/**
 * Gets all available configuration paths
 *
 * @returns Array of all dot-notation paths in the configuration
 */
export async function getAllConfigPaths(): Promise<string[]> {
  if (!configCache) {
    await loadConfig();
  }
  return extractAllPaths(configCache!);
}

/**
 * Checks if a configuration path exists
 *
 * @param configPath - Dot-notation path to check
 * @returns True if the path exists
 */
export async function hasConfigValue(configPath: string): Promise<boolean> {
  const value = await retrieveConfigValue(configPath);
  return value !== undefined;
}

/**
 * Gets the type of a configuration value
 *
 * @param configPath - Dot-notation path to check
 * @returns The original type of the value, or undefined if not found
 */
export function getConfigValueType(configPath: string): ConfigValueType | undefined {
  return originalConfigTypes[configPath];
}

export default {
  loadConfig,
  retrieveConfigValue,
  saveConfigValue,
  saveConfigToDisk,
  reloadConfig,
  findClosestKey,
  getAllConfigPaths,
  hasConfigValue,
  getConfigValueType,
};
