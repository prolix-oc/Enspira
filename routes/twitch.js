// routes/twitch.js
import crypto from "crypto";
import { retrieveConfigValue } from "../config-helper.js";
import { returnAuthObject, updateUserParameter } from "../api-helper.js";
import { logger } from "../create-global-logger.js";

// Notification request headers
const TWITCH_MESSAGE_ID = "twitch-eventsub-message-id";
const TWITCH_MESSAGE_TIMESTAMP = "twitch-eventsub-message-timestamp";
const TWITCH_MESSAGE_SIGNATURE = "twitch-eventsub-message-signature";
const MESSAGE_TYPE = "twitch-eventsub-message-type";

// Notification message types
const MESSAGE_TYPE_VERIFICATION = "webhook_callback_verification";
const MESSAGE_TYPE_NOTIFICATION = "notification";
const MESSAGE_TYPE_REVOCATION = "revocation";

// Prepend this string to the HMAC that's created from the message
const HMAC_PREFIX = "sha256=";

async function getWebhookSecret(userId) {
  try {
    const user = await returnAuthObject(userId);

    // Check if user has webhook secret
    if (
      !user ||
      !user.twitch_tokens ||
      !user.twitch_tokens.streamer ||
      !user.twitch_tokens.streamer.webhook_secret
    ) {
      logger.log(
        "Twitch",
        `No webhook secret found for user ${userId}, generating temporary one`
      );

      // If there's no webhook secret, we should create one for future use
      // But for this verification, we'll return a dummy one that will fail verification
      if (user && user.twitch_tokens && user.twitch_tokens.streamer) {
        const newSecret = crypto.randomBytes(32).toString("hex");

        // Try to ensure path exists and set the webhook secret
        await ensureParameterPath(userId, "twitch_tokens.streamer");
        await updateUserParameter(
          userId,
          "twitch_tokens.streamer.webhook_secret",
          newSecret
        );

        // Log but still return a dummy secret for this verification
        logger.log(
          "Twitch",
          `Generated new webhook secret for future use, but current verification will fail`
        );
      }

      // Return a dummy secret that will cause verification to fail (this is intentional)
      return "invalid-verification-will-fail";
    }

    // Return the actual webhook secret
    return user.twitch_tokens.streamer.webhook_secret;
  } catch (error) {
    logger.error("Twitch", `Error getting webhook secret: ${error.message}`);
    // Return a dummy secret that will cause verification to fail
    return "error-getting-secret";
  }
}

