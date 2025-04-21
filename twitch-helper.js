import fs from "fs-extra";
import { funFact, returnAuthObject } from "./api-helper.js";
import { sendChatCompletionRequest, moderatorPrompt } from "./prompt-helper.js";
import moment from "moment";
import { retrieveConfigValue } from './config-helper.js'
const lastFunFactTime = new Map();

/**
 * Returns a formatted string for a Twitch event based on its type.
 *
 * @param {object} eventThing - The event data.
 * @param {string} userId - The ID of the user associated with the event.
 * @returns {Promise<string>} - A formatted string describing the event.
 */
async function returnTwitchEvent(eventThing, userId) {
  const userObj = await returnAuthObject(userId);
  const event = {
    ...eventThing,
    playerName: userObj.user_name,
    playerId: userObj.user_id,
  };

  const eventTypeHandlers = {
    sub: subMessage,
    dono: donoMessage,
    chat: chatMessage,
    raid: raidMessage,
    follow: followMessage,
    hype_start: hypeStartMessage,
    hype_update: hypeUpdateMessage,
    hype_end: hypeEndMessage,
    hype_up: hypeLevelUpMessage,
    trivia: triviaMessage,
    ad: adMessage,
    summary: summaryMessage,
    shoutout: shoutoutMessage,
  };

  const handler = eventTypeHandlers[event.eventType];
  if (handler) {
    return await handler(event);
  } else {
  }
}

/**
 * Processes command-driven events from chat
 * @param {string} command - The command text 
 * @param {string} userId - The user ID
 * @returns {Promise<object>} - Event object if command is valid
 */
export async function processCommandEvent(command, userId) {
  if (command.startsWith('!summary')) {
    return {
      eventType: 'summary',
      eventData: {}
    };
  } else if (command.startsWith('!trivia')) {
    return {
      eventType: 'trivia',
      eventData: {}
    };
  }

  return null;
}

/**
 * Processes real-time chat messages from any source
 * @param {object} chatEvent - The chat event data
 * @param {string} userId - The user ID
 * @returns {Promise<object>} - The processing result
 */
