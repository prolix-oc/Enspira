// src/routes/twitch.ts
import crypto from 'crypto';
import { retrieveConfigValue } from '../core/config.js';
import {
  returnAuthObject,
  updateUserParameter,
  ensureParameterPath,
} from '../core/api-helper.js';
import { logger } from '../core/logger.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { User } from '../types/user.types.js';
import type {
  UserIdParams,
  EventTypeParams,
  HealthCheckQuery,
  TestEventBody,
  SubscribeEventBody,
  EventSubNotification,
  EventSubHealthResult,
} from '../types/routes.types.js';

// Notification request headers
const TWITCH_MESSAGE_ID = 'twitch-eventsub-message-id';
const TWITCH_MESSAGE_TIMESTAMP = 'twitch-eventsub-message-timestamp';
const TWITCH_MESSAGE_SIGNATURE = 'twitch-eventsub-message-signature';
const MESSAGE_TYPE = 'twitch-eventsub-message-type';

// Notification message types
const MESSAGE_TYPE_VERIFICATION = 'webhook_callback_verification';
const MESSAGE_TYPE_NOTIFICATION = 'notification';
const MESSAGE_TYPE_REVOCATION = 'revocation';

// Prepend this string to the HMAC that's created from the message
const HMAC_PREFIX = 'sha256=';

async function getWebhookSecret(userId: string): Promise<string> {
  try {
    const user = await returnAuthObject(userId);

    // Check if user has webhook secret
    if (
      !user ||
      !user.twitch_tokens ||
      !user.twitch_tokens.streamer ||
      !user.twitch_tokens.streamer.webhook_secret
    ) {
      logger.log('Twitch', `No webhook secret found for user ${userId}, generating temporary one`);

      // If there's no webhook secret, we should create one for future use
      // But for this verification, we'll return a dummy one that will fail verification
      if (user && user.twitch_tokens && user.twitch_tokens.streamer) {
        const newSecret = crypto.randomBytes(32).toString('hex');

        // Try to ensure path exists and set the webhook secret
        await ensureParameterPath(userId, 'twitch_tokens.streamer');
        await updateUserParameter(userId, 'twitch_tokens.streamer.webhook_secret', newSecret);

        // Log but still return a dummy secret for this verification
        logger.log(
          'Twitch',
          `Generated new webhook secret for future use, but current verification will fail`
        );
      }

      // Return a dummy secret that will cause verification to fail (this is intentional)
      return 'invalid-verification-will-fail';
    }

    // Return the actual webhook secret
    return user.twitch_tokens.streamer.webhook_secret;
  } catch (error) {
    const err = error as Error;
    logger.error('Twitch', `Error getting webhook secret: ${err.message}`);
    // Return a dummy secret that will cause verification to fail
    return 'error-getting-secret';
  }
}

