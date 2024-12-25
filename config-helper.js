import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import levenshtein from "fast-levenshtein";
import { config } from "process";
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
  if (configCache) return configCache;  // Prevent loading if already loaded
  
  try {
    configCache = await fs.readJSON(configFilePath)
    await storeOriginalTypes(configCache)
    return configCache
  } catch (err) {
    configCache = {}
    return configCache;
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
      return parseFloat(value);
    case "boolean":
      return value === "true" || value === "1" || value === 1 || value === true;
    case "string":
      return value;
    default:
      return value;
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
    await saveConfigToDisk()
    await reloadConfig()
    return true;
  } catch (error) {
    return false;
  }
}

async function storeOriginalTypes(obj, parentKey = "") {
  for (const key in obj) {
    const value = obj[key];
    const fullPath = parentKey ? `${parentKey}.${key}` : key;

    if (typeof value === "object" && value !== null) {
      await storeOriginalTypes(value, fullPath);
    } else {
      originalConfigTypes[fullPath] = typeof value;
    }
  }
}

async function reloadConfig() {
  configCache = null;
  await loadConfig();
}


/**
 * Retrieves a value from the configuration using a dot notation path.
 * @param {string} path - The path to the desired value (e.g., "samplers.topK").
 * @returns {Promise<any>} - A promise that resolves to the value at the specified path, or undefined if not found.
 */
async function retrieveConfigValue(path) {
  await reloadConfig();
  const pathParts = path.split(".");
  let value = configCache;
  for (const part of pathParts) {
    if (value[part] === undefined) {
      return undefined; // Value not found
    }
    value = value[part];
  }
  if (typeof value === "object" && value !== null) {
    return value;
  }
  // Get the original type from the stored types
  const originalType = originalConfigTypes[path];

  // Convert the value to the original type if possible
  if (originalType) {
      try {
          return convertValueToOriginalType(value, originalType);
      } catch (error) {
          logger.log("Config", `Error converting config value to original type: ${error}`);
          return value;
      }
  } else {
      // If no original type is found, return the value as is
      return value;
  }
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