export async function processChatMessage(chatEvent, userId) {
  try {
    // Normalize the chat message
    const normalizedChat = normalizeMessageFormat(chatEvent);
    
    // Get user data
    const user = await returnAuthObject(userId);
    
    // Skip messages from ignored bots
    const fromBot = await containsAuxBotName(normalizedChat.user, userId);
    if (fromBot) return { success: true, ignored: true, reason: "bot_user" };
    
    // Check if message is a command
    const isCommand = await isCommandMatch(normalizedChat.message, userId);
    if (isCommand) return { success: true, ignored: true, reason: "command" };
    
    // Check if message mentions the character
    const mentionsChar = await containsCharacterName(normalizedChat.message, userId);
    
    // Format date for context
    const formattedDate = new Date().toLocaleString();
    
    // Process first messages or character mentions
    if (normalizedChat.firstMessage || mentionsChar) {
      // Add message to vector storage
      const summaryString = `On ${formattedDate} ${normalizedChat.user} said in ${user.twitch_name}'s Twitch chat: "${normalizedChat.message}"`;
      
      // Store asynchronously
      addChatMessageAsVector(
        summaryString,
        normalizedChat.message,
        normalizedChat.user,
        formattedDate,
        "",
        userId
      ).catch(err => logger.error("Twitch", `Error storing chat vector: ${err.message}`));
      
      // Return data needed for response generation
      return {
        success: true,
        processed: true,
        mentioned: mentionsChar,
        firstMessage: normalizedChat.firstMessage,
        requiresResponse: mentionsChar || normalizedChat.firstMessage,
        messageData: {
          message: normalizedChat.message,
          user: normalizedChat.user
        }
      };
    }
    
    // For other messages, store if configured
    if (user.store_all_chat) {
      const summaryString = `On ${formattedDate} ${normalizedChat.user} said in ${user.twitch_name}'s Twitch chat: "${normalizedChat.message}"`;
      
      addChatMessageAsVector(
        summaryString,
        normalizedChat.message,
        normalizedChat.user,
        formattedDate,
        "",
        userId
      ).catch(err => logger.error("Twitch", `Error storing regular chat: ${err.message}`));
    }
    
    return {
      success: true,
      processed: false,
      requiresResponse: false
    };
  } catch (error) {
    logger.error("Twitch", `Error processing chat: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Calculates the time difference between a given date and the current time.
 *
 * @param {string} inputDate - The date string to compare with the current time.
 * @returns {string} - A string describing the time difference.
 */
const getTimeDifferenceFromNow = (inputDate) => {
  const format = "MM/DD/YYYY hh:mm:ss A";
  const momentDate = moment.utc(inputDate, format);
  const now = moment.utc();

  const diffInMinutes = momentDate.diff(now, "minutes");
  const absDiff = Math.abs(diffInMinutes);

  if (diffInMinutes > 0) {
    return `in ${absDiff < 60 ? `${absDiff} minute${absDiff === 1 ? "" : "s"}` : `${Math.round(absDiff / 60)} hour${Math.round(absDiff / 60) === 1 ? "" : "s"}`}`;
  } else {
    return `${absDiff < 60 ? `${absDiff} minute${absDiff === 1 ? "" : "s"}` : `${Math.round(absDiff / 60)} hour${Math.round(absDiff / 60) === 1 ? "" : "s"}`} ago`;
  }
};

const eventMessagesCache = {};

async function readEventMessages(playerId) {
  if (eventMessagesCache[playerId]) {
    return eventMessagesCache[playerId];
  }
  try {
    const filePath = `./world_info/${playerId}/event_messages.txt`;
    const fileContent = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(fileContent);
    eventMessagesCache[playerId] = parsed;
    return parsed;
  } catch (error) {
    logger.log("Files", `Error reading event messages for player ${playerId}: ${error}`);
    return {};
  }
}

/**
 * Normalizes chat messages from various sources into a standard format
 * @param {object} messageData - Raw message from EventSub or API
 * @returns {object} - Standardized chat object
 */
export function normalizeMessageFormat(messageData) {
  // From EventSub webhook
  if (messageData.chatter && messageData.message && messageData.message.text) {
    return {
      user: messageData.chatter.user_name,
      userId: messageData.chatter.user_id,
      message: messageData.message.text,
      firstMessage: messageData.message.is_first || false,
      badges: messageData.chatter.badges?.map(badge => badge.set_id) || [],
      emotes: messageData.message.fragments
        ?.filter(f => f.type === 'emote')
        .map(e => ({ id: e.id, code: e.text })) || [],
      emoteCount: messageData.message.fragments?.filter(f => f.type === 'emote').length || 0,
      color: messageData.color,
      source: 'eventsub'
    };
  }
  
  // From Enspira API
  return {
    user: messageData.user,
    userId: messageData.userId || null,
    message: messageData.message,
    firstMessage: messageData.firstMessage || false,
    badges: messageData.badges || [],
    emotes: messageData.emotes || [],
    emoteCount: messageData.emoteCount || 0,
    color: messageData.color || null,
    source: 'api'
  };
}

/**
 * Generates a formatted string for a subscription event.
 *
 * @param {object} event - The subscription event data.
 * @returns {Promise<string>} - A formatted string describing the subscription event.
 */
const subMessage = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId);
  const subValues = {
    prime: "$4.99",
    "tier 1": "$4.99",
    "tier 2": "$9.99",
    "tier 3": "$24.99",
  };
  const subValNum = {
    prime: 4.99,
    "tier 1": 4.99,
    "tier 2": 9.99,
    "tier 3": 24.99,
  };
  let subString = "";

  switch (event.eventData.subType) {
    case "sub":
      subString += `${event.eventData.user} just gave ${event.playerName} a ${event.eventData.subTier} sub! They spent ${subValues[event.eventData.subTier]} to give them a subscription. `;
      subString += event.eventData.multiMonth
        ? `They also decided to subscribe for ${event.eventData.monthLength} months, and have been subscribed for ${event.eventData.tenure} months so far! `
        : "";
      subString += event.eventData.primeUpgrade
        ? `They upgraded from their Twitch Prime subscription right into being a ${event.eventData.subTier} subscriber, paying ${subValues[event.eventData.subTier]} to do so! `
        : "";
      subString += event.eventData.paidForward
        ? "They decided to pay their gifted subscription forward! "
        : "";
      subString += event.eventData.message
        ? `${event.eventData.user} said this in the Twitch chat afterward:\n${event.eventData.message}`
        : "";
      break;
    case "resub":
      subString += `${event.eventData.user} just decided to resubscribe to ${event.playerName}'s Twitch channel! They resubscribed with a ${event.eventData.subTier} sub! `;
      subString += `They spent ${subValues[event.eventData.subTier]} to resubscribe. They're on a ${event.eventData.streak} month streak and have been a subscriber for ${event.eventData.tenure} months. `;
      subString += `${event.eventData.user} said the following in the Twitch chat afterward:\n${event.eventData.sharedChat}`;
      break;
    case "gift_sub":
      if (event.eventData.anonymous) {
        subString += `Some generous person just gave ${event.eventData.recipientUserName} a ${event.eventData.subTier} sub to ${event.playerName}'s Twitch channel! `;
        subString += `They spent ${subValues[event.eventData.subTier]} to gift this sub. `;
      } else {
        subString += `${event.eventData.user} just gave ${event.eventData.recipientUserName} a ${event.eventData.subTier} sub to ${event.playerName}'s Twitch channel! They spent ${subValues[event.eventData.subTier]} to gift this sub. `;
      }
      subString += event.eventData.random
        ? `This sub was randomly given to ${event.eventData.recipientUserName}. `
        : `This sub was specifically given to ${event.eventData.recipientUserName}. `;
      subString += `They're on a ${event.eventData.streak} month streak with their own sub, and have been a subscriber for ${event.eventData.tenure} months so far. `;
      if (event.eventData.anonymous) {
        subString += `Though they wished to be anonymous, they said the following in the Twitch chat afterward:\n${event.eventData.message}`;
      } else {
        subString += `${event.eventData.user} said the following in the Twitch chat afterward:\n${event.eventData.message}`;
      }
      break;
    case "gift_bomb":
      if (event.eventData.anonymous) {
        subString += `Some generous person just gave out ${event.eventData.giftAmt} ${event.eventData.subTier} subs to ${event.playerName}'s channel! `;
        subString += event.eventData.sharedAmt
          ? `They spent $${(subValNum[event.eventData.subTier] * event.eventData.giftAmt).toFixed(2)} on these subs. `
          : `Each sub was worth ${subValNum[event.eventData.subTier]}. `;
      } else {
        subString += `${event.eventData.user} just gave out ${event.eventData.giftAmt} ${event.eventData.subTier} subs to ${event.playerName}'s channel! `;
        subString += event.eventData.sharedAmt
          ? `They spent $${(subValNum[event.eventData.subTier] * event.eventData.giftAmt).toFixed(2)} on these subs. `
          : `Each sub was worth ${subValNum[event.eventData.subTier]}. `;
      }
      subString +=
        event.eventData.bonusGifts > 0
          ? `Twitch themselves also decided to add subs towards ${event.playerName}'s channel too! `
          : "";
      subString += event.eventData.anonymous
        ? `They said this in the chat afterward:\n${event.eventData.systemMessage}`
        : `${event.eventData.user} said this in the chat afterward:\n${event.eventData.systemMessage}`;
      break;
    default:
      break;
  }
  subString += `\n${parsedAddons.sub.replace("{{user}}", event.playerName)}`;
  return subString;
};

/**
 * Generates a formatted string for a donation event.
 *
 * @param {object} event - The donation event data.
 * @returns {Promise<string>} - A formatted string describing the donation event.
 */
const donoMessage = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId);
  let subString = "";
  switch (event.eventData.donoType) {
    case "tip":
      subString += `A donation for ${event.eventData.donoAmt} just came through from ${event.eventData.donoFrom}! `;
      break;
    case "charity":
      subString += `A donation towards our favorite charity ${event.eventData.forCharity} just came through, in the amount of $${event.eventData.donoAmt}! `;
      break;
    case "bits":
      subString += `${event.eventData.donoFrom} just donated ${event.eventData.donoAmt} bits to ${event.playerName}'s channel! While each one of these is only worth a cent, they do stack up! `;
    default:
      break;
  }
  subString +=
    event.eventData.donoType === "charity"
      ? `\n${parsedAddons.charity.replace("{{user}}", event.playerName)}`
      : `They said this in a message:\n${event.eventData.donoMessage}\n${parsedAddons.dono.replace(
        "{{user}}",
        event.playerName,
      )}`;
  return subString;
};

