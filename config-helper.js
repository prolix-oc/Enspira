import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const configFilePath = path.join(__dirname, "./config/config.json");
let configCache = null;
let originalConfigTypes = {}; // Store original data types

/**
 * Loads the configuration file into memory.
 * @returns {Promise<void>}
 */
async function loadConfig() {
  try {
    configCache = await fs.readJSON(configFilePath);
    storeOriginalTypes(configCache); // Store original types on load
    return true
  } catch (error) {
    configCache = {}; // Initialize with an empty object on error
    return false
  }
}

/**
 * Converts a string value to the original type.
 * @param {string} value - The user input value as a string.
 * @param {string} originalType - The expected type (e.g., "number", "boolean").
 * @returns {any} - The converted value.
 */
function convertValueToOriginalType(value, originalType) {
  switch (originalType) {
    case "number":
      if (!isNaN(value)) {
        return parseFloat(value);
      }
      throw new TypeError(`Invalid number format: ${value}`);
    case "boolean":
      if (value.toLowerCase() === "true") {
        return true;
      }
      if (value.toLowerCase() === "false") {
        return false;
      }
      throw new TypeError(`Invalid boolean format: ${value}`);
    case "string":
      return value;
    default:
      throw new TypeError(`Unsupported type conversion: ${originalType}`);
  }
}

function findClosestKey(inputPath, config, threshold = 2) {
  const keys = extractAllPaths(config); // Get all paths from the config
  const lowerInputPath = inputPath.toLowerCase();

  const exactMatch = keys.find(key => key.toLowerCase() === lowerInputPath);
  if (exactMatch) return exactMatch;

  const closestMatch = keys.reduce(
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

function extractAllPaths(obj, parentKey = "") {
  let paths = [];
  for (const key in obj) {
    const fullPath = parentKey ? `${parentKey}.${key}` : key;
    if (typeof obj[key] === "object" && obj[key] !== null) {
      paths = paths.concat(extractAllPaths(obj[key], fullPath));
    } else {
      paths.push(fullPath);
    }
  }
  return paths;
}

/**
 * Saves a value to the configuration and writes it to disk.
 * @param {string} path - The path to the value to save (e.g., "samplers.topK").
 * @param {string} userInput - The user-provided value as a string.
 * @returns {Promise<boolean>} - A promise that resolves to true if successful, false otherwise.
 */
async function saveConfigValue(path, userInput) {
  if (!configCache) {
    await loadConfig();
  }

  const inferredPath = findClosestKey(path, configCache);
  if (!inferredPath) {
    return false;
  }

  const pathParts = inferredPath.split(".");
  let obj = configCache;
  for (let i = 0; i < pathParts.length - 1; i++) {
    const part = pathParts[i];
    if (!obj[part] || typeof obj[part] !== "object") {
      obj[part] = {};
    }
    obj = obj[part];
  }

  const key = pathParts[pathParts.length - 1];
  const originalType = originalConfigTypes[inferredPath];

  if (!originalType) {
    throw new Error(`Unknown configuration path: ${inferredPath}`);
  }

  let convertedValue;
  try {
    convertedValue = convertValueToOriginalType(userInput, originalType);
  } catch (error) {
    return false;
  }

  obj[key] = convertedValue;

  try {
    await saveConfigToDisk();
    return true;
  } catch (error) {
    return false;
  }
}
function storeOriginalTypes(obj, parentKey = "") {
  for (const key in obj) {
    const value = obj[key];
    const fullPath = parentKey ? `${parentKey}.${key}` : key;

    if (typeof value === "object" && value !== null) {
      storeOriginalTypes(value, fullPath);
    } else {
      originalConfigTypes[fullPath] = typeof value;
    }
  }
}

/**
 * Retrieves a value from the configuration using a dot notation path.
 * @param {string} path - The path to the desired value (e.g., "samplers.topK").
 * @returns {any} - The value at the specified path, or undefined if not found.
 */
/**
 * Retrieves a value from the configuration using a dot notation path.
 * @param {string} path - The path to the desired value (e.g., "samplers.topK").
 * @returns {Promise<any>} - A promise that resolves to the value at the specified path, or undefined if not found.
 */
async function retrieveConfigValue(path) {
  if (!configCache) {
    await loadConfig(); // Ensure keys are loaded and types are stored
  }

  const pathParts = path.split(".");
  let value = configCache;
  for (const part of pathParts) {
    if (value[part] === undefined) {
      return undefined;
    }
    value = value[part];
  }
  return value;
}

/**
 * Writes the current configuration to disk.
 * @returns {Promise<void>}
 */
async function saveConfigToDisk() {
  try {
    if (configCache) {
      await fs.writeJSON(configFilePath, configCache, { spaces: 2 });
    } else {
    }
  } catch (error) {
  }
}

export { loadConfig, retrieveConfigValue, saveConfigToDisk, saveConfigValue };
