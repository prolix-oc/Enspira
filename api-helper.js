import fs from "fs-extra";
import axios from "axios";
import cron from "node-cron";
import * as crypto from "crypto";
import path from "path";
import { retrieveConfigValue } from "./config-helper.js";
let cachedAuthKeys = null;
const authFilePath = await retrieveConfigValue("server.authFilePath");

/**
 * Loads API keys from the auth_keys.json file into the cache.
 * If the file does not exist and AUTH_REQ is true, it generates a new auth file.
 * @returns {Promise<void>}
 */
async function loadAPIKeys() {
  // authFilePath declared outside of async function to reference in saveAuthToDisk
  try {
    if (fs.existsSync(authFilePath)) {
      logger.log("API", "Loading allowed users from disk.");
      cachedAuthKeys = await fs.readJSON(authFilePath);
      await updateEmptyTokens();
    } else {
      if ((await retrieveConfigValue("server.authRequired")) === "true") {
        logger.log("API", "No authfile found, generating one.");
        cachedAuthKeys = [];
        await fs.outputJSON(authFilePath, cachedAuthKeys, { spaces: 2 });
        logger.log("API", "Auth file successfully created!");
      } else {
        cachedAuthKeys = [];
      }
    }
  } catch (err) {
    logger.log("API", `Error handling auth file: ${err}`);
    cachedAuthKeys = [];
  }
}

/**
 * Returns a copy of the cached API keys.
 * @returns {Promise<object[]>} A promise that resolves to an array of API key objects.
 */
const returnAPIKeys = async () => {
  if (!cachedAuthKeys) {
    await loadAPIKeys();
  }
  return [...cachedAuthKeys];
};

/**
 * Returns the authentication object for a given user ID.
 * @param {string} userId - The ID of the user.
 * @returns {Promise<object|null>} A promise that resolves to the user's auth object or null if not found.
 */
const returnAuthObject = async (userId) => {
  if (!cachedAuthKeys) {
    await loadAPIKeys(); // Ensure keys are loaded
  }
  return cachedAuthKeys.find((object) => object.user_id === userId) || null;
};

/**
 * Updates empty API tokens in the cached auth keys and writes the changes back to the file.
 * @returns {Promise<void>}
 */
async function updateEmptyTokens() {
  let updated = false;
  for (const object of cachedAuthKeys) {
    if (!object.api_token) {
      object.api_token = crypto.randomBytes(24).toString("hex");
      updated = true;
      logger.log(
        "System",
        `Updated API key for API user ${object.display_name}`,
      );
    }
  }
  if (updated) {
    try {
      await fs.outputJSON(authFilePath, cachedAuthKeys, { spaces: 2 });
    } catch (err) {
      logger.log("System", `Error updating auth file on local disk: ${err}`);
    }
  }
}

/**
 * Ensures a nested parameter path exists in the user object
 * @param {string} userId - The user ID
 * @param {string} parameterPath - The dot-notation path to ensure exists
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
export async function ensureParameterPath(userId, parameterPath) {
  try {
    // Get the user object
    const user = await returnAuthObject(userId);
    if (!user) {
      logger.error("API", `User not found: ${userId}`);
      return false;
    }

    // Split the path into segments
    const pathParts = parameterPath.split(".");

    // Start with the user object
    let currentPath = "";
    let current = user;

    // For each path segment
    for (let i = 0; i < pathParts.length; i++) {
      const part = pathParts[i];

      // Update the current path for logging
      currentPath = currentPath ? `${currentPath}.${part}` : part;

      // If we're at the last segment, we don't need to create anything
      // We just verify it exists or will be created by the caller
      if (i === pathParts.length - 1) {
        break;
      }

      // If this segment doesn't exist in the user object
      if (current[part] === undefined) {
        logger.log("API", `Creating missing path segment: ${currentPath}`);

        // Create a temporary clone of the user object to work with
        const userClone = JSON.parse(JSON.stringify(user));

        // Navigate to the right position in the clone
        let pointer = userClone;
        for (let j = 0; j < i; j++) {
          pointer = pointer[pathParts[j]];
        }

        // Add the missing object
        pointer[part] = {};

        // Update the whole user object with this change
        const updated = await updateUserParameter(userId, "", userClone);
        if (!updated) {
          logger.error("API", `Failed to update user with new path segment: ${currentPath}`);
          return false;
        }

        // Get a fresh copy of the user object
        const updatedUser = await returnAuthObject(userId);
        if (!updatedUser) {
          logger.error("API", `Failed to reload user after path update: ${userId}`);
          return false;
        }

        // Update our working variables
        current = updatedUser;
        for (let j = 0; j <= i; j++) {
          if (current[pathParts[j]] === undefined) {
            logger.error("API", `Path segment still missing after update: ${pathParts.slice(0, j + 1).join('.')}`);
            return false;
          }
          current = current[pathParts[j]];
        }
      } else {
        // This segment exists, just advance to it
        current = current[part];
      }

      // Verify the current position is an object
      if (typeof current !== "object" || current === null) {
        logger.error("API", `Path segment is not an object: ${currentPath}`);
        return false;
      }
    }

    return true;
  } catch (error) {
    logger.error("API", `Error ensuring parameter path ${parameterPath}: ${error.message}`);
    return false;
  }
}


/**
 * Updates a specific parameter for a user in the cached auth keys and saves the changes to disk.
 *
 * @param {string} userId - The ID of the user to update.
 * @param {string} parameter - The name of the parameter to update (e.g., "player_name", "bot_name", "twitch_name").
 * @param {any} newValue - The new value for the parameter.
 * @returns {Promise<boolean>} - True if the update was successful, false otherwise.
 */
