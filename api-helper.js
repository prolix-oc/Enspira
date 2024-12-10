import fs from 'fs-extra'
import axios from 'axios';
import cron from 'node-cron'
import * as crypto from 'crypto'
var authTokens = [];


async function loadAPIKeys() {
    if (fs.existsSync('./auth/auth_keys.json')) {
        logger.log('API', "Loaded allowed users from disk.")
        authTokens = JSON.parse(fs.readFileSync('./auth/auth_keys.json', 'utf8'));
        await updateEmptyTokens();
    } else {
        if (process.env.AUTH_REQ == true) {
            logger.log('API', "No authfile found, generating one.")
            fs.writeFileSync("./auth/auth_keys.json", JSON.stringify(authTokens, null, '  '), (err) => {
                if (err)
                    logger.log('API', `Error creating auth file on local disk: ${err}`)
                else {
                    logger.log('API', "Auth file successfully created!")
                }
            });
        }
    }
}

const returnAPIKeys = async() => {
    const tokens = JSON.parse(fs.readFileSync('./auth/auth_keys.json', 'utf8'));
    return tokens
}

const returnAuthObject = async(userId) => {
    for await (const object of authTokens) {
        if (object.user_id === userId) {
            return object
        }
    }
}

async function updateEmptyTokens() {
    for await (const object of authTokens) {
        if (object.api_token === "" && object.role === "ADMIN") {
            object.api_token = crypto.randomBytes(24).toString('hex');
            fs.writeFileSync("./auth/auth_keys.json", JSON.stringify(authTokens, null, '  '), (err) => {
                if (err)
                    logger.log('System', `Error updating auth file on local disk:${err}`)
                else {
                    logger.log('System', `Updated API key for API user ${object.display_name}`)
                }
            });
        }
        if (object.api_token === "" && object.role === "USER") {
            object.api_token = crypto.randomBytes(24).toString('hex');
            fs.writeFileSync("./auth/auth_keys.json", JSON.stringify(authTokens, null, '  '), (err) => {
                if (err)
                    logger.log('System', `Error updating auth file on local disk:${err}`)
                else {
                    logger.log('System', `Updated API key for API user ${object.display_name}`)
                }
            });
        }
    }
}

