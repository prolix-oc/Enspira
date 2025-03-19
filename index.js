// index.js - Updated for single-process application
import Fastify from "fastify";
import fs from "fs-extra";
import { join } from "path";
import { audioRoutes } from './routes/audio.js';
import { processAudio, ensureGoServerRunning } from './audio-processor.js';
import * as aiHelper from "./ai-logic.js";
import path from "path";
import {
  initAllAPIs,
  returnAPIKeys
} from "./api-helper.js";
import { preloadAllTokenizers } from "./token-helper.js";
import { retrieveConfigValue, loadConfig } from "./config-helper.js";
import routes from './routes/v1.js';
import './create-global-logger.js'; // This ensures the logger is properly set up
import { logger } from './create-global-logger.js';

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

  const endPointDocBase = {
    "chat": {
      endpoint: "/api/v1/chats",
      method: "POST"
    },
    "voice": {
      endpoint: "/api/v1/voice",
      method: "POST"
    },
    "event": {
      endpoint: "/api/v1/events",
      method: "POST"
    },
    "tts": {
      endpoint: "/api/v1/speak",
      method: "POST"
    },
    "healthcheck": {
      endpoint: "/api/v1/healthcheck",
      method: "GET"
    }
  };

  // Configure routes
  fastify.all("/api", async (request, response) => {
    logger.log("API", `Received base route request from ${request.ip}`);
    response.code(200).send({ error: "Please select a valid endpoint before sending a request", ...endPointDoc });
  });

  fastify.all("/", async (request, response) => {
    logger.log("API", `Received base route request from ${request.ip}`);
    response.code(200).send({ error: "Please select a valid endpoint before sending a request", ...endPointDocBase });
  });

  fastify.post('/v1/audio/outputs', async (request, reply) => {
    const { fileURL } = request.body;

    if (!fileURL) {
      return reply.code(400).send({ error: 'Missing fileURL parameter' });
    }

    try {
      // Download and process the audio
      const axios = (await import('axios')).default;
      const fs = await import('fs/promises');

      // Create temp directory
      const tempDir = path.join(process.cwd(), 'temp');
      await fs.mkdir(tempDir, { recursive: true }).catch(() => { });
      const tempFilePath = path.join(tempDir, `tts_${Date.now()}.wav`);

      // Download the file from the URL
      const response = await axios({
        method: 'GET',
        url: fileURL,
        responseType: 'arraybuffer'
      });

      // Save the file to the temp directory
      await fs.writeFile(tempFilePath, Buffer.from(response.data));

      // Process the audio file
      const processedFilePath = await processAudio(tempFilePath, {
        preset: request.body.preset || 'clarity',
        outputDir: 'final'
      });

      // Clean up temp file
      await fs.unlink(tempFilePath).catch(() => { });

      // Get just the filename from the path
      const filename = path.basename(processedFilePath);

      // Return the URL to access the processed file
      return {
        success: true,
        audioUrl: `/audio/${filename}`,
        filename: filename
      };
    } catch (error) {
      logger.error("API", `Failed to process audio: ${error.message}`);
      return reply.code(500).send({
        error: 'Failed to process audio',
        message: error.message
      });
    }
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

  // Register routes
  await fastify.register(routes, {
    prefix: "/v1",
  });

  await fastify.register(audioRoutes, {
    outputDir: 'final',
    prefix: '/files/audio',
    addContentDisposition: true
  });

  return fastify;
};

/**
 * Performs preflight checks on external services and databases.
 * @returns {Promise<object>} - A promise that resolves to a status object.
 */
export async function preflightChecks() {
  try {
    // Axios import might be needed if not already imported
    const axios = (await import('axios')).default;
    
    const allTalkRes = await axios.get(
      await retrieveConfigValue("alltalk.healthcheck.internal"),
    );

    const databaseRes = await aiHelper.checkMilvusHealth();

    const checkResult = {
      llmStatuses: {
        allTalkIsOnline: allTalkRes.status == 200 ? true : false,
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
    await ensureGoServerRunning();
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
    
    return { server, status };
  } catch (error) {
    logger.error("System", `Failed to initialize application: ${error.message}`);
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