/**
 * Updates a user parameter directly in the cached auth data and on disk
 * @param {string} userId - The user ID
 * @param {string} parameter - The parameter to update (empty string for entire user object)
 * @param {any} newValue - The new value
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
async function updateUserParameter(userId, parameter, newValue) {
  try {
    if (!cachedAuthKeys) {
      await loadAPIKeys();
    }

    const userIndex = cachedAuthKeys.findIndex((user) => user.user_id === userId);
    if (userIndex === -1) {
      logger.error("API", `User not found: ${userId}`);
      return false;
    }

    // If parameter is empty, replace the entire user object
    if (!parameter) {
      cachedAuthKeys[userIndex] = newValue;
      await saveAuthToDisk();
      return true;
    }

    // Otherwise, navigate to and update the specified parameter
    const pathParts = parameter.split(".");
    let current = cachedAuthKeys[userIndex];

    // Navigate to the container object
    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];

      if (current[part] === undefined) {
        // Create missing intermediate objects
        current[part] = {};
      } else if (typeof current[part] !== "object" || current[part] === null) {
        logger.error("API", `Cannot update parameter: ${pathParts.slice(0, i + 1).join('.')} is not an object`);
        return false;
      }

      current = current[part];
    }

    // Update the value
    const lastPart = pathParts[pathParts.length - 1];
    current[lastPart] = newValue;

    // Save changes to disk
    await saveAuthToDisk();
    logger.log("API", `Updated parameter '${parameter}' for user ${userId}`);
    return true;
  } catch (error) {
    logger.error("API", `Error updating user parameter: ${error.message}`);
    return false;
  }
}

async function getAndStoreLatLong(ipAddr, userId) {
  try {
    const response = await axios.get(
      new URL(
        `http://ip-api.com/json/${ipAddr}?fields=status,message,country,regionName,lat,lon,timezone`,
      ),
    );
    if (response.data.status === "fail") {
      if (response.data.message === "private range") {
        logger.log("API", "Request from local network determined.");
        return false;
      } else if (response.data.message === "reserved range") {
        logger.log("API", "Request from the feds (???) determined.");
        return false;
      } else {
        logger.log("API", "Bad request for IP information.");
        return false;
      }
    } else {
      const { lat, lon, timezone } = response.data; // FIXED: Changed request.data to response.data
      await updateUserParameter(userId, "latitude", lat);
      await updateUserParameter(userId, "longitude", lon);
      await updateUserParameter(userId, "timeZone", timezone);
      return { latitude: lat, longitude: lon, timezone: timezone };
    }
  } catch (error) {
    logger.log("API", `Error in getAndStoreLatLong: ${error.message}`);
    return false;
  }
}

/**
 * Saves the current cached auth keys to disk.
 * @returns {Promise<void>}
 */