async function fetchWeather() {
    const response = await axios.get(`https://api.open-meteo.com/v1/forecast?latitude=${process.env.WEATHER_LAT}&longitude=${process.env.WEATHER_LONG}&current=temperature_2m,is_day,precipitation,rain,showers,snowfall,cloud_cover,wind_speed_10m&precipitation_unit=inch&temperature_unit=fahrenheit&wind_speed_unit=mph&models=gfs_seamless&timezone=America/New_York`);
    if (response.status == 200) {
        var tempF = parseInt(response.data.current['temperature_2m']).toFixed(0)
        const cloudCover = parseInt(response.data.current['cloud_cover'])
        const rainAmt = response.data.current['rain'].toFixed(1);
        const snowAmt = response.data.current['snowfall'].toFixed(1);
        const windSpeed = response.data.current['wind_speed_10m'].toFixed(0);
        var rainString = ""
        var cloudString = ""
        var tempString = ""
        var snowString = ""
        var windString = ""

        if (cloudCover == 0) {
            cloudString = " There are clear skies with no clouds in sight."
        } else if (cloudCover >= 1 && cloudCover <= 20) {
            cloudString = " There are very few clouds in the sky."
        } else if (cloudCover >= 21 && cloudCover <= 50) {
            cloudString = " There are a few clouds in the sky."
        } else if (cloudCover >= 51 && cloudCover <= 75) {
            cloudString = " There are a lot of clouds in the sky."
        } else if (cloudCover >= 76) {
            cloudString = " The sky is full of clouds."
        }
        if (tempF <= 0) {
            tempString = ` It's way below freezing at ${tempF} degrees.`
        } else if (tempF >= 1 && tempF <= 31.9) {
            tempString = ` It's below freezing at ${tempF} degrees.`
        } else if (tempF >= 32 && tempF <= 59.9) {
            tempString = ` It's quite chilly at ${tempF} degrees.`
        } else if (tempF >= 60 && tempF <= 78.9) {
            tempString = ` It's quite cozy outside at ${tempF} degrees.`
        } else if (tempF >= 79 && tempF <= 94.9) {
            tempString = ` It's pretty warm outside at ${tempF} degrees.`
        } else if (tempF >= 95) {
            tempString = ` It's quite hot outside at ${tempF} degrees.`
        }
        if (rainAmt == 0) {
            rainString = ""
        } else if (rainAmt >= 0.1 && rainAmt <= 0.9) {
            rainString = " It's lightly rainy outside."
        } else if (rainAmt >= 1 && rainAmt <= 1.9) {
            rainString = " It's raining outside."
        } else if (rainAmt >= 2 && rainAmt <= 5) {
            rainString = " It's very rainy outside."
        } else if (rainAmt >= 5.1) {
            rainString = " It's extremely rainy outside, almost like a huge storm."
        }

        if (snowAmt == 0) {
            snowString = ""
        } else if (snowAmt >= 0.1 && snowAmt <= 1) {
            snowString = " There is a light snowfall outside."
        } else if (snowAmt >= 1.1 && snowAmt <= 4) {
            snowString = " There is a pleasant amount of snow outside."
        } else if (snowAmt >= 4.1 && snowAmt <= 9.9) {
            snowString = " There is quite a bit of snow outside."
        } else if (snowAmt >= 10) {
            snowString = " There is a whole lot of snow outside."
        }

        if (windSpeed == 0) {
            windString = ""
        } else if (windSpeed >= 1 && windSpeed <= 9.9) {
            windString = ` It is lightly windy outside at ${windSpeed} miles per hour.`
        } else if (windSpeed >= 10 && windSpeed <= 25.9) {
            windString = ` It's fairly windy outside at ${windSpeed} miles per hour.`
        } else if (windSpeed >= 26 && windSpeed <= 49.9) {
            windString = ` It's moderately windy outside at ${windSpeed} miles per hour.`
        } else if (windSpeed >= 50 && windSpeed <= 74.9) {
            windString = ` It's severely windy outside at ${windSpeed} miles per hour.`
        } else if (windSpeed >= 75) {
            windString = ` It is extremely windy outside, almost like a hurricane, at ${windSpeed} miles per hour.`
        }

        const timeOfDay = `It is currently ${response.data.current['is_day'] ? "day time." : "night time."}`
        const currWeather = `## Current Weather:\nHere are the current weather conditions for where you and ${process.env.USER_NAME} live. Do not repeat any weather conditions verbatim.:\n${timeOfDay}${tempString}${cloudString}${rainString}${snowString}${windString}`
        fs.writeFileSync('./world_info/weather.txt', currWeather)
        logger.log('API', `Fetched current weather statistics. Repeating in 10 minutes.`)
    } else {
        logger.log('API', 'Unable to fetch weather statistics.')
    }
}

async function checkForAuth(token) {
    const allTokens = await returnAPIKeys()
    var validObject = {}
    for await (const object of allTokens) {
        if (token.trim() === object.api_token) {
            logger.log('API', `Valid token!`)
            validObject = object;
        }
    }
    if (validObject == {}) {
        return { valid: false } 
    } else {
        return validObject
    }
}

const funFact = async () => {
    const response = await axios.get('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en');
    return response.data.text
}

async function initAllAPIs() {
    if (process.env.WEATHER_ENABLED) {
        cron.schedule("*/10 * * * *", async () => {
            await fetchWeather()
        })
    }

}

export { initAllAPIs, funFact, returnAuthObject, checkForAuth, loadAPIKeys, returnAPIKeys }