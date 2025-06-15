// twitch-webhook-tester.js
import axios from 'axios';
import crypto from 'crypto';
import { retrieveConfigValue } from './config-helper.js';
import { returnAuthObject } from './api-helper.js';
import { logger } from './create-global-logger.js';

/**
 * Utility to test Twitch EventSub webhooks by sending mock notifications
 * to your local webhook endpoint
 */
class TwitchWebhookTester {
  constructor() {
    this.messageId = crypto.randomUUID();
    this.timestamp = new Date().toISOString();
  }

  /**
   * Initialize the tester with user-specific data
   * @param {string} userId - The user ID to test with
   * @returns {Promise<boolean>} - Whether initialization succeeded
   */
  async initialize(userId) {
    try {
      // Get the user's data
      this.user = await returnAuthObject(userId);
      if (!this.user) {
        logger.error("Twitch Tester", `User ${userId} not found`);
        return false;
      }

      // Check if user has Twitch integration
      if (!this.user.twitch_tokens?.streamer?.twitch_user_id) {
        logger.error("Twitch Tester", `User ${userId} has no Twitch ID configured`);
        return false;
      }

      // Get webhook secret
      this.webhookSecret = this.user.twitch_tokens.streamer.webhook_secret;
      if (!this.webhookSecret) {
        logger.error("Twitch Tester", `No webhook secret found for user ${userId}`);
        return false;
      }

      // Get the local webhook URL
      const serverEndpoint = await retrieveConfigValue("server.endpoints.internal");
      const serverPort = await retrieveConfigValue("server.port");
      this.webhookUrl = `http://${serverEndpoint}:${serverPort}/api/v1/twitch/eventsub/${userId}`;

      this.twitchUserId = this.user.twitch_tokens.streamer.twitch_user_id;
      this.twitchUserName = this.user.twitch_tokens.streamer.twitch_display_name || this.user.twitch_name;
      
      logger.log("Twitch Tester", `Initialized for user ${userId} (${this.twitchUserName})`);
      return true;
    } catch (error) {
      logger.error("Twitch Tester", `Initialization error: ${error.message}`);
      return false;
    }
  }

  /**
   * Sign a message with the webhook secret using HMAC SHA-256
   * @param {string} messageId - The message ID
   * @param {string} timestamp - The timestamp
   * @param {string} payload - The JSON payload as a string
   * @returns {string} - The signature
   */
  signMessage(messageId, timestamp, payload) {
    const hmacMessage = messageId + timestamp + payload;
    const signature = crypto.createHmac('sha256', this.webhookSecret)
      .update(hmacMessage)
      .digest('hex');
    return `sha256=${signature}`;
  }

  /**
   * Send a test notification to the webhook endpoint
   * @param {object} payload - The notification payload
   * @param {string} type - The notification type
   * @returns {Promise<object>} - The response
   */
  async sendNotification(payload, type = 'notification') {
    try {
      // Convert payload to string
      const stringPayload = JSON.stringify(payload);
      
      // Sign the message
      const signature = this.signMessage(this.messageId, this.timestamp, stringPayload);
      
      // Set up headers like Twitch would
      const headers = {
        'Content-Type': 'application/json',
        'Twitch-Eventsub-Message-Id': this.messageId,
        'Twitch-Eventsub-Message-Timestamp': this.timestamp,
        'Twitch-Eventsub-Message-Signature': signature,
        'Twitch-Eventsub-Message-Type': type,
        'Twitch-Eventsub-Subscription-Version': '1'
      };
      
      logger.log("Twitch Tester", `Sending ${payload.subscription.type} test notification to ${this.webhookUrl}`);
      
      // Send the request
      const response = await axios.post(this.webhookUrl, payload, { headers });
      
      return {
        success: true,
        status: response.status,
        statusText: response.statusText,
        data: response.data,
        messageSent: payload
      };
    } catch (error) {
      logger.error("Twitch Tester", `Error sending notification: ${error.message}`);
      return {
        success: false,
        error: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        messageSent: payload
      };
    }
  }

  /**
   * Test a follow event
   * @param {object} options - Additional options
   * @returns {Promise<object>} - The response
   */
  async testFollow(options = {}) {
    const followerName = options.followerName || 'TestFollower';
    const followerId = options.followerId || '987654321';
    
    const payload = {
      subscription: {
        id: crypto.randomUUID(),
        type: 'channel.follow',
        version: '2',
        status: 'enabled',
        cost: 1,
        condition: {
          broadcaster_user_id: this.twitchUserId,
          moderator_user_id: this.twitchUserId
        },
        transport: {
          method: 'webhook',
          callback: 'https://example.com/webhook'
        },
        created_at: new Date().toISOString()
      },
      event: {
        user_id: followerId,
        user_name: followerName,
        user_login: followerName.toLowerCase(),
        broadcaster_user_id: this.twitchUserId,
        broadcaster_user_name: this.twitchUserName,
        broadcaster_user_login: this.twitchUserName.toLowerCase(),
        followed_at: new Date().toISOString()
      }
    };
    
    return this.sendNotification(payload);
  }