/**
 * Generates a formatted string for a raid event.
 *
 * @param {object} event - The raid event data.
 * @returns {Promise<string>} - A formatted string describing the raid event.
 */
const raidMessage = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId);
  let subString = `${event.eventData.username} just raided ${event.playerName}'s Twitch channel! `;
  subString += `${event.eventData.username} has been streaming for ${event.eventData.accountAge} as well! `;
  subString += event.eventData.isFollowing
    ? `They are not currently a follower of ${event.playerName}'s channel. `
    : `They are a follower of ${event.playerName}'s channel! `;
  subString += `They were last seen playing the video game ${event.eventData.lastGame} to their viewers! `;
  subString += `Their raid brought along ${event.eventData.viewers} viewers with them, who will now be eagerly watching ${event.playerName} stream and game!\n`;
  subString += parsedAddons.raid.replace("{{user}}", event.playerName);
  return subString;
};

/**
 * Generates a formatted string for a follow event.
 *
 * @param {object} event - The follow event data.
 * @returns {Promise<string>} - A formatted string describing the follow event.
 */
const followMessage = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId);
  return `${event.eventData.username} just followed ${event.playerName}'s Twitch channel!\n\n${parsedAddons.follow.replace("{{user}}", event.playerName)}`;
};

/**
 * Generates a formatted string for a summary message during a break in streaming.
 *
 * @param {object} event - The summary event data.
 * @returns {Promise<string>} - A formatted string summarizing the stream's events.
 */
