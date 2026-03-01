/**
 * API helper utilities for Enspira
 * Handles user operations, weather fetching, fun facts, and auth validation
 * @module core/api-helper
 */

import fs from 'fs-extra';
import axios from 'axios';
import cron from 'node-cron';
import path from 'path';
import {
  connectToMongoDB,
  getUserById,
  getAllUsers,
  updateUserData,
  ensureUserPath,
  flushAllChanges,
} from './database.js';
import { retrieveConfigValue } from './config.js';
import { logger } from './logger.js';
import type {
  User,
  GeoLocationResponse,
  LocationData,
  WeatherResponse,
  AuthCheckResult,
} from '../types/index.js';

/** Cached auth keys (legacy, now using MongoDB) */
let cachedAuthKeys: User[] | null = null;

/** Auth file path from config */
const authFilePath = await retrieveConfigValue<string>('server.authFilePath');

/**
 * Loads API keys from MongoDB
 * Establishes connection and initializes the user cache
 */
export async function loadAPIKeys(): Promise<void> {
  try {
    const connected = await connectToMongoDB();

    if (!connected) {
      logger.error('API', 'Could not connect to MongoDB, using empty user list');
      cachedAuthKeys = [];
      return;
    }

    logger.log('API', 'MongoDB connection established');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('API', `Error initializing MongoDB: ${message}`);
    cachedAuthKeys = [];
  }
}

/**
 * Returns a copy of all users
 * @returns Array of user objects
 */
export async function returnAPIKeys(): Promise<User[]> {
  try {
    return await getAllUsers();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('API', `Error fetching all users: ${message}`);
    return [];
  }
}

/**
 * Returns the authentication object for a given user ID
 * @param userId - The ID of the user
 * @returns The user's auth object or null if not found
 */