async function twitchEventSubRoutes(fastify, options) {
  // Configure the raw body parser specifically for this route
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      done(null, body);
    }
  );

  // Helper functions for EventSub signature verification
  const getSecret = async (userId) => {
    // Get the secret from configuration
    try {
      const user = await returnAuthObject(userId);
      if (!user || !user.twitch_tokens || !user.twitch_tokens.webhook_secret) {
        logger.error("Twitch", `No webhook secret found for user ${userId}`);
        return null;
      }
      return user.twitch_tokens.webhook_secret;
    } catch (error) {
      logger.error("Twitch", `Error getting webhook secret: ${error.message}`);
      return null;
    }
  };

  const getHmacMessage = (headers, body) => {
    if (!headers || !body) {
      logger.error("Twitch", "Missing headers or body for HMAC calculation");
      return "";
    }

    const messageId = headers[TWITCH_MESSAGE_ID];
    const timestamp = headers[TWITCH_MESSAGE_TIMESTAMP];

    if (!messageId || !timestamp) {
      logger.error("Twitch", "Missing required headers for HMAC calculation");
      return "";
    }

    return messageId + timestamp + body;
  };

  const getHmac = (secret, message) => {
    if (!secret || !message) {
      logger.error("Twitch", "Missing secret or message for HMAC calculation");
      return "";
    }

    return crypto.createHmac("sha256", secret).update(message).digest("hex");
  };

  const verifyMessage = (hmac, verifySignature) => {
    try {
      return crypto.timingSafeEqual(
        Buffer.from(hmac),
        Buffer.from(verifySignature)
      );
    } catch (error) {
      logger.error("Twitch", `Error verifying signature: ${error.message}`);
      return false;
    }
  };

  // Test webhook endpoint for simulating Twitch events
  fastify.post("/eventsub/test/:userId", async (request, reply) => {
    try {
      const { userId } = request.params;
      const { eventType, eventData, eventVersion = "1" } = request.body;

      // Validate required parameters

      logger.log(
        "Twitch",
        `Processing test ${eventType} event for user ${userId}`
      );

      // Import the event processor
      const { processEventSubNotification } = await import(
        "../twitch-eventsub-manager.js"
      );

      // Process the event using the existing event processor
      const result = await processEventSubNotification(
        eventType,
        eventData,
        userId,
        eventVersion
      );

      return reply.send({
        success: true,
        eventType,
        userId,
        result,
      });
    } catch (error) {
      logger.error("Twitch", `Error processing test event: ${error.message}`);
      return reply.code(500).send({ error: error.message });
    }
  });
  fastify.get("/eventsub/test/examples/:eventType", async (request, reply) => {
    const { eventType } = request.params;

    // Import user object to get broadcaster ID if needed
    const { returnAuthObject } = await import("../api-helper.js");

    // Get user ID from query param or use a default
    const userId = request.query.userId || "default_user_id";

    // Try to get user details to populate broadcaster information
    let userObj;
    try {
      userObj = await returnAuthObject(userId);
    } catch (error) {
      logger.warn(
        "Twitch",
        `Could not get user object for ${userId}: ${error.message}`
      );
    }

    const broadcasterId =
      userObj?.twitch_tokens?.streamer?.twitch_user_id || "123456789";
    const broadcasterName = userObj?.twitch_name || "TestStreamer";

    const examples = {
      "channel.follow": {
        eventType: "channel.follow",
        eventData: {
          user_name: "TestFollower",
          user_id: "987654321",
          broadcaster_user_id: broadcasterId,
          broadcaster_user_name: broadcasterName,
          followed_at: new Date().toISOString(),
        },
        eventVersion: "2",
      },
      "channel.subscribe": {
        eventType: "channel.subscribe",
        eventData: {
          user_name: "TestSubscriber",
          user_id: "987654321",
          broadcaster_user_id: broadcasterId,
          broadcaster_user_name: broadcasterName,
          tier: "1000",
          is_gift: false,
        },
        eventVersion: "1",
      },
      "channel.subscription.gift": {
        eventType: "channel.subscription.gift",
        eventData: {
          user_name: "TestGifter",
          user_id: "987654321",
          broadcaster_user_id: broadcasterId,
          broadcaster_user_name: broadcasterName,
          tier: "1000",
          is_anonymous: false,
          recipient_user_name: "GiftRecipient",
          recipient_user_id: "456789123",
          total: 1,
        },
        eventVersion: "1",
      },
      "channel.raid": {
        eventType: "channel.raid",
        eventData: {
          from_broadcaster_user_id: "987654321",
          from_broadcaster_user_name: "TestRaider",
          to_broadcaster_user_id: broadcasterId,
          to_broadcaster_user_name: broadcasterName,
          viewers: 42,
        },
        eventVersion: "1",
      },
      "channel.chat.message": {
        eventType: "channel.chat.message",
        eventData: {
          broadcaster_user_id: broadcasterId,
          broadcaster_user_name: broadcasterName,
          chatter: {
            user_id: "987654321",
            user_name: "TestChatter",
            badges: [{ set_id: "subscriber", version: "1" }],
          },
          message: {
            text: "This is a test message! @" + broadcasterName,
            is_first: false,
            fragments: [
              {
                type: "text",
                text: "This is a test message! @" + broadcasterName,
              },
            ],
          },
        },
        eventVersion: "1",
      },
    };

    if (!examples[eventType]) {
      return reply.code(404).send({
        error: "Event type not found",
        availableTypes: Object.keys(examples),
      });
    }

    return reply.send(examples[eventType]);
  });

  // List current EventSub subscriptions
  fastify.get("/subscriptions/:userId", async (request, reply) => {
    const { userId } = request.params;

    try {
      const user = await returnAuthObject(userId);

      if (!user || !user.twitch_tokens || !user.twitch_tokens.access_token) {
        return reply
          .code(400)
          .send({ error: "User has no Twitch integration" });
      }

      // Get subscriptions from Twitch API
      const response = await axios.get(
        "https://api.twitch.tv/helix/eventsub/subscriptions",
        {
          headers: {
            "Client-ID": await retrieveConfigValue("twitch.clientId"),
            Authorization: `Bearer ${user.twitch_tokens.access_token}`,
          },
        }
      );

      return {
        success: true,
        subscriptions: response.data.data,
        total: response.data.total,
        max: response.data.max_total_cost,
      };
    } catch (error) {
      logger.error("Twitch", `Error listing subscriptions: ${error.message}`);
      return reply.code(500).send({ error: error.message });
    }
  });

  // Manually register all EventSub for a user
  fastify.post("/subscriptions/register/:userId", async (request, reply) => {
    const { userId } = request.params;

    try {
      // Import registration function
      const { registerUserSubscriptions } = await import(
        "../twitch-eventsub-manager.js"
      );

      // Register subscriptions
      const result = await registerUserSubscriptions(userId);

      return {
        success: result.success,
        created: result.created,
        skipped: result.skipped,
        error: result.error,
      };
    } catch (error) {
      logger.error(
        "Twitch",
        `Error registering subscriptions: ${error.message}`
      );
      return reply.code(500).send({ error: error.message });
    }
  });

  // Route to handle EventSub notifications
  fastify.post("/eventsub/:userId", async (request, reply) => {
    const { userId } = request.params;

    if (!userId) {
      logger.error("Twitch", "No userId provided in EventSub webhook URL");
      return reply.code(400).send({ error: "Missing userId parameter" });
    }

    // Get the webhook secret for this user
    const secret = await getWebhookSecret(userId);

    // Get and verify the signature
    const headers = request.headers;
    const rawBody = request.body;

    try {
      // Calculate the expected signature
      const message = getHmacMessage(headers, rawBody);
      const hmac = HMAC_PREFIX + getHmac(secret, message);

      // Verify the request is actually from Twitch
      if (!verifyMessage(hmac, headers[TWITCH_MESSAGE_SIGNATURE])) {
        logger.error("Twitch", "EventSub signature verification failed");

        // If the secret was a dummy one, it means we don't have a valid webhook secret
        if (
          secret === "invalid-verification-will-fail" ||
          secret === "error-getting-secret"
        ) {
          logger.error(
            "Twitch",
            `Invalid webhook secret for user ${userId}, verification was expected to fail`
          );

          // Register EventSub for this user to generate a valid webhook secret for next time
          const { registerUserSubscriptions } = await import(
            "../twitch-eventsub-manager.js"
          );
          registerUserSubscriptions(userId).catch((err) => {
            logger.error(
              "Twitch",
              `Failed to register EventSub subscriptions: ${err.message}`
            );
          });
        }

        return reply.code(403).send({ error: "Signature verification failed" });
      }

      // Signature verified, process the notification
      const notification = JSON.parse(rawBody.toString());
      const messageType = headers[MESSAGE_TYPE];

      // Handle different message types
      if (messageType === MESSAGE_TYPE_NOTIFICATION) {
        // Process the event
        await processEvent(notification, userId);
        return reply.code(204).send();
      } else if (messageType === MESSAGE_TYPE_VERIFICATION) {
        // Respond to webhook verification challenge
        logger.log(
          "Twitch",
          `EventSub verification received for user ${userId}`
        );
        return reply.code(200).type("text/plain").send(notification.challenge);
      } else if (messageType === MESSAGE_TYPE_REVOCATION) {
        // Handle subscription revocation
        logger.log(
          "Twitch",
          `EventSub ${notification.subscription.type} notifications revoked for user ${userId}`
        );
        logger.log("Twitch", `Reason: ${notification.subscription.status}`);

        // Update user's subscription status
        await handleEventSubRevocation(notification, userId);
        return reply.code(204).send();
      } else {
        logger.log("Twitch", `Unknown message type: ${messageType}`);
        return reply.code(204).send();
      }
    } catch (error) {
      logger.error(
        "Twitch",
        `Error processing EventSub notification: ${error.message}`
      );
      return reply.code(500).send({ error: "Internal server error" });
    }
  });

  fastify.post("/eventsub/register/:userId", async (request, reply) => {
    const { userId } = request.params;

    try {
      // Import registration function
      const { registerUserSubscriptions } = await import(
        "../twitch-eventsub-manager.js"
      );

      // Register subscriptions
      const result = await registerUserSubscriptions(userId);

      return {
        success: result.success,
        created: result.created,
        skipped: result.skipped,
        error: result.error,
      };
    } catch (error) {
      logger.error(
        "Twitch",
        `Error registering subscriptions: ${error.message}`
      );
      return reply.code(500).send({ error: error.message });
    }
  });

  fastify.get("/eventsub/subscriptions/:userId", async (request, reply) => {
    const { userId } = request.params;

    try {
      const user = await returnAuthObject(userId);

      if (!user || !user.twitch_tokens?.streamer?.access_token) {
        return reply
          .code(400)
          .send({ error: "User has no Twitch integration" });
      }

      // Import axios if needed
      const axios = (await import("axios")).default;

      // Get subscriptions from Twitch API
      const response = await axios.get(
        "https://api.twitch.tv/helix/eventsub/subscriptions",
        {
          headers: {
            "Client-ID": await retrieveConfigValue("twitch.clientId"),
            Authorization: `Bearer ${user.twitch_tokens.streamer.access_token}`,
          },
        }
      );

      return {
        success: true,
        subscriptions: response.data.data,
        total: response.data.total,
        max: response.data.max_total_cost,
      };
    } catch (error) {
      logger.error("Twitch", `Error listing subscriptions: ${error.message}`);
      return reply.code(500).send({ error: error.message });
    }
  });

  // EventSub subscription management endpoint
  fastify.post("/eventsub/subscribe", async (request, reply) => {
    const { userId, type, condition } = request.body;

    if (!userId || !type) {
      return reply.code(400).send({ error: "Missing required parameters" });
    }

    try {
      const result = await subscribeToEvent(userId, type, condition);
      return reply.send(result);
    } catch (error) {
      logger.error("Twitch", `Error subscribing to event: ${error.message}`);
      return reply.code(500).send({ error: error.message });
    }
  });
}