const summaryMessage = async (event) => {
  return `${event.playerName} is taking a small break from streaming. While ${event.playerName}'s away from their keyboard, briefly summarize the events in the stream using only the previous chat interactions and any other Twitch events that occured. Do not imagine any other details about the live stream, only use the provided context. Be creative in your summary and put a creative spin on things, but avoid responding with more than 500 characters.`;
};

/**
 * Generates a formatted string for a chat message event.
 *
 * @param {object} event - The chat message event data.
 * @returns {Promise<string>} - A formatted string describing the chat message event.
 */
const chatMessage = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId);
  let subString = `${event.user} sent the following message in ${event.playerName}'s Twitch chat:\n${event.message}`;
  subString += event.firstMessage
    ? `\nThis is ${event.user}'s *first ever* chat message in ${event.playerName}'s Twitch channel as well!`
    : "";
  subString += `\n${parsedAddons.firstchat.replace(
    "{{user}}",
    event.playerName,
  )}`;
  return subString;
};

/**
 * Generates a formatted string for a hype train start event.
 *
 * @param {object} event - The hype train start event data.
 * @returns {Promise<string>} - A formatted string describing the hype train start event.
 */
const hypeStartMessage = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId);
  let subString = `A hype train on ${event.playerName}'s channel just started!\n`;
  subString += `It is currently at level ${event.eventData.level}, started ${getTimeDifferenceFromNow(
    event.eventData.startedAt,
  )}, and will expire ${getTimeDifferenceFromNow(event.eventData.expiresAt)}.\n`;
  subString += `We are ${event.eventData.percent * 100
    }% of the way to level ${parseInt(event.eventData.level) + 1}!\n`;
  subString += `${event.eventData.topSubUser} has the most gifted subscriptions at ${event.eventData.topSubTotal} subs, and ${event.eventData.topBitsUser} has donated the most bits with ${event.eventData.topBitsAmt} bits donated!`;
  subString += "\n" + parsedAddons.hype;
  return subString;
};

/**
 * Generates a formatted string for a hype train update event.
 *
 * @param {object} event - The hype train update event data.
 * @returns {Promise<string>} - A formatted string describing the hype train update event.
 */
const hypeUpdateMessage = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId);
  let subString = `Here's an update on the Hype Train ${event.playerName}'s channel has started:\n`;
  subString += `It is currently at level ${event.eventData.level}, started ${getTimeDifferenceFromNow(
    event.eventData.startedAt,
  )}, and will expire ${getTimeDifferenceFromNow(event.eventData.expiresAt)}.\n`;
  subString += `There are ${event.eventData.contributors} contributors!\n`;
  subString += event.eventData.isGolden
    ? `This is now a Golden Kappa train, a rare event rewarding contributors with the Golden Kappa emote for 24 hours!\n`
    : "";
  subString += `We are ${event.eventData.percent * 100
    }% of the way to level ${parseInt(event.eventData.level) + 1}!\n`;
  subString += `${event.eventData.topSubUser} has the most gifted subscriptions at ${event.eventData.topSubTotal} subs, and ${event.eventData.topBitsUser} has donated the most bits with ${event.eventData.topBitsAmt} bits donated!`;
  subString += "\n" + parsedAddons.hype;
  return subString;
};

/**
 * Generates a formatted string for a hype train end event.
 *
 * @param {object} event - The hype train end event data.
 * @returns {Promise<string>} - A formatted string describing the hype train end event.
 */
const hypeEndMessage = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId);
  let subString = `The Hype Train on ${event.playerName}'s channel has just ended!\n`;
  subString += `It ended at level ${event.eventData.level}, started ${getTimeDifferenceFromNow(
    event.eventData.startedAt,
  )}, and reached ${event.eventData.percent * 100
    }% towards level ${parseInt(event.eventData.level) + 1}.\n`;
  subString += `There were ${event.eventData.contributors} contributors! `;
  subString += event.eventData.isGolden
    ? `This was a Golden Kappa train, a rare event rewarding contributors with the Golden Kappa emote for 24 hours.\n`
    : "";
  subString += `${event.eventData.topSubUser} gifted the most subscriptions at ${event.eventData.topSubTotal} subs, and ${event.eventData.topBitsUser} donated the most bits with ${event.eventData.topBitsAmt} bits donated!`;
  subString += "\n" + parsedAddons.hype;
  return subString;
};

/**
 * Generates a formatted string for a hype train level up event.
 *
 * @param {object} event - The hype train level up event data.
 * @returns {Promise<string>} - A formatted string describing the hype train level up event.
 */
