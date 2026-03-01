/**
 * File system utilities with caching and error handling
 * @module utils/files
 */

import fs from 'fs-extra';
import path from 'path';
import { logger } from '../core/logger.js';

/** Cache for template files to avoid repeated disk reads */
const templateCache = new Map<string, string>();

/**
 * Reads a template file with caching
 * Uses in-memory cache to avoid repeated disk reads for frequently used templates
 *
 * @param filePath - Absolute path to template file
 * @returns Template content as string
 * @throws Error if file cannot be read
 */
export async function getTemplate(filePath: string): Promise<string> {
  if (templateCache.has(filePath)) {
    return templateCache.get(filePath)!;
  }

  try {
    // In Bun, could also use: await Bun.file(filePath).text()
    const content = await fs.readFile(filePath, 'utf-8');
    templateCache.set(filePath, content);
    return content;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Files', `Error reading template file ${filePath}: ${message}`);
    throw error;
  }
}

/**
 * Clears the template cache (useful for development/hot-reloading)
 * @param filePath - Optional specific file to clear, or clears all if omitted
 */
export function clearTemplateCache(filePath?: string): void {
  if (filePath) {
    templateCache.delete(filePath);
  } else {
    templateCache.clear();
  }
}

/**
 * Gets the current size of the template cache
 */
export function getTemplateCacheSize(): number {
  return templateCache.size;
}

/** Result of reading multiple files */
export type MultiFileResult = Record<string, string>;

/**
 * Reads multiple files in parallel and returns contents organized by file name
 *
 * @param basePath - Base directory path
 * @param fileNames - Array of file names (without extension)
 * @param extension - File extension (default: '.txt')
 * @returns Object with fileNames as keys and content as values
 */
export async function readMultipleFiles(
  basePath: string,
  fileNames: string[],
  extension: string = '.txt'
): Promise<MultiFileResult> {
  const fileContents: MultiFileResult = {};

  await Promise.all(
    fileNames.map(async (fileName) => {
      const filePath = path.join(basePath, `${fileName}${extension}`);
      try {
        fileContents[fileName] = await fs.readFile(filePath, 'utf-8');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.log('Files', `Error reading file ${filePath}: ${message}`);
        fileContents[fileName] = ''; // Default empty string for missing files
      }
    })
  );

  return fileContents;
}

/** Options for JSON writing */
export interface WriteJSONOptions {
  /** Number of spaces for indentation (default: 2) */
  spaces?: number;
  /** End of line character (default: '\n') */
  EOL?: string;
}

/**
 * Safely writes JSON data to a file with proper error handling
 * Creates parent directories if they don't exist
 *
 * @param filePath - Absolute path to write the file
 * @param data - Data to serialize as JSON
 * @param options - Writing options
 * @returns True if write was successful, false otherwise
 */
export async function safeWriteJSON(
  filePath: string,
  data: unknown,
  options: WriteJSONOptions = {}
): Promise<boolean> {
  try {
    // Ensure directory exists
    await fs.ensureDir(path.dirname(filePath));

    // Write with custom options or defaults
    await fs.writeJSON(filePath, data, {
      spaces: 2,
      EOL: '\n',
      ...options,
    });

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Files', `Error writing JSON to ${filePath}: ${message}`);
    return false;
  }
}

/**
 * Safely reads and parses a JSON file
 *
 * @param filePath - Absolute path to JSON file
 * @param defaultValue - Value to return if file doesn't exist or is invalid
 * @returns Parsed JSON data or default value
 */
export async function safeReadJSON<T>(
  filePath: string,
  defaultValue: T
): Promise<T> {
  try {
    if (await fs.pathExists(filePath)) {
      return (await fs.readJSON(filePath)) as T;
    }
    return defaultValue;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Files', `Error reading JSON from ${filePath}: ${message}`);
    return defaultValue;
  }
}

/**
 * Checks if a file exists
 *
 * @param filePath - Path to check
 * @returns True if file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  return fs.pathExists(filePath);
}

/**
 * Ensures a directory exists, creating it if necessary
 *
 * @param dirPath - Directory path
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.ensureDir(dirPath);
}