// Function to subscribe to EventSub events
async function subscribeToEvent(userId, type, condition = {}) {
  try {
    const user = await returnAuthObject(userId);

    if (!user) {
      throw new Error("User not found");
    }

    // Generate a new secret if one doesn't exist
    if (!user.twitch_tokens?.streamer?.webhook_secret) {
      const newSecret = crypto.randomBytes(32).toString("hex");

      // Ensure the path exists
      await ensureParameterPath(userId, "twitch_tokens.streamer");

      // Save the new secret
      await updateUserParameter(
        userId,
        "twitch_tokens.streamer.webhook_secret",
        newSecret
      );
    }

    // Default condition uses the broadcaster's ID
    if (Object.keys(condition).length === 0) {
      if (!user.twitch_tokens?.streamer?.twitch_user_id) {
        throw new Error("No broadcaster user ID available");
      }
      condition = {
        broadcaster_user_id: user.twitch_tokens.streamer.twitch_user_id,
      };
    }

    // Import needed functions
    const { getAppAccessToken } = await import("../twitch-eventsub-manager.js");
    const appToken = await getAppAccessToken();

    // Prepare the subscription payload
    const callbackUrl = `${await retrieveConfigValue("server.endpoints.external")}/api/v1/twitch/eventsub/${userId}`;

    // Get fresh user data to ensure we have the webhook secret
    const freshUser = await returnAuthObject(userId);

    const subscriptionBody = {
      type,
      version: "1",
      condition,
      transport: {
        method: "webhook",
        callback: callbackUrl,
        secret: freshUser.twitch_tokens.streamer.webhook_secret,
      },
    };

    // Make the API request to create the subscription
    const axios = (await import("axios")).default;
    const response = await axios.post(
      "https://api.twitch.tv/helix/eventsub/subscriptions",
      subscriptionBody,
      {
        headers: {
          "Client-ID": await retrieveConfigValue("twitch.clientId"),
          Authorization: `Bearer ${appToken}`, // Use app token here
          "Content-Type": "application/json",
        },
      }
    );

    // Save subscription ID in user's data
    const subscriptionId = response.data.data[0].id;

    // Update user's subscriptions list
    const subscriptions = freshUser.twitch_tokens.streamer.subscriptions || [];
    subscriptions.push({
      id: subscriptionId,
      type,
      created_at: new Date().toISOString(),
    });

    await updateUserParameter(
      userId,
      "twitch_tokens.streamer.subscriptions",
      subscriptions
    );

    logger.log(
      "Twitch",
      `Created EventSub subscription for ${userId}: ${type}`
    );

    return {
      success: true,
      subscription: response.data.data[0],
    };
  } catch (error) {
    logger.error("Twitch", `Failed to create subscription: ${error.message}`);
    throw error;
  }
}

