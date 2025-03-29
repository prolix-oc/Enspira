import Fastify from "fastify";
import fs from "fs-extra";
import { join } from "path";
import { audioRoutes } from './routes/audio.js';
import twitchEventSubRoutes from './routes/twitch.js';
import * as aiHelper from "./ai-logic.js";
import webRoutes from './routes/web.js';
import {
  initAllAPIs,
  returnAPIKeys
} from "./api-helper.js";
import { preloadAllTokenizers } from "./token-helper.js";
import { retrieveConfigValue, loadConfig } from "./config-helper.js";
import routes from './routes/v1.js';
import './create-global-logger.js'; // This ensures the logger is properly set up
import { logger } from './create-global-logger.js';
import fastifyCookie from "@fastify/cookie";
import * as crypto from 'crypto'
import { setupTemplating } from './template-engine.js';

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  // Keep process alive for debugging
  console.error('Stack trace:', err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
  // Keep process alive for debugging
  console.error('Stack trace:', reason.stack);
});

// Create the fastify instance
const createServer = async () => {
  const fastify = Fastify({
    trustProxy: true,
    http2: true,
    methodNotAllowed: true,
    https: {
      allowHTTP1: true,
      key: fs.readFileSync(join(process.cwd(), "self_signed.key")),
      cert: fs.readFileSync(join(process.cwd(), "self_signed.crt")),
    },
    logger: false,
    requestTimeout: 30000,
    // Add these options
    // For http/1 header size
    http: {
      maxHeaderSize: 81920, // 80KB
      keepAliveTimeout: 120000, // 2 minutes
      headersTimeout: 65000 // 65 seconds
    },
    bodyLimit: 10485760, // 10MB for request body size (default is 1MB)
    maxParamLength: 2000, // Increase param length limit

  });
  const endPointDoc = {
    "chat": {
      endpoint: "/v1/chats",
      method: "POST"
    },
    "voice": {
      endpoint: "/v1/voice",
      method: "POST"
    },
    "event": {
      endpoint: "/v1/events",
      method: "POST"
    },
    "tts": {
      endpoint: "/v1/speak",
      method: "POST"
    },
    "healthcheck": {
      endpoint: "/v1/healthcheck",
      method: "GET"
    }
  };

  await fastify.register(fastifyCookie, {
    secret: await retrieveConfigValue("server.cookieSecret") || crypto.randomBytes(32).toString('hex'), // Use a stored secret or generate one
    parseOptions: {}
  });

  await fastify.register(import('@fastify/multipart'), {
    limits: {
      fieldNameSize: 100,
      fieldSize: 1000000,
      fields: 20,
      fileSize: 5000000,
      files: 5,
      headerPairs: 2000
    },
    attachFieldsToBody: true
  });

  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof Fastify.errorCodes.FST_ERR_ROUTE_METHOD_NOT_SUPPORTED) {
      reply.code(405).send({
        error: "Method Not Allowed",
        message: `HTTP method "${request.method}" is not supported for this route.`,
        allowedMethods: reply.context.config.allowedMethods // List of allowed methods
      });
    } else {
      reply.send(error);
    }
  });
  await setupTemplating(fastify);
  // Register routes
  await fastify.register(routes, {
    prefix: "/api/v1",
  });

  await fastify.register(audioRoutes, {
    outputDir: 'final',
    prefix: '/files/audio',
    addContentDisposition: true
  });

  await fastify.register(twitchEventSubRoutes, {
    prefix: "/api/v1/twitch"
  });

  await fastify.register(webRoutes, {
    prefix: "/web"
  });

  return fastify;
};

/**
 * Performs preflight checks on external services and databases.
 * @returns {Promise<object>} - A promise that resolves to a status object.
 */
export async function preflightChecks() {
  try {
    const axios = (await import('axios')).default;
    let ttsRes = { status: 0 };
    const ttsPreference = await retrieveConfigValue("ttsPreference");
    try {
      switch (ttsPreference) {
        case "fish":
          ttsRes = await axios.get(
            await retrieveConfigValue("fishTTS.healthcheck.internal")
          );
          break;
        case "alltalk":
          ttsRes = await axios.get(
            await retrieveConfigValue("alltalk.healthcheck.internal")
          );
          break;
        default:
          ttsRes = { status: 200 };
          break;
      }
    } catch (ttsError) {
      logger.log("API", `TTS healthcheck error: ${ttsError.message}`);
    }

    logger.log("API", `Current TTS engine: ${ttsPreference}, ${ttsRes.status == 200 ? "is alive." : "is not alive."}`);
    const databaseRes = await aiHelper.checkMilvusHealth();

    const checkResult = {
      llmStatuses: {
        allTalkIsOnline: ttsRes.status == 200 ? true : false,
        embeddingIsOnline: await aiHelper.checkEndpoint(
          await retrieveConfigValue("models.embedding.endpoint"),
          await retrieveConfigValue("models.embedding.apiKey"),
          await retrieveConfigValue("models.embedding.model"),
        ),
        llmIsOnline: await aiHelper.checkEndpoint(
          await retrieveConfigValue("models.chat.endpoint"),
          await retrieveConfigValue("models.chat.apiKey"),
          await retrieveConfigValue("models.chat.model"),
        ),
        summaryIsOnline: await aiHelper.checkEndpoint(
          await retrieveConfigValue("models.summary.endpoint"),
          await retrieveConfigValue("models.summary.apiKey"),
          await retrieveConfigValue("models.summary.model"),
        ),
        queryIsOnline: await aiHelper.checkEndpoint(
          await retrieveConfigValue("models.query.endpoint"),
          await retrieveConfigValue("models.query.apiKey"),
          await retrieveConfigValue("models.query.model"),
        ),
        conversionIsOnline: await aiHelper.checkEndpoint(
          await retrieveConfigValue("models.conversion.endpoint"),
          await retrieveConfigValue("models.conversion.apiKey"),
          await retrieveConfigValue("models.conversion.model"),
        ),
      },
      restIsOnline: true,
      dbIsOnline: databaseRes,
    };

    return checkResult;
  } catch (error) {
    logger.error("System", `Error during preflight checks: ${error.message}`);
    return {
      llmStatuses: {
        allTalkIsOnline: false,
        embeddingIsOnline: false,
        llmIsOnline: false,
        summaryIsOnline: false,
        queryIsOnline: false,
        conversionIsOnline: false,
      },
      restIsOnline: false,
      dbIsOnline: false,
    };
  }
}

