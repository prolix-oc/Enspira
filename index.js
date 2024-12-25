import axios from "axios";
import fs from "fs-extra";
import Fastify from "fastify";
import { join } from "path";
import * as aiHelper from "./ai-logic.js";
import {
  initAllAPIs,
  returnAPIKeys
} from "./api-helper.js";
import { preloadAllTokenizers } from "./token-helper.js";
import { retrieveConfigValue, loadConfig } from "./config-helper.js";
import routes from './routes/v1.js';

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

fastify.register(routes, {
  prefix: "/api/v1",
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

fastify.all("/api", async (request, response) => {
  logger.log("API", `Received base route request from ${request.ip}`)
  response.code(200).send({error: "Please select a valid endpoint before sending a request", ...endPointDoc })
})

fastify.all("/", async (request, response) => {
  logger.log("API", `Received base route request from ${request.ip}`)
  response.code(200).send({error: "Please select a valid endpoint before sending a request", ...endPointDocBase })
})

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

/**
 * Performs preflight checks on external services and databases.
 * @returns {Promise<void>} - A promise that resolves when all preflight checks are completed.
 */
async function preflightChecks() {
  const allTalkRes = await axios.get(
    await retrieveConfigValue("alltalk.healthcheck.internal"),
  );

  const databaseRes = await aiHelper.checkMilvusHealth();

  let checkResult = {
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
  process.send({ type: "preflight", data: checkResult });
}

/**
 * Launches the Fastify server.
 * @returns {Promise<void>} - A promise that resolves when the server starts listening.
 */
async function launchRest() {
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
    logger.log("API", `Failed to launch API server with error: ${err}`);
    process.exit(1);
  }
}

/**
 * Initializes the application, loads API keys, starts vector indexing,
 *  preloads tokenizers, launches the REST server, and performs preflight checks.
 * @returns {Promise<void>} - A promise that resolves when the application is fully initialized.
 */
async function initializeApp() {
  const allUsers = await returnAPIKeys();

  const collectionNames = [
    await retrieveConfigValue("milvus.collections.user"),
    await retrieveConfigValue("milvus.collections.intelligence"),
    await retrieveConfigValue("milvus.collections.chat"),
    await retrieveConfigValue("milvus.collections.voice"),
  ];
  await loadConfig();

  for (const user of allUsers) {
    for (const collectionName of collectionNames) {
      try {
        const collectionExists = await aiHelper.checkAndCreateCollection(
          collectionName,
          user.user_id,
        );
        if (!collectionExists) {
          process.exit(1);
        }

        const isLoaded = await aiHelper.loadCollectionIfNeeded(
          collectionName,
          user.user_id,
        );
        if (!isLoaded) {
          process.exit(1);
        } else {
        }
      } catch (error) {
        process.exit(1);
      }
    }
  }

  // Now start indexing vectors after ensuring each user has collections
  await Promise.all(
    allUsers.map((user) => aiHelper.startIndexingVectors(user.user_id)),
  );

  await preloadAllTokenizers();
  await launchRest();
  await preflightChecks();
  await initAllAPIs();
}

initializeApp();