  /**
   * Test a chat message event
   * @param {object} options - Additional options
   * @returns {Promise<object>} - The response
   */
  async testChatMessage(options = {}) {
    const chatterName = options.chatterName || 'TestChatter';
    const chatterId = options.chatterId || '123456789';
    const message = options.message || `Hello @${this.twitchUserName}, this is a test message!`;
    const isFirstMessage = options.isFirstMessage || false;
    
    const payload = {
      subscription: {
        id: crypto.randomUUID(),
        type: 'channel.chat.message',
        version: '1',
        status: 'enabled',
        cost: 1,
        condition: {
          broadcaster_user_id: this.twitchUserId,
          user_id: chatterId
        },
        transport: {
          method: 'webhook',
          callback: 'https://example.com/webhook'
        },
        created_at: new Date().toISOString()
      },
      event: {
        broadcaster_user_id: this.twitchUserId,
        broadcaster_user_login: this.twitchUserName.toLowerCase(),
        broadcaster_user_name: this.twitchUserName,
        chatter: {
          user_id: chatterId,
          user_login: chatterName.toLowerCase(),
          user_name: chatterName,
          color: "#FF0000",
          badges: []
        },
        message: {
          text: message,
          fragments: [
            {
              type: "text",
              text: message,
              cheermote: null
            }
          ],
          is_first: isFirstMessage
        },
        sent_at: new Date().toISOString()
      }
    };
    
    return this.sendNotification(payload);
  }

  /**
   * Test a subscription event
   * @param {object} options - Additional options
   * @returns {Promise<object>} - The response
   */
  async testSubscription(options = {}) {
    const subscriberName = options.subscriberName || 'TestSubscriber';
    const subscriberId = options.subscriberId || '123456789';
    const tier = options.tier || '1000';
    const isGift = options.isGift || false;
    
    const payload = {
      subscription: {
        id: crypto.randomUUID(),
        type: 'channel.subscribe',
        version: '1',
        status: 'enabled',
        cost: 1,
        condition: {
          broadcaster_user_id: this.twitchUserId
        },
        transport: {
          method: 'webhook',
          callback: 'https://example.com/webhook'
        },
        created_at: new Date().toISOString()
      },
      event: {
        user_id: subscriberId,
        user_login: subscriberName.toLowerCase(),
        user_name: subscriberName,
        broadcaster_user_id: this.twitchUserId,
        broadcaster_user_login: this.twitchUserName.toLowerCase(),
        broadcaster_user_name: this.twitchUserName,
        tier: tier,
        is_gift: isGift
      }
    };
    
    return this.sendNotification(payload);
  }

  /**
   * Test a stream online event
   * @param {object} options - Additional options
   * @returns {Promise<object>} - The response
   */
  async testStreamOnline(options = {}) {
    const streamType = options.streamType || 'live';
    
    const payload = {
      subscription: {
        id: crypto.randomUUID(),
        type: 'stream.online',
        version: '1',
        status: 'enabled',
        cost: 1,
        condition: {
          broadcaster_user_id: this.twitchUserId
        },
        transport: {
          method: 'webhook',
          callback: 'https://example.com/webhook'
        },
        created_at: new Date().toISOString()
      },
      event: {
        id: crypto.randomUUID(),
        broadcaster_user_id: this.twitchUserId,
        broadcaster_user_login: this.twitchUserName.toLowerCase(),
        broadcaster_user_name: this.twitchUserName,
        type: streamType,
        started_at: new Date().toISOString()
      }
    };
    
    return this.sendNotification(payload);
  }

  /**
   * Test a channel update event
   * @param {object} options - Additional options
   * @returns {Promise<object>} - The response
   */
  async testChannelUpdate(options = {}) {
    const title = options.title || 'Test Stream Title';
    const categoryName = options.categoryName || 'Just Chatting';
    const categoryId = options.categoryId || '509658';
    
    const payload = {
      subscription: {
        id: crypto.randomUUID(),
        type: 'channel.update',
        version: '1',
        status: 'enabled',
        cost: 1,
        condition: {
          broadcaster_user_id: this.twitchUserId
        },
        transport: {
          method: 'webhook',
          callback: 'https://example.com/webhook'
        },
        created_at: new Date().toISOString()
      },
      event: {
        broadcaster_user_id: this.twitchUserId,
        broadcaster_user_login: this.twitchUserName.toLowerCase(),
        broadcaster_user_name: this.twitchUserName,
        title: title,
        language: 'en',
        category_id: categoryId,
        category_name: categoryName,
        is_mature: false
      }
    };
    
    return this.sendNotification(payload);
  }