async function twitchEventSubRoutes(fastify: FastifyInstance, _options: unknown): Promise<void> {
  // Configure the raw body parser specifically for this route
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      done(null, body);
    }
  );

  // Health and diagnostic endpoint for EventSub troubleshooting
  fastify.get<{ Querystring: HealthCheckQuery }>(
    '/health',
    async (request, reply) => {
      try {
        const detailed = request.query.detailed === 'true';
        const userId = request.query.userId;

        const { getAppAccessToken } = await import('../integrations/twitch/eventsub.js');
        const axios = (await import('axios')).default;

        const health: EventSubHealthResult = {
          timestamp: new Date().toISOString(),
          overall: 'healthy',
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage(),
          twitch: {
            events: {
              eventsProcessed: 0,
              successRate: '100%',
              averageResponseTime: 0,
              chatMessagesProcessed: 0,
            },
          },
        };

        // Check if we can get an app token
        try {
          const appToken = await getAppAccessToken();
          health.twitch.appTokenValid = !!appToken;
        } catch (error) {
          const err = error as Error;
          health.twitch.appTokenValid = false;
          health.twitch.appTokenError = err.message;
          health.overall = 'degraded';
        }

        // Check external endpoint configuration
        const externalEndpoint = await retrieveConfigValue<string>('server.endpoints.external');
        health.twitch.externalEndpoint = externalEndpoint || undefined;
        health.twitch.externalEndpointIssues = [];

        if (!externalEndpoint) {
          health.twitch.externalEndpointIssues.push('External endpoint not configured');
          health.overall = 'unhealthy';
        } else {
          if (externalEndpoint.startsWith('http://')) {
            health.twitch.externalEndpointIssues.push(
              'External endpoint uses HTTP - Twitch requires HTTPS for webhooks'
            );
            health.overall = 'unhealthy';
          }
          if (externalEndpoint.includes('localhost') || externalEndpoint.includes('127.0.0.1')) {
            health.twitch.externalEndpointIssues.push(
              'External endpoint uses localhost - Twitch cannot reach this address'
            );
            health.overall = 'unhealthy';
          }
        }

        if (detailed) {
          // Fetch all subscriptions from Twitch to check their status
          try {
            const appToken = await getAppAccessToken();
            const clientId = await retrieveConfigValue<string>('twitch.clientId');

            const response = await axios.get(
              'https://api.twitch.tv/helix/eventsub/subscriptions',
              {
                headers: {
                  'Client-ID': clientId,
                  Authorization: `Bearer ${appToken}`,
                },
                timeout: 10000,
              }
            );

            const allSubs = response.data.data || [];

            // Group subscriptions by status
            const statusCounts: Record<string, number> = {};
            const problemSubs: Array<{
              type: string;
              status: string;
              condition: Record<string, string>;
              createdAt: string;
            }> = [];

            for (const sub of allSubs) {
              statusCounts[sub.status] = (statusCounts[sub.status] || 0) + 1;

              // Track problematic subscriptions
              if (sub.status !== 'enabled') {
                problemSubs.push({
                  type: sub.type,
                  status: sub.status,
                  condition: sub.condition,
                  createdAt: sub.created_at,
                });
              }
            }

            health.twitch.subscriptions = {
              total: allSubs.length,
              byStatus: statusCounts,
              maxAllowed: response.data.max_total_cost,
              currentCost: response.data.total_cost,
              problemSubscriptions: problemSubs.slice(0, 10),
            };

            // Check for common issues
            const subs = health.twitch.subscriptions!;
            const warnings: string[] = [];
            const errors: string[] = [];

            const pendingCount = statusCounts['webhook_callback_verification_pending'] ?? 0;
            const failedCount = statusCounts['webhook_callback_verification_failed'] ?? 0;
            const revokedCount = statusCounts['authorization_revoked'] ?? 0;
            const failuresExceeded = statusCounts['notification_failures_exceeded'] ?? 0;

            if (pendingCount > 0) {
              warnings.push(
                `${pendingCount} subscription(s) pending verification - Twitch may not be able to reach your callback URL`
              );
              health.overall = 'degraded';
            }

            if (failedCount > 0) {
              errors.push(
                `${failedCount} subscription(s) failed verification - Check your external endpoint and SSL certificate`
              );
              health.overall = 'unhealthy';
            }

            if (revokedCount > 0) {
              errors.push(
                `${revokedCount} subscription(s) have revoked authorization - Users may need to re-authorize`
              );
            }

            if (failuresExceeded > 0) {
              errors.push(
                `${failuresExceeded} subscription(s) exceeded notification failures - Webhooks are not being received`
              );
              health.overall = 'unhealthy';
            }

            if (warnings.length > 0) subs.warnings = warnings;
            if (errors.length > 0) subs.errors = errors;
          } catch (error) {
            const err = error as Error;
            health.twitch.subscriptions = {
              total: 0,
              byStatus: {},
              maxAllowed: 0,
              currentCost: 0,
              problemSubscriptions: [],
              error: err.message,
              hint: 'Could not fetch subscriptions from Twitch API',
            };
          }

          // If specific userId provided, show their subscription details
          if (userId) {
            try {
              const user = await returnAuthObject(userId);

              health.twitch.userDetails = {
                userId,
                hasStreamerToken: !!user?.twitch_tokens?.streamer?.access_token,
                hasBotToken: !!user?.twitch_tokens?.bot?.access_token,
                hasWebhookSecret: !!user?.twitch_tokens?.streamer?.webhook_secret,
                twitchUserId: user?.twitch_tokens?.streamer?.twitch_user_id || null,
                callbackUrl: `${externalEndpoint}/api/v1/twitch/eventsub/${userId}`,
                storedSubscriptions: user?.twitch_tokens?.streamer?.subscriptions?.length || 0,
              };
            } catch (error) {
              const err = error as Error;
              health.twitch.userDetails = {
                userId,
                hasStreamerToken: false,
                hasBotToken: false,
                hasWebhookSecret: false,
                twitchUserId: null,
                callbackUrl: '',
                storedSubscriptions: 0,
                error: err.message,
              };
            }
          }
        }

        return reply.send(health);
      } catch (error) {
        const err = error as Error;
        logger.error('Twitch', `Health check error: ${err.message}`);
        return reply.code(500).send({
          overall: 'error',
          error: err.message,
        });
      }
    }
  );

  const getHmacMessage = (
    headers: Record<string, string | string[] | undefined>,
    body: Buffer | string
  ): string => {
    if (!headers || !body) {
      logger.error('Twitch', 'Missing headers or body for HMAC calculation');
      return '';
    }

    const messageId = headers[TWITCH_MESSAGE_ID] as string;
    const timestamp = headers[TWITCH_MESSAGE_TIMESTAMP] as string;

    if (!messageId || !timestamp) {
      logger.error('Twitch', 'Missing required headers for HMAC calculation');
      return '';
    }

    return messageId + timestamp + body.toString();
  };

  const getHmac = (secret: string, message: string): string => {
    if (!secret || !message) {
      logger.error('Twitch', 'Missing secret or message for HMAC calculation');
      return '';
    }

    return crypto.createHmac('sha256', secret).update(message).digest('hex');
  };

  const verifyMessage = (hmac: string, verifySignature: string): boolean => {
    try {
      return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(verifySignature));
    } catch (error) {
      const err = error as Error;
      logger.error('Twitch', `Error verifying signature: ${err.message}`);
      return false;
    }
  };

  // Subscription status endpoint - shows detailed status of all subscriptions
  fastify.get<{ Params: UserIdParams }>(
    '/eventsub/status/:userId',
    async (request, reply) => {
      try {
        const { userId } = request.params;

        const { getSubscriptionStatus } = await import('../integrations/twitch/eventsub.js');
        const result = await getSubscriptionStatus(userId);

        return reply.send(result);
      } catch (error) {
        const err = error as Error;
        logger.error('Twitch', `Error getting subscription status: ${err.message}`);
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // Cleanup failed subscriptions endpoint
  fastify.post<{ Params: UserIdParams }>(
    '/eventsub/cleanup/:userId',
    async (request, reply) => {
      try {
        const { userId } = request.params;

        const { cleanupFailedSubscriptions } = await import('../integrations/twitch/eventsub.js');
        const result = await cleanupFailedSubscriptions(userId);

        return reply.send(result);
      } catch (error) {
        const err = error as Error;
        logger.error('Twitch', `Error cleaning up subscriptions: ${err.message}`);
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // Full reset and re-register endpoint - cleans up failed and re-registers all
  fastify.post<{ Params: UserIdParams }>(
    '/eventsub/reset/:userId',
    async (request, reply) => {
      try {
        const { userId } = request.params;

        const { cleanupFailedSubscriptions, registerUserSubscriptions } = await import(
          '../integrations/twitch/eventsub.js'
        );

        // First cleanup failed subscriptions
        const cleanupResult = await cleanupFailedSubscriptions(userId);

        // Then re-register all subscriptions
        const registerResult = await registerUserSubscriptions(userId);

        return reply.send({
          success: registerResult.success,
          cleanup: cleanupResult,
          registration: {
            created: registerResult.created,
            skipped: registerResult.skipped,
            error: registerResult.error,
          },
        });
      } catch (error) {
        const err = error as Error;
        logger.error('Twitch', `Error resetting subscriptions: ${err.message}`);
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // Test webhook endpoint for simulating Twitch events
  fastify.post<{ Params: UserIdParams; Body: TestEventBody }>(
    '/eventsub/test/:userId',
    async (request, reply) => {
      try {
        const { userId } = request.params;
        const { eventType, eventData, eventVersion = '1' } = request.body;

        logger.log('Twitch', `Processing test ${eventType} event for user ${userId}`);

        // Import the event processor
        const { processEventSubNotification } = await import(
          '../integrations/twitch/eventsub.js'
        );

        // Process the event using the existing event processor
        const result = await processEventSubNotification(eventType, eventData, userId, eventVersion);

        return reply.send({
          success: true,
          eventType,
          userId,
          result,
        });
      } catch (error) {
        const err = error as Error;
        logger.error('Twitch', `Error processing test event: ${err.message}`);
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  fastify.get<{ Params: EventTypeParams; Querystring: { userId?: string } }>(
    '/eventsub/test/examples/:eventType',
    async (request, reply) => {
      const { eventType } = request.params;

      // Get user ID from query param or use a default
      const userId = request.query.userId || 'default_user_id';

      // Try to get user details to populate broadcaster information
      let userObj: User | null = null;
      try {
        userObj = await returnAuthObject(userId);
      } catch (error) {
        const err = error as Error;
        logger.warn('Twitch', `Could not get user object for ${userId}: ${err.message}`);
      }

      const broadcasterId = userObj?.twitch_tokens?.streamer?.twitch_user_id || '123456789';
      const broadcasterName = userObj?.twitch_name || 'TestStreamer';

      const examples: Record<string, { eventType: string; eventData: Record<string, unknown>; eventVersion: string }> = {
        'channel.follow': {
          eventType: 'channel.follow',
          eventData: {
            user_name: 'TestFollower',
            user_id: '987654321',
            broadcaster_user_id: broadcasterId,
            broadcaster_user_name: broadcasterName,
            followed_at: new Date().toISOString(),
          },
          eventVersion: '2',
        },
        'channel.subscribe': {
          eventType: 'channel.subscribe',
          eventData: {
            user_name: 'TestSubscriber',
            user_id: '987654321',
            broadcaster_user_id: broadcasterId,
            broadcaster_user_name: broadcasterName,
            tier: '1000',
            is_gift: false,
          },
          eventVersion: '1',
        },
        'channel.subscription.gift': {
          eventType: 'channel.subscription.gift',
          eventData: {
            user_name: 'TestGifter',
            user_id: '987654321',
            broadcaster_user_id: broadcasterId,
            broadcaster_user_name: broadcasterName,
            tier: '1000',
            is_anonymous: false,
            recipient_user_name: 'GiftRecipient',
            recipient_user_id: '456789123',
            total: 1,
          },
          eventVersion: '1',
        },
        'channel.raid': {
          eventType: 'channel.raid',
          eventData: {
            from_broadcaster_user_id: '987654321',
            from_broadcaster_user_name: 'TestRaider',
            to_broadcaster_user_id: broadcasterId,
            to_broadcaster_user_name: broadcasterName,
            viewers: 42,
          },
          eventVersion: '1',
        },
        'channel.chat.message': {
          eventType: 'channel.chat.message',
          eventData: {
            broadcaster_user_id: broadcasterId,
            broadcaster_user_name: broadcasterName,
            chatter: {
              user_id: '987654321',
              user_name: 'TestChatter',
              badges: [{ set_id: 'subscriber', version: '1' }],
            },
            message: {
              text: 'This is a test message! @' + broadcasterName,
              is_first: false,
              fragments: [
                {
                  type: 'text',
                  text: 'This is a test message! @' + broadcasterName,
                },
              ],
            },
          },
          eventVersion: '1',
        },
      };

      if (!examples[eventType]) {
        return reply.code(404).send({
          error: 'Event type not found',
          availableTypes: Object.keys(examples),
        });
      }

      return reply.send(examples[eventType]);
    }
  );

  // List current EventSub subscriptions
  fastify.get<{ Params: UserIdParams }>(
    '/subscriptions/:userId',
    async (request, reply) => {
      const { userId } = request.params;

      try {
        const user = await returnAuthObject(userId);

        if (!user || !user.twitch_tokens?.streamer?.access_token) {
          return reply.code(400).send({ error: 'User has no Twitch integration' });
        }

        const axios = (await import('axios')).default;

        // Get subscriptions from Twitch API
        const response = await axios.get(
          'https://api.twitch.tv/helix/eventsub/subscriptions',
          {
            headers: {
              'Client-ID': await retrieveConfigValue<string>('twitch.clientId'),
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
        const err = error as Error;
        logger.error('Twitch', `Error listing subscriptions: ${err.message}`);
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // Manually register all EventSub for a user
  fastify.post<{ Params: UserIdParams }>(
    '/subscriptions/register/:userId',
    async (request, reply) => {
      const { userId } = request.params;

      try {
        // Import registration function
        const { registerUserSubscriptions } = await import(
          '../integrations/twitch/eventsub.js'
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
        const err = error as Error;
        logger.error('Twitch', `Error registering subscriptions: ${err.message}`);
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // Route to handle EventSub notifications
  fastify.post<{ Params: UserIdParams }>(
    '/eventsub/:userId',
    async (request, reply) => {
      const { userId } = request.params;

      if (!userId) {
        logger.error('Twitch', 'No userId provided in EventSub webhook URL');
        return reply.code(400).send({ error: 'Missing userId parameter' });
      }

      // Get the webhook secret for this user
      const secret = await getWebhookSecret(userId);

      // Get and verify the signature
      const headers = request.headers as Record<string, string | string[] | undefined>;
      const rawBody = request.body as Buffer;

      try {
        // Calculate the expected signature
        const message = getHmacMessage(headers, rawBody);
        const hmac = HMAC_PREFIX + getHmac(secret, message);

        // Verify the request is actually from Twitch
        const signature = headers[TWITCH_MESSAGE_SIGNATURE] as string;
        if (!verifyMessage(hmac, signature)) {
          logger.error('Twitch', 'EventSub signature verification failed');

          // If the secret was a dummy one, it means we don't have a valid webhook secret
          if (secret === 'invalid-verification-will-fail' || secret === 'error-getting-secret') {
            logger.error(
              'Twitch',
              `Invalid webhook secret for user ${userId}, verification was expected to fail`
            );

            // Register EventSub for this user to generate a valid webhook secret for next time
            const { registerUserSubscriptions } = await import(
              '../integrations/twitch/eventsub.js'
            );
            registerUserSubscriptions(userId).catch((err: Error) => {
              logger.error('Twitch', `Failed to register EventSub subscriptions: ${err.message}`);
            });
          }

          return reply.code(403).send({ error: 'Signature verification failed' });
        }

        // Signature verified, process the notification
        const notification: EventSubNotification = JSON.parse(rawBody.toString());
        const messageType = headers[MESSAGE_TYPE] as string;

        // Handle different message types
        if (messageType === MESSAGE_TYPE_NOTIFICATION) {
          // Process the event
          await processEvent(notification, userId);
          return reply.code(204).send();
        } else if (messageType === MESSAGE_TYPE_VERIFICATION) {
          // Respond to webhook verification challenge
          logger.log('Twitch', `EventSub verification received for user ${userId}`);
          return reply.code(200).type('text/plain').send(notification.challenge);
        } else if (messageType === MESSAGE_TYPE_REVOCATION) {
          // Handle subscription revocation
          logger.log(
            'Twitch',
            `EventSub ${notification.subscription.type} notifications revoked for user ${userId}`
          );
          logger.log('Twitch', `Reason: ${notification.subscription.status}`);

          // Update user's subscription status
          await handleEventSubRevocation(notification, userId);
          return reply.code(204).send();
        } else {
          logger.log('Twitch', `Unknown message type: ${messageType}`);
          return reply.code(204).send();
        }
      } catch (error) {
        const err = error as Error;
        logger.error('Twitch', `Error processing EventSub notification: ${err.message}`);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }
  );

  fastify.post<{ Params: UserIdParams }>(
    '/eventsub/register/:userId',
    async (request, reply) => {
      const { userId } = request.params;

      try {
        // Import registration function
        const { registerUserSubscriptions } = await import(
          '../integrations/twitch/eventsub.js'
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
        const err = error as Error;
        logger.error('Twitch', `Error registering subscriptions: ${err.message}`);
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  fastify.get<{ Params: UserIdParams }>(
    '/eventsub/subscriptions/:userId',
    async (request, reply) => {
      const { userId } = request.params;

      try {
        const user = await returnAuthObject(userId);

        if (!user || !user.twitch_tokens?.streamer?.access_token) {
          return reply.code(400).send({ error: 'User has no Twitch integration' });
        }

        // Import axios
        const axios = (await import('axios')).default;

        // Get subscriptions from Twitch API
        const response = await axios.get(
          'https://api.twitch.tv/helix/eventsub/subscriptions',
          {
            headers: {
              'Client-ID': await retrieveConfigValue<string>('twitch.clientId'),
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
        const err = error as Error;
        logger.error('Twitch', `Error listing subscriptions: ${err.message}`);
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // EventSub subscription management endpoint
  fastify.post<{ Body: SubscribeEventBody }>(
    '/eventsub/subscribe',
    async (request, reply) => {
      const { userId, type, condition } = request.body;

      if (!userId || !type) {
        return reply.code(400).send({ error: 'Missing required parameters' });
      }

      try {
        const result = await subscribeToEvent(userId, type, condition);
        return reply.send(result);
      } catch (error) {
        const err = error as Error;
        logger.error('Twitch', `Error subscribing to event: ${err.message}`);
        return reply.code(500).send({ error: err.message });
      }
    }
  );
}

// Function to subscribe to EventSub events
async function subscribeToEvent(
  userId: string,
  type: string,
  condition: Record<string, string> = {}
): Promise<{ success: boolean; subscription?: unknown }> {
  try {
    const user = await returnAuthObject(userId);

    if (!user) {
      throw new Error('User not found');
    }

    // Generate a new secret if one doesn't exist
    if (!user.twitch_tokens?.streamer?.webhook_secret) {
      const newSecret = crypto.randomBytes(32).toString('hex');

      // Ensure the path exists
      await ensureParameterPath(userId, 'twitch_tokens.streamer');

      // Save the new secret
      await updateUserParameter(userId, 'twitch_tokens.streamer.webhook_secret', newSecret);
    }

    // Default condition uses the broadcaster's ID
    let finalCondition = condition;
    if (Object.keys(condition).length === 0) {
      if (!user.twitch_tokens?.streamer?.twitch_user_id) {
        throw new Error('No broadcaster user ID available');
      }
      finalCondition = {
        broadcaster_user_id: user.twitch_tokens.streamer.twitch_user_id,
      };
    }

    // Import needed functions
    const { getAppAccessToken } = await import('../integrations/twitch/eventsub.js');
    const appToken = await getAppAccessToken();

    // Prepare the subscription payload
    const externalEndpoint = await retrieveConfigValue<string>('server.endpoints.external');
    const callbackUrl = `${externalEndpoint}/api/v1/twitch/eventsub/${userId}`;

    // Get fresh user data to ensure we have the webhook secret
    const freshUser = await returnAuthObject(userId);

    if (!freshUser?.twitch_tokens?.streamer?.webhook_secret) {
      throw new Error('Failed to get webhook secret');
    }

    const subscriptionBody = {
      type,
      version: '1',
      condition: finalCondition,
      transport: {
        method: 'webhook',
        callback: callbackUrl,
        secret: freshUser.twitch_tokens.streamer.webhook_secret,
      },
    };

    // Make the API request to create the subscription
    const axios = (await import('axios')).default;
    const response = await axios.post(
      'https://api.twitch.tv/helix/eventsub/subscriptions',
      subscriptionBody,
      {
        headers: {
          'Client-ID': await retrieveConfigValue<string>('twitch.clientId'),
          Authorization: `Bearer ${appToken}`,
          'Content-Type': 'application/json',
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
      version: '1',
      status: 'webhook_callback_verification_pending',
      created_at: new Date().toISOString(),
    });

    await updateUserParameter(userId, 'twitch_tokens.streamer.subscriptions', subscriptions);

    logger.log('Twitch', `Created EventSub subscription for ${userId}: ${type}`);

    return {
      success: true,
      subscription: response.data.data[0],
    };
  } catch (error) {
    const err = error as Error;
    logger.error('Twitch', `Failed to create subscription: ${err.message}`);
    throw error;
  }
}

// Handle EventSub revocation
async function handleEventSubRevocation(
  notification: EventSubNotification,
  userId: string
): Promise<void> {
  try {
    const subscriptionId = notification.subscription.id;

    if (!userId || !subscriptionId) {
      logger.error('Twitch', 'Missing userId or subscriptionId for revocation');
      return;
    }

    const user = await returnAuthObject(userId);

    if (!user || !user.twitch_tokens?.streamer?.subscriptions) {
      logger.error('Twitch', `No subscriptions found for user ${userId}`);
      return;
    }

    // Filter out the revoked subscription
    const subscriptions = user.twitch_tokens.streamer.subscriptions.filter(
      (sub) => sub.id !== subscriptionId
    );

    // Update the subscriptions list
    await updateUserParameter(userId, 'twitch_tokens.streamer.subscriptions', subscriptions);

    logger.log('Twitch', `Removed revoked subscription ${subscriptionId} for user ${userId}`);
  } catch (error) {
    const err = error as Error;
    logger.error('Twitch', `Error handling revocation: ${err.message}`);
  }
}

async function processEvent(
  notification: EventSubNotification,
  userId: string
): Promise<{ success: boolean; response?: string; error?: string }> {
  try {
    const eventType = notification.subscription.type;
    const eventVersion = notification.subscription.version || '1';
    const event = notification.event;

    // Log the event
    logger.log('Twitch', `Processing ${eventType} (v${eventVersion}) event for user ${userId}`);

    // Import the event processor from the manager
    const { processEventSubNotification } = await import('../integrations/twitch/eventsub.js');

    // Process based on the event type
    const result = await processEventSubNotification(eventType, event, userId, eventVersion);
    return { success: true, response: result.response };
  } catch (error) {
    const err = error as Error;
    logger.error('Twitch', `Error processing event: ${err.message}`);
    return { success: false, error: err.message };
  }
}

export default twitchEventSubRoutes;