const hypeLevelUpMessage = async (event) => {
  const parsedAddons = await readEventMessages(event.playerId);
  let subString = `The hype train on ${event.playerName}'s channel has just leveled up!\n`;
  subString += `It is now at level ${event.eventData.level}, started ${getTimeDifferenceFromNow(
    event.eventData.startedAt,
  )}, and will expire ${getTimeDifferenceFromNow(event.eventData.expiresAt)}.\n`;
  subString += `There are ${event.eventData.contributors} contributors!\n`;
  subString += event.eventData.isGolden
    ? `This is now a Golden Kappa train, a rare event rewarding contributors with the Golden Kappa emote for 24 hours!\n`
    : "";
  subString += `We are ${event.eventData.percent * 100
    }% of the way to level ${parseInt(event.eventData.level) + 1}!\n`;
  subString += `${event.eventData.topSubUser} has the most gifted subscriptions at ${event.eventData.topSubTotal} subs, and ${event.eventData.topBitsUser} has donated the most bits with ${event.eventData.topBitsAmt} bits donated!`;
  subString += "\n" + parsedAddons.hype;
  return subString;
};

/**
 * Generates a formatted string for a trivia message event.
 *
 * @param {object} event - The trivia message event data.
 * @returns {Promise<string>} - A formatted string containing a fun fact.
 */
const triviaMessage = async (event) => {
  return `You're about to receive a fun fact to tell all of the viewers of ${event.playerName}'s channel. Share the entirety of this fact, and your thoughts about it, to all of the viewers. Here is the fun fact:\n${await funFact()}`;
};



/**
 * Generates a formatted string for a shoutout message event.
 *
 * @param {object} event - The shoutout message event data.
 * @returns {Promise<string>} - A formatted string describing the shoutout event.
 */
const shoutoutMessage = async (event) => {
  let subString = `${event.playerName} wants you to give ${event.eventData.user} a shoutout in their Twitch channel! Here is some information regarding ${event.eventData.user} to consider when shouting them out!\n`;
  subString += `${event.eventData.user} started their streaming career ${getTimeDifferenceFromNow(
    event.eventData.accountAge,
  )}!\n`;
  subString += `The last time ${event.eventData.user} was live, they were streaming ${event.eventData.game} for their viewers! `;
  subString += `${event.eventData.user} was last active ${getTimeDifferenceFromNow(
    event.eventData.lastActive,
  )} on their channel! The title of their last stream was '${event.eventData.streamTitle
    }'. `;
  subString += event.eventData.isMod
    ? `They are also a moderator in ${event.playerName}'s Twitch channel!\n`
    : "";
  subString += event.eventData.isAffiliate
    ? `They are also a Twitch affiliate!\n`
    : "";
  subString += event.eventData.isPartner
    ? `They are also an official Twitch partner!\n`
    : "";
  subString += event.eventData.isSubbed
    ? `They are also currently subscribed to ${event.playerName}'s Twitch channel!\n`
    : "";
  subString += `Make sure you give ${event.eventData.user} the type of hype-up you can only get from ${event.playerName}'s Twitch channel!`;
  return subString;
};

/**
 * Generates a formatted string for an ad message event.
 *
 * @param {object} event - The ad message event data.
 * @returns {Promise<string>} - A formatted string describing the ad event.
 */
const adMessage = async (event) => {
  return `Give a heads up to the viewers of ${event.playerName}'s channel that ads will be coming in ${event.minutesLeft} minutes. Playfully hint towards avoiding the ads by subscribing to ${event.playerName}'s channel, and how much it would mean to you.`;
};

/**
 * Retrieves and formats social media information for a user.
 * Enhanced to better support template variables and specific platform requests.
 *
 * @param {string} userId - The ID of the user.
 * @param {string} [platform] - If provided, returns information for a specific platform.
 * @returns {Promise<string|object>} - A formatted string, specific platform value, or object containing social media information.
 */
async function socialMedias(userId, platform = "") {
  try {
    const currentUser = await returnAuthObject(userId);
    
    if (!currentUser?.socials) {
      return platform ? "" : "";
    }
    
    // Return all social media as an object if requested
    if (platform === "all") {
      return { ...currentUser.socials };
    }

    // Normalize platform name and return specific value if requested
    const normalizedPlatform = normalizePlatformName(platform);
    if (normalizedPlatform) {
      return currentUser.socials[normalizedPlatform] || "";
    }

    // Format all available platforms for template use
    return Object.entries(currentUser.socials)
      .filter(([_, value]) => value?.trim())
      .map(([key, value]) => formatSocialMediaValue(key, value))
      .filter(Boolean)
      .join(", ")
      ? `(${Object.entries(currentUser.socials)
          .filter(([_, value]) => value?.trim())
          .map(([key, value]) => formatSocialMediaValue(key, value))
          .filter(Boolean)
          .join(", ")})`
      : "";
  } catch (error) {
    logger.log("System", `Error retrieving social media: ${error.message}`);
    return platform ? "" : "";
  }
}