async function saveAuthToDisk() {
  try {
    if (cachedAuthKeys) {
      await fs.outputJSON(authFilePath, cachedAuthKeys, { spaces: 2 });
      logger.log("API", "Successfully saved auth keys to disk.");
    } else {
      logger.log("API", "No auth keys to save.");
    }
  } catch (error) {
    logger.log("API", `Error saving auth keys to disk: ${error}`);
  }
}

async function fetchWeather() {
  try {
    const users = await returnAPIKeys();

    for (const user of users) {
      if (!user.weather || !user.lastIp || user.lastIp === "") {
        continue; // Skip users without weather or IP
      }

      let locData = null;

      // Only call getAndStoreLatLong if latitude is not already set
      if (!user.latitude || user.latitude === "") {
        try {
          locData = await getAndStoreLatLong(user.lastIp, user.user_id);
        } catch (error) {
          logger.log(
            "API",
            `Error getting or storing lat/long for user ${user.user_id}: ${error}`,
          );
          continue; // Skip to the next user on error
        }
      } else {
        // Use existing latitude and longitude if available
        locData = {
          latitude: user.latitude,
          longitude: user.longitude,
          timezone: user.timeZone,
        };
      }

      // Ensure locData is valid before proceeding
      if (!locData || !locData.latitude || !locData.longitude) {
        logger.log(
          "API",
          `Missing or invalid location data for user ${user.user_id}.`,
        );
        continue; // Skip to the next user
      }

      try {
        const url = new URL(`https://api.open-meteo.com/v1/forecast`);
        url.searchParams.append("latitude", locData.latitude);
        url.searchParams.append("longitude", locData.longitude);
        url.searchParams.append(
          "current",
          "temperature_2m,is_day,precipitation,rain,showers,snowfall,cloud_cover,wind_speed_10m",
        );
        url.searchParams.append("precipitation_unit", "inch");
        url.searchParams.append("temperature_unit", "fahrenheit");
        url.searchParams.append("wind_speed_unit", "mph");
        url.searchParams.append("models", "gfs_seamless");
        url.searchParams.append("timezone", locData.timezone);

        const response = await axios.get(url.toString());

        if (response.status === 200) {
          const current = response.data.current;
          const tempF = parseInt(current["temperature_2m"]).toFixed(0);
          const cloudCover = parseInt(current["cloud_cover"]);
          const rainAmt = current["rain"].toFixed(1);
          const snowAmt = current["snowfall"].toFixed(1);
          const windSpeed = current["wind_speed_10m"].toFixed(0);

          let rainString = "";
          let cloudString = "";
          let tempString = "";
          let snowString = "";
          let windString = "";

          cloudString =
            cloudCover === 0
              ? " There are clear skies with no clouds in sight."
              : cloudCover <= 20
                ? " There are very few clouds in the sky."
                : cloudCover <= 50
                  ? " There are a few clouds in the sky."
                  : cloudCover <= 75
                    ? " There are a lot of clouds in the sky."
                    : " The sky is full of clouds.";

          tempString =
            tempF <= 0
              ? ` It's way below freezing at ${tempF} degrees.`
              : tempF <= 31.9
                ? ` It's below freezing at ${tempF} degrees.`
                : tempF <= 59.9
                  ? ` It's quite chilly at ${tempF} degrees.`
                  : tempF <= 78.9
                    ? ` It's quite cozy outside at ${tempF} degrees.`
                    : tempF <= 94.9
                      ? ` It's pretty warm outside at ${tempF} degrees.`
                      : ` It's quite hot outside at ${tempF} degrees.`;

          rainString =
            rainAmt == 0
              ? ""
              : rainAmt <= 0.9
                ? " It's lightly rainy outside."
                : rainAmt <= 1.9
                  ? " It's raining outside."
                  : rainAmt <= 5
                    ? " It's very rainy outside."
                    : " It's extremely rainy outside, almost like a huge storm.";

          snowString =
            snowAmt == 0
              ? ""
              : snowAmt <= 1
                ? " There is a light snowfall outside."
                : snowAmt <= 4
                  ? " There is a pleasant amount of snow outside."
                  : snowAmt <= 9.9
                    ? " There is quite a bit of snow outside."
                    : " There is a whole lot of snow outside.";

          windString =
            windSpeed == 0
              ? ""
              : windSpeed <= 9.9
                ? ` It is lightly windy outside at ${windSpeed} miles per hour.`
                : windSpeed <= 25.9
                  ? ` It's fairly windy outside at ${windSpeed} miles per hour.`
                  : windSpeed <= 49.9
                    ? ` It's moderately windy outside at ${windSpeed} miles per hour.`
                    : windSpeed <= 74.9
                      ? ` It's severely windy outside at ${windSpeed} miles per hour.`
                      : ` It is extremely windy outside, almost like a hurricane, at ${windSpeed} miles per hour.`;

          const timeOfDay = `It is currently ${current["is_day"] ? "day time." : "night time."
            }`;
          const currWeather = `${timeOfDay}${tempString}${cloudString}${rainString}${snowString}${windString}`;

          const userDir = path.join("./world_info", user.user_id);
          if (!fs.existsSync(userDir)) {
            await fs.promises.mkdir(userDir, { recursive: true });
          }
          await fs.promises.writeFile(
            path.join(userDir, "weather.txt"),
            currWeather,
          );
        } else {
          logger.log("API", `Failed to fetch weather for ${user.user_id}.`);
        }
      } catch (error) {
        logger.log(
          "API",
          `Error fetching weather for ${user.user_id}: ${error.message}`,
          "err"
        );
      }
    }
  } catch (error) {
    logger.log("API", `Error reading user data: ${error.message}`);
  }
}

