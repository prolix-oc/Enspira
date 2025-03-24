import crypto from 'crypto';
import axios from 'axios';
import { returnAPIKeys, returnAuthObject, updateUserParameter } from './api-helper.js';
import { retrieveConfigValue } from './config-helper.js';
import { logger } from './create-global-logger.js';

// EventSub subscription types we want to monitor
const SUBSCRIPTION_TYPES = [
  'channel.update',               // Game/title changes
  'channel.follow',               // New followers
  'channel.subscribe',            // New subscriptions
  'channel.subscription.gift',    // Gifted subs
  'channel.subscription.message', // Resub messages
  'channel.cheer',                // Bits donations
  'channel.hype_train.begin',     // Hype train start
  'channel.hype_train.progress',  // Hype train progress
  'channel.hype_train.end',       // Hype train end
  'stream.online',                // Stream starts
  'stream.offline'                // Stream ends
];

// Main function to register EventSub for all users
export async function registerAllUsersEventSub() {
  try {
    logger.log("Twitch", "Starting automatic EventSub registration for all users");
    
    // Get all users from auth system
    const users = await returnAPIKeys();
    let successCount = 0;
    let failureCount = 0;
    
    // Process each user sequentially to avoid rate limits
    for (const user of users) {
      try {
        // Skip users without Twitch tokens
        if (!user.twitch_tokens || !user.twitch_tokens.access_token) {
          logger.log("Twitch", `Skipping EventSub for ${user.user_id}: No Twitch tokens`);
          continue;
        }
        
        // Check if we need to refresh the token
        const validToken = await ensureValidToken(user.user_id);
        if (!validToken) {
          logger.log("Twitch", `Skipping EventSub for ${user.user_id}: Token refresh failed`);
          failureCount++;
          continue;
        }
        
        // Get Twitch user ID if we don't have it yet
        if (!user.twitch_tokens.twitch_user_id) {
          const twitchUserId = await fetchTwitchUserId(user.user_id);
          if (!twitchUserId) {
            logger.log("Twitch", `Skipping EventSub for ${user.user_id}: Couldn't get Twitch user ID`);
            failureCount++;
            continue;
          }
        }
        
        // Register all subscription types
        const results = await registerUserSubscriptions(user.user_id);
        
        if (results.success) {
          successCount++;
          logger.log("Twitch", `Successfully registered EventSub for ${user.user_id}`);
        } else {
          failureCount++;
          logger.log("Twitch", `Failed to register EventSub for ${user.user_id}: ${results.error}`);
        }
      } catch (userError) {
        failureCount++;
        logger.error("Twitch", `Error processing user ${user.user_id}: ${userError.message}`);
      }
      
      // Add a small delay between users to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    logger.log("Twitch", `EventSub registration complete. Success: ${successCount}, Failures: ${failureCount}`);
    return { success: successCount, failures: failureCount };
  } catch (error) {
    logger.error("Twitch", `Error in registerAllUsersEventSub: ${error.message}`);
    throw error;
  }
}

// Register all subscription types for a single user
async function registerUserSubscriptions(userId) {
  const user = await returnAuthObject(userId);
  
  // Generate webhook secret if needed
  if (!user.twitch_tokens.webhook_secret) {
    const newSecret = crypto.randomBytes(32).toString('hex');
    await updateUserParameter(userId, "twitch_tokens.webhook_secret", newSecret);
  }
  
  // Track existing subscriptions to avoid duplicates
  const existingTypes = new Set();
  if (user.twitch_tokens.subscriptions) {
    user.twitch_tokens.subscriptions.forEach(sub => existingTypes.add(sub.type));
  }
  
  const results = {
    success: true,
    created: [],
    skipped: [],
    error: null
  };
  
  // Process each subscription type
  for (const type of SUBSCRIPTION_TYPES) {
    try {
      // Skip if we already have this subscription
      if (existingTypes.has(type)) {
        results.skipped.push(type);
        continue;
      }
      
      // Create the subscription
      const subResult = await createSubscription(
        userId, 
        type, 
        { broadcaster_user_id: user.twitch_tokens.twitch_user_id }
      );
      
      if (subResult.success) {
        results.created.push(type);
      } else {
        results.error = `Failed to create subscription for ${type}`;
        results.success = false;
        break;
      }
      
      // Add a small delay between requests to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      results.error = error.message;
      results.success = false;
      break;
    }
  }
  
  return results;
}

// Create a single EventSub subscription
async function createSubscription(userId, type, condition) {
  try {
    const user = await returnAuthObject(userId);
    const callbackUrl = `${await retrieveConfigValue("server.endpoints.external")}/api/v1/twitch/eventsub/${userId}`;
    
    const subscriptionBody = {
      type,
      version: '1',
      condition,
      transport: {
        method: 'webhook',
        callback: callbackUrl,
        secret: user.twitch_tokens.webhook_secret
      }
    };
    
    const response = await axios.post(
      'https://api.twitch.tv/helix/eventsub/subscriptions',
      subscriptionBody,
      {
        headers: {
          'Client-ID': await retrieveConfigValue("twitch.clientId"),
          'Authorization': `Bearer ${user.twitch_tokens.access_token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    // Save subscription ID
    const subscriptionId = response.data.data[0].id;
    const subscriptions = user.twitch_tokens.subscriptions || [];
    subscriptions.push({
      id: subscriptionId,
      type,
      created_at: new Date().toISOString()
    });
    
    await updateUserParameter(userId, "twitch_tokens.subscriptions", subscriptions);
    
    return { success: true, id: subscriptionId };
  } catch (error) {
    logger.error("Twitch", `Error creating subscription ${type} for ${userId}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Ensure token is valid and refresh if needed
async function ensureValidToken(userId) {
  try {
    const user = await returnAuthObject(userId);
    
    if (!user.twitch_tokens || !user.twitch_tokens.refresh_token) {
      return false;
    }
    
    // Check if token is expired or expiring soon
    const now = Date.now();
    const tokenExpiry = user.twitch_tokens.expires_at || 0;
    
    if (now >= tokenExpiry - (5 * 60 * 1000)) {
      // Token is expired or expiring in next 5 minutes, refresh it
      return await refreshToken(userId);
    }
    
    return true;
  } catch (error) {
    logger.error("Twitch", `Error checking token for ${userId}: ${error.message}`);
    return false;
  }
}

// Refresh an expired token
async function refreshToken(userId) {
  try {
    const user = await returnAuthObject(userId);
    
    const response = await axios.post(
      'https://id.twitch.tv/oauth2/token',
      new URLSearchParams({
        client_id: await retrieveConfigValue("twitch.clientId"),
        client_secret: await retrieveConfigValue("twitch.clientSecret"),
        grant_type: 'refresh_token',
        refresh_token: user.twitch_tokens.refresh_token
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    const { access_token, refresh_token, expires_in } = response.data;
    
    await updateUserParameter(userId, "twitch_tokens.access_token", access_token);
    await updateUserParameter(userId, "twitch_tokens.refresh_token", refresh_token);
    await updateUserParameter(userId, "twitch_tokens.expires_at", Date.now() + (expires_in * 1000));
    
    return true;
  } catch (error) {
    logger.error("Twitch", `Error refreshing token for ${userId}: ${error.message}`);
    return false;
  }
}

// Get Twitch user ID for a user
async function fetchTwitchUserId(userId) {
  try {
    const user = await returnAuthObject(userId);
    
    // Use twitch_name if available
    const twitchUsername = user.twitch_name;
    
    if (!twitchUsername) {
      return null;
    }
    
    const response = await axios.get(
      `https://api.twitch.tv/helix/users?login=${twitchUsername}`,
      {
        headers: {
          'Client-ID': await retrieveConfigValue("twitch.clientId"),
          'Authorization': `Bearer ${user.twitch_tokens.access_token}`
        }
      }
    );
    
    if (response.data.data && response.data.data.length > 0) {
      const twitchUserId = response.data.data[0].id;
      
      // Save the Twitch user ID
      await updateUserParameter(userId, "twitch_tokens.twitch_user_id", twitchUserId);
      
      return twitchUserId;
    }
    
    return null;
  } catch (error) {
    logger.error("Twitch", `Error fetching Twitch user ID for ${userId}: ${error.message}`);
    return null;
  }
}

// Connect EventSub events to your existing event processing
export async function processEventSubNotification(eventType, eventData, userId) {
  try {
    // Import your existing event handling system
    const { returnTwitchEvent } = await import('./twitch-helper.js');
    
    // Map EventSub event format to your existing format
    const mappedEvent = mapEventSubToInternalFormat(eventType, eventData);
    
    // Process through your existing system
    return await returnTwitchEvent(mappedEvent, userId);
  } catch (error) {
    logger.error("Twitch", `Error processing notification: ${error.message}`);
    throw error;
  }
}

// Convert EventSub format to your internal format
function mapEventSubToInternalFormat(eventType, eventData) {
  // Create base event object
  let mappedEvent = { eventType: null, eventData: {} };
  
  // Map based on event type
  switch (eventType) {
    case 'channel.update':
      mappedEvent.eventType = 'game_change';
      mappedEvent.eventData = {
        game: eventData.category_name,
        title: eventData.title
      };
      break;
      
    case 'channel.follow':
      mappedEvent.eventType = 'follow';
      mappedEvent.eventData = {
        username: eventData.user_name,
        userId: eventData.user_id,
        followed_at: eventData.followed_at
      };
      break;
      
    case 'channel.subscribe':
      mappedEvent.eventType = 'sub';
      mappedEvent.eventData = {
        subType: 'sub',
        user: eventData.user_name,
        subTier: mapTier(eventData.tier),
        isGift: eventData.is_gift
      };
      break;
    
    // Add mappings for other event types
    
    default:
      // Direct passthrough for unmapped types
      mappedEvent.eventType = eventType.replace('channel.', '').replace('stream.', '');
      mappedEvent.eventData = eventData;
  }
  
  return mappedEvent;
}

// Helper for tier mapping
function mapTier(tier) {
  switch (tier) {
    case '1000': return 'tier 1';
    case '2000': return 'tier 2';
    case '3000': return 'tier 3';
    default: return 'prime';
  }
}