// Handle EventSub revocation
async function handleEventSubRevocation(notification, userId) {
  try {
    const subscriptionId = notification.subscription.id;

    if (!userId || !subscriptionId) {
      logger.error("Twitch", "Missing userId or subscriptionId for revocation");
      return;
    }

    const user = await returnAuthObject(userId);

    if (!user || !user.twitch_tokens?.streamer?.subscriptions) {
      logger.error("Twitch", `No subscriptions found for user ${userId}`);
      return;
    }

    // Filter out the revoked subscription
    const subscriptions = user.twitch_tokens.streamer.subscriptions.filter(
      (sub) => sub.id !== subscriptionId
    );

    // Update the subscriptions list
    await updateUserParameter(
      userId,
      "twitch_tokens.streamer.subscriptions",
      subscriptions
    );

    logger.log(
      "Twitch",
      `Removed revoked subscription ${subscriptionId} for user ${userId}`
    );
  } catch (error) {
    logger.error("Twitch", `Error handling revocation: ${error.message}`);
  }
}

async function processEvent(notification, userId) {
  try {
    const eventType = notification.subscription.type;
    const eventVersion = notification.subscription.version || "1";
    const event = notification.event;

    // Log the event
    logger.log(
      "Twitch",
      `Processing ${eventType} (v${eventVersion}) event for user ${userId}`
    );

    // Import the event processor from the manager
    const { processEventSubNotification } = await import(
      "../twitch-eventsub-manager.js"
    );

    // Process based on the event type
    return await processEventSubNotification(
      eventType,
      event,
      userId,
      eventVersion
    );
  } catch (error) {
    logger.error("Twitch", `Error processing event: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export default twitchEventSubRoutes;