  /**
   * Test a raid event
   * @param {object} options - Additional options
   * @returns {Promise<object>} - The response
   */
  async testRaid(options = {}) {
    const raiderName = options.raiderName || 'TestRaider';
    const raiderId = options.raiderId || '987654321';
    const viewers = options.viewers || 42;
    
    const payload = {
      subscription: {
        id: crypto.randomUUID(),
        type: 'channel.raid',
        version: '1',
        status: 'enabled',
        cost: 1,
        condition: {
          to_broadcaster_user_id: this.twitchUserId
        },
        transport: {
          method: 'webhook',
          callback: 'https://example.com/webhook'
        },
        created_at: new Date().toISOString()
      },
      event: {
        from_broadcaster_user_id: raiderId,
        from_broadcaster_user_login: raiderName.toLowerCase(),
        from_broadcaster_user_name: raiderName,
        to_broadcaster_user_id: this.twitchUserId,
        to_broadcaster_user_login: this.twitchUserName.toLowerCase(),
        to_broadcaster_user_name: this.twitchUserName,
        viewers: viewers
      }
    };
    
    return this.sendNotification(payload);
  }
}

/**
 * Command-line interface to test Twitch webhooks
 */
async function runCLI() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  
  // Show help if no args or help requested
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Twitch EventSub Webhook Tester
==============================

Usage: node twitch-webhook-tester.js <command> <userId> [options]

Commands:
  follow        Test a channel.follow event
  chat          Test a channel.chat.message event
  sub           Test a channel.subscribe event
  online        Test a stream.online event
  update        Test a channel.update event
  raid          Test a channel.raid event

Options:
  --help, -h    Show this help message
  --firstmsg    For chat messages, mark as first message from user
  --message     Custom message for chat events
  --name        Custom name for the event source (follower, subscriber, etc.)
  --viewers     Number of viewers for raid events
  --title       Stream title for channel update events
  --game        Game/category name for channel update events

Example:
  node twitch-webhook-tester.js chat my_user_id --message "Hello @streamer!" --name "TestUser"
  node twitch-webhook-tester.js follow my_user_id --name "NewFollower123"
  node twitch-webhook-tester.js raid my_user_id --name "RaidingChannel" --viewers 100
    `);
    return;
  }

  // Extract command and userId
  const [command, userId] = args;
  
  // Parse options
  const options = {};
  for (let i = 2; i < args.length; i += 2) {
    if (args[i].startsWith('--')) {
      const key = args[i].substring(2);
      const value = args[i + 1];
      
      // Handle boolean flags (no value)
      if (!value || value.startsWith('--')) {
        options[key] = true;
        i -= 1; // Adjust index since we didn't consume a value
      } else {
        options[key] = value;
      }
    }
  }
  
  // Map some options to expected property names
  if (options.name) {
    if (command === 'follow') options.followerName = options.name;
    if (command === 'chat') options.chatterName = options.name;
    if (command === 'sub') options.subscriberName = options.name;
    if (command === 'raid') options.raiderName = options.name;
  }
  
  if (options.game) options.categoryName = options.game;
  if (options.firstmsg) options.isFirstMessage = true;
  
  // Initialize tester
  const tester = new TwitchWebhookTester();
  const initSuccess = await tester.initialize(userId);
  
  if (!initSuccess) {
    console.log('Failed to initialize webhook tester. Check logs for details.');
    return;
  }
  
  // Execute the specified command
  let result;
  switch (command) {
    case 'follow':
      result = await tester.testFollow(options);
      break;
    case 'chat':
      result = await tester.testChatMessage(options);
      break;
    case 'sub':
      result = await tester.testSubscription(options);
      break;
    case 'online':
      result = await tester.testStreamOnline(options);
      break;
    case 'update':
      result = await tester.testChannelUpdate(options);
      break;
    case 'raid':
      result = await tester.testRaid(options);
      break;
    default:
      console.log(`Unknown command: ${command}`);
      return;
  }
  
  if (result.success) {
    console.log(`✅ Successfully sent ${command} test event`);
    console.log(`Status: ${result.status} ${result.statusText}`);
  } else {
    console.log(`❌ Failed to send ${command} test event`);
    console.log(`Error: ${result.error}`);
    if (result.status) {
      console.log(`Status: ${result.status} ${result.statusText}`);
    }
  }
}

// If this file is run directly, execute the CLI
if (import.meta.url === import.meta.resolve('./twitch-webhook-tester.js')) {
  runCLI();
}

export default TwitchWebhookTester;