/**
 * Normalizes platform names to consistent keys.
 * 
 * @param {string} platform - The platform identifier to normalize.
 * @returns {string} - The normalized platform key.
 */
function normalizePlatformName(platform) {
  if (!platform) return "";
  
  const platformMap = {
    // TikTok variations
    "tt": "tiktok",
    "tik": "tiktok",
    "tiktok": "tiktok",
    
    // YouTube variations
    "yt": "youtube",
    "youtube": "youtube",
    
    // Twitter/X variations
    "twitter": "twitter",
    "x": "twitter",
    "tweet": "twitter",
    
    // Twitch
    "twitch": "twitch",
    
    // Instagram
    "ig": "instagram",
    "insta": "instagram",
    "instagram": "instagram",
    
    // Discord
    "discord": "discord",
    
    // Kick
    "kick": "kick",
    
    // Facebook
    "fb": "facebook",
    "facebook": "facebook",
    
    // Other common platforms
    "linkedin": "linkedin",
    "github": "github",
    "reddit": "reddit"
  };
  
  return platformMap[platform.toLowerCase()] || platform.toLowerCase();
}

/**
 * Formats a social media value for display.
 * 
 * @param {string} platform - The platform name.
 * @param {string} value - The social media handle or URL.
 * @returns {string} - Formatted social media value.
 */
function formatSocialMediaValue(platform, value) {
  if (!value || value.trim() === "") return "";
  
  let formattedValue = value.trim();
  
  // Add @ prefix for handles if not present
  const handlePlatforms = ["twitter", "tiktok", "instagram"];
  if (handlePlatforms.includes(platform.toLowerCase()) && !formattedValue.startsWith("@")) {
    formattedValue = `@${formattedValue}`;
  }
  
  return `${formattedValue}`;
}

export { 
  socialMedias,
  normalizePlatformName, // Export for testing or direct use
  formatSocialMediaValue // Export for testing or direct use
};

/**
 * Checks if an input string matches any of a user's social media identifiers.
 *
 * @param {string} input - The input string to check.
 * @param {string} userId - The ID of the user.
 * @returns {Promise<boolean>} - True if a match is found, false otherwise.
 */
async function checkForUser(input, userId) {
  const socialMediaObj = await socialMedias(userId, "all");

  if (Object.keys(socialMediaObj).length === 0) {
    logger.log("System", "socialMediaObj is empty.");
    return false;
  }

  const normalizedInput = input.trim().toLowerCase();
  return Object.values(socialMediaObj).some((value) => {
    const normalizedValue = value.trim().toLowerCase();
    return normalizedValue === normalizedInput;
  });
}

/**
 * Checks if a message matches any command in the user's command list.
 *
 * @param {string} message - The message to check.
 * @param {string} userId - The ID of the user.
 * @returns {Promise<boolean>} - True if the message matches a command, false otherwise.
 */
const isCommandMatch = async (message, userId) => {
  const userObj = await returnAuthObject(userId);
  const commandRegex = new RegExp(
    `^(${userObj.commands_list.join("|")})$`,
    "i",
  );
  return commandRegex.test(message);
};

/**
 * Prepares a moderation chat request by formatting the message and adding relevant context.
 *
 * @param {string} userName - The name of the user being moderated.
 * @param {string} userMessage - The message from the user.
 * @param {number} emoteCount - The number of emotes in the message.
 * @param {string} userId - The ID of the user associated with the moderation.
 * @returns {Promise<string|object>} - The moderation action to take, or an object with details for further action.
 */
