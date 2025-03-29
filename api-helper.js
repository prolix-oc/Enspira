import fs from "fs-extra";
import axios from "axios";
import cron from "node-cron";
import * as crypto from "crypto";
import path from "path";
import { 
  connectToMongoDB, 
  getUserById, 
  getAllUsers, 
  updateUserData,
  ensureUserPath,
  flushAllChanges
} from './mongodb-client.js';
import { retrieveConfigValue } from "./config-helper.js";
import { logger } from './create-global-logger.js';
let cachedAuthKeys = null;

const authFilePath = await retrieveConfigValue("server.authFilePath");

/**
 * Loads API keys from MongoDB
 * @returns {Promise<void>}
 */
async function loadAPIKeys() {
  try {
    // Connect to MongoDB
    const connected = await connectToMongoDB();
    
    if (!connected) {
      logger.error("API", "Could not connect to MongoDB, using empty user list");
      cachedAuthKeys = [];
      return;
    }
    
    // No need to cache here as getUserById handles caching
    logger.log("API", "MongoDB connection established");
  } catch (err) {
    logger.error("API", `Error initializing MongoDB: ${err.message}`);
    cachedAuthKeys = [];
  }
}

/**
 * Returns a copy of all users
 * @returns {Promise<object[]>} A promise that resolves to an array of user objects
 */
const returnAPIKeys = async () => {
  try {
    return await getAllUsers();
  } catch (error) {
    logger.error("API", `Error fetching all users: ${error.message}`);
    return [];
  }
};

/**
 * Returns the authentication object for a given user ID
 * @param {string} userId - The ID of the user
 * @returns {Promise<object|null>} A promise that resolves to the user's auth object or null if not found
 */
const returnAuthObject = async (userId) => {
  try {
    return await getUserById(userId);
  } catch (error) {
    logger.error("API", `Error fetching user ${userId}: ${error.message}`);
    return null;
  }
};

/**
 * Ensures a nested parameter path exists in the user object
 * @param {string} userId - The user ID
 * @param {string} parameterPath - The dot-notation path to ensure exists
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
export async function ensureParameterPath(userId, parameterPath) {
  try {
    return await ensureUserPath(userId, parameterPath);
  } catch (error) {
    logger.error("API", `Error ensuring parameter path: ${error.message}`);
    return false;
  }
}

/**
 * Updates a specific parameter for a user
 * @param {string} userId - The ID of the user to update
 * @param {string} parameter - Path to the parameter to update
 * @param {any} newValue - The new value for the parameter
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
async function updateUserParameter(userId, parameter, newValue) {
  try {
    return await updateUserData(userId, parameter, newValue);
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
 * Saves all pending changes to disk
 * @returns {Promise<void>}
 */
async function saveAuthToDisk() {
  try {
    await flushAllChanges();
    logger.log("API", "All pending changes saved to MongoDB");
  } catch (error) {
    logger.error("API", `Error saving changes to MongoDB: ${error.message}`);
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

process.on('SIGTERM', async () => {
  await flushAllChanges();
});

process.on('SIGINT', async () => {
  await flushAllChanges();
});

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
