import fs from 'fs-extra';
import path from 'path';
import { logger } from '../create-global-logger.js';

// Cache for template files
const templateCache = new Map();

/**
 * Reads a template file with caching
 * @param {string} filePath - Path to template file
 * @returns {Promise<string>} - Template content
 */
export async function getTemplate(filePath) {
  if (templateCache.has(filePath)) {
    return templateCache.get(filePath);
  }
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    templateCache.set(filePath, content);
    return content;
  } catch (error) {
    logger.error("Files", `Error reading template file ${filePath}: ${error.message}`);
    throw error;
  }
}

/**
 * Reads multiple files in parallel and returns contents organized by file name
 * @param {string} basePath - Base directory path
 * @param {string[]} fileNames - Array of file names to read
 * @param {string} [extension='.txt'] - File extension
 * @returns {Promise<object>} - Object with fileNames as keys and content as values
 */
export async function readMultipleFiles(basePath, fileNames, extension = '.txt') {
  const fileContents = {};
  
  await Promise.all(
    fileNames.map(async (fileName) => {
      const filePath = path.join(basePath, `${fileName}${extension}`);
      try {
        fileContents[fileName] = await fs.readFile(filePath, "utf-8");
      } catch (error) {
        logger.log("Files", `Error reading file ${filePath}: ${error.message}`);
        fileContents[fileName] = ""; // Default empty string for missing files
      }
    })
  );
  
  return fileContents;
}

/**
 * Safely writes JSON data to a file with proper error handling
 * @param {string} filePath - Path to write the file
 * @param {object} data - Data to write
 * @param {object} [options] - Options for writing
 * @returns {Promise<boolean>} - Success indicator
 */
export async function safeWriteJSON(filePath, data, options = {}) {
  try {
    // Ensure directory exists
    await fs.ensureDir(path.dirname(filePath));
    
    // Write with custom options or defaults
    await fs.writeJSON(filePath, data, {
      spaces: 2,
      EOL: '\n',
      ...options
    });
    
    return true;
  } catch (error) {
    logger.error("Files", `Error writing JSON to ${filePath}: ${error.message}`);
    return false;
  }
}