async function prepareModerationChatRequest(
  userName,
  userMessage,
  emoteCount,
  userId,
) {
  try {
    const strikeInfo = await getStrikesByUserName(userName, userId);
    const banInfo = await checkBanned(userName, userId);
    const userStrikes = strikeInfo.strikes;
    const userObject = await returnAuthObject(userId);

    let userMessageFormatted = `${userName} sent the following message:\n\`${userMessage}\`\nThey have ${userStrikes} strikes currently.\nThey sent ${emoteCount} emotes.`;

    if (userStrikes === 2) {
      userMessageFormatted += userObject.global_strikes
        ? `\n${userName} has ${userStrikes} strikes across all users platforms. This is their last strike. If they commit another offense, apply a ban.`
        : `\nThis is ${userName}'s last strike on ${userObject.user_name}'s channel. If they commit another offense, apply a ban.`;
    } else if (userStrikes >= 3) {
      userMessageFormatted += userObject.global_bans
        ? `\n${userName} has surpassed their max strikes on all user platforms. Apply a ban immediately regardless of their offense.`
        : `\n${userName} has surpassed their max strikes on ${userObject.user_name}'s channel. Apply a ban immediately regardless of their offense.`;
    }

    if (banInfo.banned) {
      userMessageFormatted += `\n${userName} has been banned in ${banInfo.banCount} other communities. Per ${userObject.user_name}'s request, apply a ban immediately regardless of their offense.`;
    }

    const moderationPrompt = await moderatorPrompt(
      userMessageFormatted,
      userId,
    );

    const completion = await sendChatCompletionRequest(moderationPrompt, await retrieveConfigValue("models.moderator"));
    const formattedCompletion = JSON.parse(completion.response)
    if (formattedCompletion.actionNeeded == true) {
      const reason = formattedCompletion.reason
      const action = formattedCompletion.actionType
      if (action === "strike") {
        logger.log(
          "Moderation",
          `${userName} earned a strike in ${userObject.twitch_name}'s channel. Reason: ${reason}'`,
        );
        const newStrikes = await incrementStrikes(userName, userId);
        return {
          action,
          reason,
          user: userName,
          userMsg: userMessage,
          strikeCount: newStrikes.strikes,
        };
      } else if (action === "ban") {
        logger.log(
          "Moderation",
          `${userName} received a ${action} in ${userObject.twitch_name}'s channel. Reason: '${reason}'`,
        );
        await addBanToUser(userName, userObject.twitch_name);
        return {
          action,
          reason,
          user: userName,
          userMsg: userMessage,
        };
      }
    } else {
      return "safe"
    }
  } catch (error) {
    logger.log("Moderation", `Error creating mod chat completion: ${error}`);
    return "error";
  }
}

/**
 * Retrieves the number of strikes for a given user.
 *
 * @param {string} userName - The name of the user.
 * @param {string} userId - The ID of the user associated with the strikes.
 * @returns {Promise<object>} - An object containing the user name and their number of strikes.
 */
const getStrikesByUserName = async (userName, userId) => {
  const userObject = await returnAuthObject(userId);
  try {
    const data = await fs.readFile("./data/global/strikes.json", "utf8");

    if (!data.trim()) {
      logger.log("Moderation", "The strike list is currently empty.");
      return { userName, strikes: 0 };
    }

    const strikes = JSON.parse(data);

    if (userObject.global_strikes && strikes.hasOwnProperty(userName)) {
      const sumOfAllStrikes = Object.values(strikes[userName]).reduce(
        (sum, count) => sum + count,
        0,
      );
      return { userName, strikes: sumOfAllStrikes };
    } else if (strikes.hasOwnProperty(userName)) {
      return {
        userName,
        strikes: strikes[userName][userObject.twitch_name] || 0,
      };
    } else {
      return { userName, strikes: 0 };
    }
  } catch (error) {
    logger.log(
      "Moderation",
      `Error reading or parsing the JSON file: ${error}`,
    );
  }
};

/**
 * Increments the strike count for a given user.
 *
 * @param {string} userName - The name of the user.
 * @param {string} userId - The ID of the user associated with the strikes.
 * @returns {Promise<object>} - An object containing the user name and their updated number of strikes.
 */
async function incrementStrikes(userName, userId) {
  const userObject = await returnAuthObject(userId);
  const strikesFilePath = "./data/global/strikes.json";

  try {
    await fs.ensureFile(strikesFilePath);
    let strikes = {};

    const data = await fs.readFile(strikesFilePath, "utf8");
    if (data.trim()) {
      strikes = JSON.parse(data);
    }

    if (!strikes.hasOwnProperty(userName)) {
      strikes[userName] = {};
    }

    strikes[userName][userObject.twitch_name] =
      (strikes[userName][userObject.twitch_name] || 0) + 1;

    await fs.writeFile(
      strikesFilePath,
      JSON.stringify(strikes, null, 2),
      "utf8",
    );

    return { userName, strikes: strikes[userName][userObject.twitch_name] };
  } catch (error) {
    logger.log("Moderation", `Error updating strikes: ${error}`, "err");
  }
}

/**
 * Checks if a user is banned and retrieves their ban information.
 *
 * @param {string} userName - The name of the user to check.
 * @param {string} userId - The ID of the user associated with the ban list.
 * @returns {Promise<object>} - An object containing ban information.
 */
const checkBanned = async (userName, userId) => {
  try {
    const bansData = JSON.parse(
      await fs.readFile("./data/global/bans.json", "utf-8"),
    );
    const userObject = await returnAuthObject(userId);

    if (userObject.global_bans && bansData.hasOwnProperty(userName)) {
      const streamerBans = bansData[userName]; // Array of streamers where the user is banned
      return {
        banned: true,
        streamerBans,
        banCount: streamerBans.length,
      };
    } else {
      return {
        banned: false,
        streamerBans: [],
        banCount: 0,
      };
    }
  } catch (error) {
    logger.log("Moderator", `Error reading or processing bans.json: ${error}`);
  }
};