/**
 * Checks for authentication using a provided token.
 * @param {string} token - The authentication token.
 * @returns {Promise<object>} A promise that resolves to an object indicating validity and user details.
 */
async function checkForAuth(token) {
  const allTokens = await returnAPIKeys();
  if (!allTokens || allTokens.length === 0) {
    return { valid: false };
  }

  const validObject = allTokens.find(
    (object) => token.trim() === object.api_token,
  );
  return validObject ? { valid: true, ...validObject } : { valid: false };
}

const funFact = async () => {
  const pickOne = Math.floor(Math.random() * 5) + 1
  switch (pickOne) {
    case 1:
      logger.log("API", "Pulled fact from Black History API.")
      return await blackRandomFact()
    case 2:
      logger.log("API", "Pulled fact from MeowFacts.")
      return await randomCatFact()
    case 3:
      logger.log("API", "Pulled fact from Numbers API.")
      return await randomNumbersFact()
    case 4:
      logger.log("API", "Pulled fact from Kinduff.")
      return await randomDogFact()
    case 5:
      logger.log("API", "Pulled fact from UselessFacts.")
      return await randomUselessFact()
    default:
      return "One of the websites decided to take a break. Instead of sharing a provided fun fact from one of these sites, talk about your favorite safe-for-work and stream-appropriate fact about your favorite person."
  }
};

const blackRandomFact = async () => {
  try {
    const response = await axios.get(
      "https://rest.blackhistoryapi.io/fact/random", { headers: { "x-api-key": await retrieveConfigValue("funFacts.key") } }
    );
    return response.data.Results[0].text;
  } catch (err) {
    logger.log("System", "Unable to get random fact from BlackHistoryAPI")
  }

};

const randomCatFact = async () => {
  try {
    const response = await axios.get(
      "https://meowfacts.herokuapp.com/"
    );
    return response.data.data[0];
  } catch (err) {
    logger.log("System", "Unable to get random fact from UselessFacts")
  }
};

const randomUselessFact = async () => {
  try {
    const response = await axios.get(
      "https://uselessfacts.jsph.pl/api/v2/facts/random?language=en"
    );
    return response.data.text;
  } catch (err) {
    logger.log("System", "Unable to get random fact from MeowFacts")
  }
}

const randomDogFact = async () => {
  try {
    const response = await axios.get(
      "http://dog-api.kinduff.com/api/facts?number=1"
    );
    return response.data.facts[0];
  } catch (err) {
    logger.log("System", "Unable to get random fact from DogApi")
  }
};

const randomNumbersFact = async () => {
  try {
    const response = await axios.get(
      "http://numbersapi.com/random?json",
    );
    return response.data.text
  } catch (err) {
    logger.log("System", "Unable to get random fact from NumbersApi")
  }

}

async function initAllAPIs() {
  await fetchWeather();
  cron.schedule("*/10 * * * *", async () => {
    await fetchWeather();
  });
}

export {
  initAllAPIs,
  funFact,
  returnAuthObject,
  checkForAuth,
  loadAPIKeys,
  returnAPIKeys,
  saveAuthToDisk,
  updateUserParameter,
};