export async function returnAuthObject(userId: string): Promise<User | null> {
  try {
    return await getUserById(userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('API', `Error fetching user ${userId}: ${message}`);
    return null;
  }
}

/**
 * Ensures a nested parameter path exists in the user object
 * @param userId - The user ID
 * @param parameterPath - The dot-notation path to ensure exists
 * @returns True if successful, false otherwise
 */
export async function ensureParameterPath(
  userId: string,
  parameterPath: string
): Promise<boolean> {
  try {
    return await ensureUserPath(userId, parameterPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('API', `Error ensuring parameter path: ${message}`);
    return false;
  }
}

/**
 * Updates a specific parameter for a user
 * @param userId - The ID of the user to update
 * @param parameter - Path to the parameter to update
 * @param newValue - The new value for the parameter
 * @returns True if successful, false otherwise
 */
export async function updateUserParameter(
  userId: string,
  parameter: string,
  newValue: unknown
): Promise<boolean> {
  try {
    return await updateUserData(userId, parameter, newValue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('API', `Error updating user parameter: ${message}`);
    return false;
  }
}

/**
 * Gets geolocation from IP and stores it for the user
 * @param ipAddr - The IP address to lookup
 * @param userId - The user ID to update
 * @returns Location data or false on failure
 */
async function getAndStoreLatLong(
  ipAddr: string,
  userId: string
): Promise<LocationData | false> {
  try {
    const response = await axios.get<GeoLocationResponse>(
      `http://ip-api.com/json/${ipAddr}?fields=status,message,country,regionName,lat,lon,timezone`
    );

    if (response.data.status === 'fail') {
      if (response.data.message === 'private range') {
        logger.log('API', 'Request from local network determined.');
        return false;
      } else if (response.data.message === 'reserved range') {
        logger.log('API', 'Request from the feds (???) determined.');
        return false;
      } else {
        logger.log('API', 'Bad request for IP information.');
        return false;
      }
    }

    const { lat, lon, timezone } = response.data;
    if (lat === undefined || lon === undefined || !timezone) {
      return false;
    }

    await updateUserParameter(userId, 'latitude', lat);
    await updateUserParameter(userId, 'longitude', lon);
    await updateUserParameter(userId, 'timeZone', timezone);

    return { latitude: lat, longitude: lon, timezone };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.log('API', `Error in getAndStoreLatLong: ${message}`);
    return false;
  }
}

/**
 * Saves all pending changes to MongoDB
 */
export async function saveAuthToDisk(): Promise<void> {
  try {
    await flushAllChanges();
    logger.log('API', 'All pending changes saved to MongoDB');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('API', `Error saving changes to MongoDB: ${message}`);
  }
}

/**
 * Generates a weather description string from conditions
 */
function generateWeatherDescription(current: WeatherResponse['current']): string {
  const tempF = parseInt(String(current.temperature_2m), 10);
  const cloudCover = parseInt(String(current.cloud_cover), 10);
  const rainAmt = parseFloat(String(current.rain));
  const snowAmt = parseFloat(String(current.snowfall));
  const windSpeed = parseFloat(String(current.wind_speed_10m));

  const cloudString =
    cloudCover === 0
      ? ' There are clear skies with no clouds in sight.'
      : cloudCover <= 20
        ? ' There are very few clouds in the sky.'
        : cloudCover <= 50
          ? ' There are a few clouds in the sky.'
          : cloudCover <= 75
            ? ' There are a lot of clouds in the sky.'
            : ' The sky is full of clouds.';

  const tempString =
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

  const rainString =
    rainAmt === 0
      ? ''
      : rainAmt <= 0.9
        ? " It's lightly rainy outside."
        : rainAmt <= 1.9
          ? " It's raining outside."
          : rainAmt <= 5
            ? " It's very rainy outside."
            : " It's extremely rainy outside, almost like a huge storm.";

  const snowString =
    snowAmt === 0
      ? ''
      : snowAmt <= 1
        ? ' There is a light snowfall outside.'
        : snowAmt <= 4
          ? ' There is a pleasant amount of snow outside.'
          : snowAmt <= 9.9
            ? ' There is quite a bit of snow outside.'
            : ' There is a whole lot of snow outside.';

  const windString =
    windSpeed === 0
      ? ''
      : windSpeed <= 9.9
        ? ` It is lightly windy outside at ${windSpeed.toFixed(0)} miles per hour.`
        : windSpeed <= 25.9
          ? ` It's fairly windy outside at ${windSpeed.toFixed(0)} miles per hour.`
          : windSpeed <= 49.9
            ? ` It's moderately windy outside at ${windSpeed.toFixed(0)} miles per hour.`
            : windSpeed <= 74.9
              ? ` It's severely windy outside at ${windSpeed.toFixed(0)} miles per hour.`
              : ` It is extremely windy outside, almost like a hurricane, at ${windSpeed.toFixed(0)} miles per hour.`;

  const timeOfDay = `It is currently ${current.is_day ? 'day time.' : 'night time.'}`;

  return `${timeOfDay}${tempString}${cloudString}${rainString}${snowString}${windString}`;
}

/**
 * Fetches weather for all users who have weather enabled
 */
async function fetchWeather(): Promise<void> {
  try {
    const users = await returnAPIKeys();

    for (const user of users) {
      if (!user.weather || !user.lastIp || user.lastIp === '') {
        continue;
      }

      let locData: LocationData | null = null;

      // Only call getAndStoreLatLong if latitude is not already set
      if (!user.latitude || user.latitude === '') {
        try {
          const result = await getAndStoreLatLong(user.lastIp, user.user_id);
          if (result === false) {
            continue;
          }
          locData = result;
        } catch (error) {
          logger.log('API', `Error getting or storing lat/long for user ${user.user_id}: ${error}`);
          continue;
        }
      } else {
        locData = {
          latitude: user.latitude,
          longitude: user.longitude ?? '',
          timezone: user.timeZone ?? 'UTC',
        };
      }

      if (!locData || !locData.latitude || !locData.longitude) {
        logger.log('API', `Missing or invalid location data for user ${user.user_id}.`);
        continue;
      }

      try {
        const url = new URL('https://api.open-meteo.com/v1/forecast');
        url.searchParams.append('latitude', String(locData.latitude));
        url.searchParams.append('longitude', String(locData.longitude));
        url.searchParams.append(
          'current',
          'temperature_2m,is_day,precipitation,rain,showers,snowfall,cloud_cover,wind_speed_10m'
        );
        url.searchParams.append('precipitation_unit', 'inch');
        url.searchParams.append('temperature_unit', 'fahrenheit');
        url.searchParams.append('wind_speed_unit', 'mph');
        url.searchParams.append('models', 'gfs_seamless');
        url.searchParams.append('timezone', String(locData.timezone));

        const response = await axios.get<WeatherResponse>(url.toString());

        if (response.status === 200) {
          const currWeather = generateWeatherDescription(response.data.current);

          const userDir = path.join('./world_info', user.user_id);
          if (!fs.existsSync(userDir)) {
            await fs.promises.mkdir(userDir, { recursive: true });
          }
          await fs.promises.writeFile(path.join(userDir, 'weather.txt'), currWeather);
        } else {
          logger.log('API', `Failed to fetch weather for ${user.user_id}.`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.log('API', `Error fetching weather for ${user.user_id}: ${message}`, 'error');
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.log('API', `Error reading user data: ${message}`);
  }
}

/**
 * Checks for authentication using a provided token
 * @param token - The authentication token
 * @returns Object indicating validity and user details
 */
export async function checkForAuth(token: string): Promise<AuthCheckResult> {
  const allTokens = await returnAPIKeys();
  if (!allTokens || allTokens.length === 0) {
    return { valid: false };
  }

  const validObject = allTokens.find((object) => token.trim() === object.api_token);
  return validObject ? { valid: true, ...validObject } : { valid: false };
}

// ============================================
// Fun Facts APIs
// ============================================

/**
 * Gets a random fact from Black History API
 */
async function blackRandomFact(): Promise<string | undefined> {
  try {
    const apiKey = await retrieveConfigValue<string>('funFacts.key');
    const response = await axios.get<{ Results: Array<{ text: string }> }>(
      'https://rest.blackhistoryapi.io/fact/random',
      { headers: { 'x-api-key': apiKey } }
    );
    return response.data.Results[0]?.text;
  } catch (err) {
    logger.log('System', 'Unable to get random fact from BlackHistoryAPI');
    return undefined;
  }
}

/**
 * Gets a random cat fact from MeowFacts
 */
async function randomCatFact(): Promise<string | undefined> {
  try {
    const response = await axios.get<{ data: string[] }>('https://meowfacts.herokuapp.com/');
    return response.data.data[0];
  } catch (err) {
    logger.log('System', 'Unable to get random fact from MeowFacts');
    return undefined;
  }
}

/**
 * Gets a random useless fact
 */
async function randomUselessFact(): Promise<string | undefined> {
  try {
    const response = await axios.get<{ text: string }>(
      'https://uselessfacts.jsph.pl/api/v2/facts/random?language=en'
    );
    return response.data.text;
  } catch (err) {
    logger.log('System', 'Unable to get random fact from UselessFacts');
    return undefined;
  }
}

/**
 * Gets a random dog fact
 */
async function randomDogFact(): Promise<string | undefined> {
  try {
    const response = await axios.get<{ facts: string[] }>(
      'http://dog-api.kinduff.com/api/facts?number=1'
    );
    return response.data.facts[0];
  } catch (err) {
    logger.log('System', 'Unable to get random fact from DogApi');
    return undefined;
  }
}

/**
 * Gets a random number fact
 */
async function randomNumbersFact(): Promise<string | undefined> {
  try {
    const response = await axios.get<{ text: string }>('http://numbersapi.com/random?json');
    return response.data.text;
  } catch (err) {
    logger.log('System', 'Unable to get random fact from NumbersApi');
    return undefined;
  }
}

/**
 * Gets a random fun fact from various APIs
 * @returns A random fun fact string
 */
export async function funFact(): Promise<string> {
  const pickOne = Math.floor(Math.random() * 5) + 1;

  switch (pickOne) {
    case 1:
      logger.log('API', 'Pulled fact from Black History API.');
      return (await blackRandomFact()) ?? getDefaultFunFactMessage();
    case 2:
      logger.log('API', 'Pulled fact from MeowFacts.');
      return (await randomCatFact()) ?? getDefaultFunFactMessage();
    case 3:
      logger.log('API', 'Pulled fact from Numbers API.');
      return (await randomNumbersFact()) ?? getDefaultFunFactMessage();
    case 4:
      logger.log('API', 'Pulled fact from Kinduff.');
      return (await randomDogFact()) ?? getDefaultFunFactMessage();
    case 5:
      logger.log('API', 'Pulled fact from UselessFacts.');
      return (await randomUselessFact()) ?? getDefaultFunFactMessage();
    default:
      return getDefaultFunFactMessage();
  }
}

/**
 * Default message when fun fact APIs fail
 */
function getDefaultFunFactMessage(): string {
  return 'One of the websites decided to take a break. Instead of sharing a provided fun fact from one of these sites, talk about your favorite safe-for-work and stream-appropriate fact about your favorite person.';
}

/**
 * Initializes all API services including weather cron job
 */
export async function initAllAPIs(): Promise<void> {
  await fetchWeather();
  cron.schedule('*/10 * * * *', async () => {
    await fetchWeather();
  });
}

// Signal handlers for graceful shutdown
process.on('SIGTERM', async () => {
  await flushAllChanges();
});

process.on('SIGINT', async () => {
  await flushAllChanges();
});

export default {
  initAllAPIs,
  funFact,
  returnAuthObject,
  checkForAuth,
  loadAPIKeys,
  returnAPIKeys,
  saveAuthToDisk,
  updateUserParameter,
  ensureParameterPath,
};