/**
 * Adds a ban for a user in a specific streamer's context.
 *
 * @param {string} userName - The name of the user to ban.
 * @param {string} streamerName - The name of the streamer banning the user.
 * @returns {Promise<void>}
 */
const addBanToUser = async (userName, streamerName) => {
  try {
    const bansFilePath = "./data/global/bans.json";
    await fs.ensureFile(bansFilePath);

    let bansData = {};
    const data = await fs.readFile(bansFilePath, "utf8");
    if (data.trim()) {
      bansData = JSON.parse(data);
    }

    if (!bansData.hasOwnProperty(userName)) {
      bansData[userName] = [];
    }

    if (!bansData[userName].includes(streamerName)) {
      bansData[userName].push(streamerName);
      await fs.writeFile(
        bansFilePath,
        JSON.stringify(bansData, null, 2),
        "utf8",
      );
      logger.log(
        "System",
        `Banned ${userName} from ${streamerName}'s channel.`,
      );
    } else {
      logger.log(
        "Moderator",
        `${streamerName} is already in ${userName}'s ban list.`,
      );
    }
  } catch (error) {
    logger.log("Moderator", `Error reading or updating bans.json: ${error}`);
  }
};

/**
 * Checks if it's time to generate a fun fact based on the user's settings
 * @param {string} userId - The user ID
 * @returns {Promise<boolean>} - True if it's time for a fun fact, false otherwise
 */
export async function shouldGenerateFunFact(userId) {
  try {
    const user = await returnAuthObject(userId);
    
    // If fun facts are disabled, return false
    if (!user.funFacts) {
      return false;
    }
    
    const now = Date.now();
    const lastTime = lastFunFactTime.get(userId) || 0;
    const interval = (user.funFactsInterval || 30) * 60 * 1000; // Convert minutes to milliseconds
    
    // Check if enough time has passed since the last fun fact
    if (now - lastTime >= interval) {
      // Update the last fun fact time
      lastFunFactTime.set(userId, now);
      return true;
    }
    
    return false;
  } catch (error) {
    logger.error("Twitch", `Error checking fun fact timing: ${error.message}`);
    return false;
  }
}

/**
 * Removes a ban for a user in a specific streamer's context.
 *
 * @param {string} userName - The name of the user to unban.
 * @param {string} streamerName - The name of the streamer unbanning the user.
 * @returns {Promise<void>}
 */
const undoBan = async (userName, streamerName) => {
  try {
    const bansFilePath = "./data/global/bans.json";
    await fs.ensureFile(bansFilePath);

    let bansData = {};
    const data = await fs.readFile(bansFilePath, "utf8");
    if (data.trim()) {
      bansData = JSON.parse(data);
    }

    if (!bansData.hasOwnProperty(userName)) {
      logger.log(
        "Moderator",
        `User ${userName} does not exist in the ban list.`,
      );
      return;
    }

    const userBans = bansData[userName];
    const index = userBans.indexOf(streamerName);

    if (index !== -1) {
      userBans.splice(index, 1);
      if (userBans.length === 0) {
        delete bansData[userName]; // Remove the user entry if the ban list is empty
      }
      await fs.writeFile(
        bansFilePath,
        JSON.stringify(bansData, null, 2),
        "utf8",
      );
      logger.log(
        "System",
        `Removed ${streamerName} from ${userName}'s ban list.`,
      );
    } else {
      logger.log(
        "Moderator",
        `${streamerName} is not in ${userName}'s ban list.`,
      );
    }
  } catch (error) {
    logger.log("Moderator", `Error reading or updating bans.json: ${error}`);
  }
};

/**
 * Checks if a message contains any of the auxiliary bot names associated with a user.
 *
 * @param {string} message - The message to check.
 * @param {string} userId - The ID of the user associated with the auxiliary bots.
 * @returns {Promise<boolean>} - True if the message contains any of the auxiliary bot names, false otherwise.
 */
async function containsAuxBotName(message, userId) {
  const userObj = await returnAuthObject(userId);
  const auxBots = userObj.aux_bots;

  if (typeof message !== "string" || !Array.isArray(auxBots)) {

  }

  const lowerCaseMessage = message.toLowerCase();
  return auxBots.some((botName) =>
    lowerCaseMessage.includes(botName.toLowerCase()),
  );
}

export {
  returnTwitchEvent,
  isCommandMatch,
  prepareModerationChatRequest,
  incrementStrikes,
  getStrikesByUserName,
  checkForUser,
  containsAuxBotName,
  checkBanned,
  undoBan
};