/**
 * Launches the Fastify server.
 * @param {Fastify.FastifyInstance} fastify - The Fastify instance to launch.
 * @returns {Promise<void>} - A promise that resolves when the server starts listening.
 */
export async function launchRest(fastify) {
  const portNum = await retrieveConfigValue("server.port");

  try {
    await fastify.listen({
      port: portNum,
      host: await retrieveConfigValue("server.endpoints.internal"),
    });
    logger.log(
      "API",
      `Fastify server launched successfully on port ${portNum}`,
    );
    return Promise.resolve();
  } catch (err) {
    logger.error("API", `Failed to launch API server with error: ${err}`);
    await fs.writeFile('./error.txt', JSON.stringify(err))
    throw err;
  }
}

/**
 * Initializes the application, loads API keys, starts vector indexing,
 * preloads tokenizers, launches the REST server, and performs preflight checks.
 * @returns {Promise<{server: Fastify.FastifyInstance, status: object}>} - A promise that resolves with the server instance and status.
 */
export async function initializeApp() {
  try {
    const allUsers = await returnAPIKeys();

    const collectionNames = [
      await retrieveConfigValue("milvus.collections.user"),
      await retrieveConfigValue("milvus.collections.intelligence"),
      await retrieveConfigValue("milvus.collections.chat"),
      await retrieveConfigValue("milvus.collections.voice"),
    ];

    await loadConfig();
    for await (const user of allUsers) {
      for await (const collectionName of collectionNames) {
        try {
          const collectionExists = await aiHelper.checkAndCreateCollection(
            collectionName,
            user.user_id,
          );
          if (!collectionExists) {
            logger.error("Milvus", `Failed to create collection ${collectionName} for user ${user.user_id}`);
            continue;
          }

          const isLoaded = await aiHelper.loadCollectionIfNeeded(
            collectionName,
            user.user_id,
          );
          if (!isLoaded) {
            logger.error("Milvus", `Failed to load collection ${collectionName} for user ${user.user_id}`);
            continue;
          }
        } catch (error) {
          logger.error("Milvus", `Error with collection ${collectionName} for user ${user.user_id}: ${error.message}`);
          continue;
        }
      }
    }

    // Now start indexing vectors after ensuring each user has collections
    await Promise.all(
      allUsers.map((user) => aiHelper.startIndexingVectors(user.user_id)),
    );

    await preloadAllTokenizers();
    const server = await createServer();
    await launchRest(server);

    const status = await preflightChecks();
    await initAllAPIs();

    try {
      logger.log("System", "Importing Twitch EventSub manager...");
      const { registerAllUsersEventSub, setupTwitchCronJobs } = await import('./twitch-eventsub-manager.js');

      logger.log("System", "Registering Twitch EventSub subscriptions...");
      const eventSubResults = await registerAllUsersEventSub();
      logger.log("System", `EventSub registration complete: ${eventSubResults.success} successful, ${eventSubResults.failures} failed`);

      // Set up periodic Twitch data update jobs
      logger.log("System", "Setting up Twitch cron jobs...");
      setupTwitchCronJobs();
    } catch (eventSubError) {
      logger.error("System", `Error with Twitch integration: ${eventSubError.message}`);
      // Continue execution even if EventSub registration fails
    }

    logger.log("System", "Enspira is fully initialized and ready!");
    return { server, status };
  } catch (error) {
    logger.error("System", `Failed to initialize the application: ${error.message}`);
    throw error;
  }
}

// Only start server if this file is run directly, not if it's imported
if (import.meta.url === import.meta.main) {
  initializeApp().catch(err => {
    logger.error("System", `Fatal error in application: ${err.message}`);
    process.exit(1);
  });
}

// Export the initializeApp function for use in main.js
export default initializeApp;