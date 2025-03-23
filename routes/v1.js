import * as aiHelper from "../ai-logic.js";
import {
  containsCharacterName,
  containsAuxBotName,
  containsPlayerSocials,
} from "../prompt-helper.js";
import { checkForAuth, updateUserParameter } from "../api-helper.js";
import { maintainVoiceContext } from "../data-helper.js";
import * as twitchHelper from "../twitch-helper.js";
import moment from "moment";
import fastifyFormbody from "@fastify/formbody";
import cors from "@fastify/cors";
import fastifyCompress from "@fastify/compress";

const chatResponseSchema = {
  type: 'object',
  properties: {
    response: { type: 'string' },
    thoughts: { type: 'string' },
    audio_url: { type: 'string' }
  }
};

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

const endPoints = {
  chat: "/chats",
  voice: "/voice",
  events: "/events",
  tts: "/speak",
  healthcheck: "/healthcheck",
};

/**
 * Checks if the input contains a jailbreak attempt.
 * @param {string} input - The input string to check.
 * @returns {boolean} - True if the input contains a jailbreak attempt, false otherwise.
 */
function containsJailbreakAttempt(input) {
  const pattern =
    /\b(ignore|disregard|bypass|override|forget|delete|remove|disable|break|reset|unlock|nullify|circumvent|destroy)\b\s+(all\s+)?(previous\s+|prior\s+|any\s+)?(instructions?|prompts?|rules?|filters?|limitations?|constraints?|policies?|protocols?|restrictions?|directives?|guidelines?)/i;
  return pattern.test(input);
}

async function routes(fastify, options) {
  await configureResponseHandling(fastify);
  await fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    async (req, body) => {
      try {
        return JSON.parse(body);
      } catch (err) {
        err.statusCode = 400;
        return err;
      }
    },
  );
  await fastify.register(import("@fastify/rate-limit"), {
    max: 100,
    timeWindow: "20 seconds",
  });

  await fastify.register(cors, {
    origin: true,
  });

  await fastify.register(fastifyCompress, {
    global: true,
    threshold: 1024, // Start compressing at 1KB
    encodings: ['gzip', 'deflate', 'br'],
    inflateIfDeflated: true, // Handle already compressed payloads
    zlibOptions: {
      level: 4, // Balance between compression level and CPU usage
      memLevel: 8, // Use more memory for better compression
      windowBits: 15 // Maximum window size
    }
  });
  await fastify.register(fastifyFormbody);

  /**
   * Handles voice requests, processes them, and sends responses.
   * @param {object} request - The request object.
   * @param {object} reply - The reply object.
   * @returns {Promise<void>} - A promise that resolves when the response is sent.
   */
  fastify.post(endPoints.voice, async (request, reply) => {
    try {
      const authObject = await checkForAuth(
        request.headers.authorization.split(" ")[1],
      );
      if (!authObject.valid) {
        logger.log("API", `Received unauthenticated voice request.`);
        reply.code(401).send({
          success: false,
          message:
            "Unauthorized. Please send your API token with this request.",
        });
        return;
      }
      if (!authObject.lastIp || authObject.lastIp !== request.ip) {
        await updateUserParameter(authObject.user_id, "lastIp", request.ip);
      }
      const data = request.body;
      const now = moment();
      const formattedDate = now.format("MMMM Do [at] h:mmA");
      const finalResp = await aiHelper.findRelevantVoiceInMilvus(
        data.message,
        authObject.player_name,
        authObject.user_id,
      );
      logger.log(
        "API",
        `${authObject.player_name} sent a voice message: ${data.message}`,
      );

      if (finalResp.response !== "") {
        const voiceData = await aiHelper.respondToDirectVoice(
          data.message,
          authObject.user_id,
        );
        const summaryString = `On ${formattedDate} ${authObject.player_name} said to you: "${data.message}". You responded to them by saying: ${voiceData.response}`;
        await maintainVoiceContext(summaryString);
        await aiHelper.addVoiceMessageAsVector(
          summaryString,
          data.message,
          authObject.player_name,
          formattedDate,
          voiceData.response,
        );
        reply.send(voiceData);
        return reply
      } else {
        reply.sendSafe({ response: "error" });
        return reply
      }
    } catch (error) {
      reply.code(400).sendSafe({ success: false, error: error.message });
      return reply
    }
  });
  fastify.get('/testchat', async (request, response) => {
    logger.log("API", "Received test endpoint req.")
    const testChats = await aiHelper.findRecentChats(request.body.userId)
    logger.log("Milvus", `Returned the following results: ${JSON.stringify(testChats)}`)
    response.code(200).sendSafe({ ...testChats });
    return response
  })
  /**
   * Handles chat requests, processes them, and sends responses.
   * @param {object} request - The request object.
   * @param {object} response - The response object.
   * @returns {Promise<void>} - A promise that resolves when the response is sent.
   */
  fastify.post(endPoints.chat, async (request, response) => {
    try {
      const authObject = await checkForAuth(
        request.headers.authorization.split(" ")[1],
      );
      if (!authObject.valid) {
        logger.log("API", `Received unauthenticated chat request.`);
        response.code(401).send({
          success: false,
          message:
            "Unauthorized. Please send your API token with this request.",
        });
        return;
      }
      if (!authObject.lastIp || authObject.lastIp !== request.ip) {
        await updateUserParameter(authObject.user_id, "lastIp", request.ip);
      }
      const data = request.body;
      const fromBot = await containsAuxBotName(data.user, authObject.user_id);
      logger.log(
        "API",
        `Received authenticated request from user ${authObject.display_name}`,
      );
      const now = moment();
      const formattedDate = now.format("MMMM Do [at] h:mmA");

      const isCharMessage = await containsCharacterName(data.user, authObject.user_id)
      const mentionsChar = await containsCharacterName(data.message, authObject.user_id)
      // Moved to separate function to prevent duplication error
      if (!fromBot && !isCharMessage) {
        // moderationResult = await getModerationResult(
        //   data,
        //   authObject.user_id,
        //   data.message,
        //   fromBot
        // );
      } else if (!fromBot && isCharMessage) {
        // moderationResult = await getModerationResult(
        //   data,
        //   authObject.user_id,
        //   data.message,
        //   fromBot
        // );
      }
      const user = (await twitchHelper.checkForUser(
        data.user,
        authObject.user_id,
      ))
        ? `${authObject.player_name}`
        : `${data.user}`;

      if (
        (mentionsChar &&
          !isCharMessage)
      ) {
        // Process messages directed at the character when not sent by the character
        await handleChatMessage(
          data,
          authObject,
          data.message,
          user,
          formattedDate,
          response,
        );
      } else if (
        (!mentionsChar &&
          !isCharMessage)
      ) {
        // Process other messages not directed at the character
        await handleNonChatMessage(
          data,
          authObject,
          data.message,
          null,
          user,
          formattedDate,
          response,
        );
      } else {
        response.sendSafe({ response: "OK" });
        return response;
      }
    } catch (error) {
      response.code(500).send({ error: error.message });
      return response;
    }
  });
  fastify.post(endPoints.tts, async (request, response) => {
    try {
      const authObject = await checkForAuth(
        request.headers.authorization.split(" ")[1],
      );
      if (!authObject.valid) {
        logger.log("API", `Received unauthenticated chat request.`);
        response.code(401).send({
          success: false,
          message:
            "Unauthorized. Please send your API token with this request.",
        });
        return;
      }
      const data = request.body;
      await handleVoiceConversion(data, authObject, response);
    } catch (error) {
      response.code(500).send({ error: error.message });
      return response;
    }
  });
  /**
   * Handles event requests, processes them, and sends responses.
   * @param {object} request - The request object.
   * @param {object} response - The response object.
   * @returns {Promise<void>} - A promise that resolves when the response is sent.
   */
  fastify.post(endPoints.events, { schema: { response: { 200: chatResponseSchema } } }, async (request, response) => {
    try {
      const authObject = await checkForAuth(
        request.headers.authorization.split(" ")[1]
      );
      if (!authObject.valid) {
        logger.log("API", `Received unauthenticated event request.`);
        response.code(401).send({
          success: false,
          message:
            "Unauthorized. Please send your API token with this request.",
        });
        return;
      }
      if (!authObject.lastIp || authObject.lastIp !== request.ip) {
        await updateUserParameter(authObject.user_id, "lastIp", request.ip);
      }
      const data = request.body;
      await handleEventMessage(data, authObject, response);
    } catch (error) {
      response.code(500).send({ error: error.message });
      return response
    }
  });

  fastify.get(endPoints.healthcheck, async (request, response) => {
    logger.log("API", `Received healthcheck request from ${request.ip}`);
    response.code(200).send({ status: "up" });
  });

  fastify.get("/", async (request, response) => {
    logger.log("API", `Request hit root (by accident?) from ${request.ip}`)
    response.code(200).send({ error: "Please specify an endpoint before sending a request.", ...endPointDoc })
  })
  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof fastify.errorCodes.FST_ERR_ROUTE_METHOD_NOT_SUPPORTED) {
      reply.code(405).send({
        error: "Method Not Allowed",
        message: `HTTP method "${request.method}" is not supported for this route.`,
        allowedMethods: reply.context.config.allowedMethods // List of allowed methods
      });
    } else {
      reply.send(error);
    }
  });
}

async function handleChatMessage(data, authObject, message, user, formattedDate, response) {
  // Check if the message is a command or a jailbreak attempt first…
  if (!(await twitchHelper.isCommandMatch(message, authObject.user_id))) {
    if (containsJailbreakAttempt(message)) {
      logger.log("API", "Processing message as jailbreak attempt.");
      const aiJBResp = await aiHelper.respondWithoutContext(
        `Creatively be mean towards ${data.user} for trying to stop you from doing your job and ruin ${authObject.player_name}'s stream.`,
        authObject.user_id
      );
      response.send({ response: aiJBResp });
    } else {
      let finalResp;
      try {
        if (data.firstMessage) {
          finalResp = await aiHelper.respondToEvent(data, authObject.user_id);
        } else {
          finalResp = await aiHelper.respondWithContext(message, user, authObject.user_id);
        }

        logger.log("LLM", `Thought tokens: ${finalResp.thoughtProcess}`)
        logger.log("LLM", `Response tokens: ${finalResp.response}`)

        if (!finalResp.response) {
          logger.log("API", "Received empty response from AI model, sending error response to client");
          response.send({
            response: "I'm sorry, I encountered an issue processing your request. Please try again.",
            error: "Empty response from AI model"
          });
          return;
        }

        // Check if response is too large
        if (finalResp.response && finalResp.response.length > 1000000) { // 1MB threshold
          logger.log("API", `Response size (${finalResp.length} bytes) exceeds safe limit, truncating`);
          finalResp = finalResp.response.substring(0, 500000) + "\n[Response truncated due to excessive length]";
        }

        const summaryString = `On ${formattedDate}, ${user} said: "${message}". You responded by saying: ${finalResp.response}`;

        // Optimization: Fire-and-forget vector saving instead of awaiting it.
        aiHelper.addChatMessageAsVector(summaryString, message, user, formattedDate, finalResp.response, authObject.user_id)
          .catch(err => logger.log("API", "Error saving chat message vector:", err));

        logger.log("API", "Processing message as normal.");

        if (data.withVoice) {
          // Optionally, run TTS in parallel
          try {
            const audio_url = authObject.tts_enabled
              ? await aiHelper.respondWithVoice(finalResp.response, authObject.user_id)
              : null;
            response.send({ response: finalResp.response, audio_url, thoughtProcess: finalResp.thoughtProcess });
          } catch (ttsError) {
            logger.log("API", `TTS error: ${ttsError.message}`);
            response.send({ response: finalResp.response, thoughtProcess: finalResp.thoughtProcess, tts_error: "TTS failed but text response is available" });
          }
        } else {
          response.send({ response: finalResp.response, thoughtProcess: finalResp.thoughtProcess });
        }
      } catch (error) {
        logger.log("API", `Error in AI response generation: ${error.message}`);
        response.send({
          response: "I'm sorry, I encountered an error while processing your message.",
          error: error.message
        });
      }
    }
  } else {
    response.send({ response: "OK" });
  }
}

async function handleGameUpdate(
  data,
  authObject,
  gameData,
  user
) {
  if (
    (await twitchHelper.isCommandMatch(data.message, authObject.user_id)) ==
    false
  ) {
    let finalResp;
    finalResp = await aiHelper.respondWithContext(
      message,
      user,
      authObject.user_id,
    );

    if (finalResp) {
      logger.log("API", `Processing message as normal.`);
      if (data.withVoice) {
        const ttsResponse = authObject.tts_enabled
          ? {
            response: finalResp,
            audio_url: await aiHelper.respondWithVoice(
              finalResp,
              authObject.user_id,
            ),
          }
          : { response: finalResp };
        response.send({ response: finalResp, ...ttsResponse });
      } else if (!data.withVoice || data.withVoice == null) {
        response.send({ response: finalResp });
      }
    } else {
      response.send({ response: "error" });
    }
  } else {
    response.send({ response: "OK" });
  }
}

async function configureResponseHandling(fastify) {
  if (fastify.hasPlugin('fastify-compress')) {
    logger.log("API", "Compression plugin already registered, updating configuration");
  }

  // Configure response timeouts if server is available
  if (fastify.server) {
    // Use safer timeout values
    if (typeof fastify.server.keepAliveTimeout === 'number') {
      fastify.server.keepAliveTimeout = 120000; // 2 minutes
    }
    if (typeof fastify.server.headersTimeout === 'number') {
      fastify.server.headersTimeout = 65000; // Just above default 60s
    }
  }

  // Add hook to handle large responses - this should work regardless of server setup
  fastify.addHook('onRequest', (request, reply, done) => {
    // Set default headers for all responses
    reply.header('Content-Type', 'application/json; charset=utf-8');
    done();
  });

  // Add response monitoring middleware
  fastify.addHook('onSend', (request, reply, payload, done) => {
    // For debugging, log payload size
    if (payload) {
      const size = typeof payload === 'json' ? payload.length : JSON.stringify(payload).length;
      logger.log("API", `Response payload size: ${size} bytes for ${request.url}`);

      // Check for suspiciously small payloads
      if (size < 5 && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
        logger.log("API", `WARNING: Very small response detected for ${request.url}: ${payload}`);
      }
    }

    // Make sure content type is set
    if (!reply.getHeader('content-type')) {
      reply.header('Content-Type', 'application/json; charset=utf-8');
    }

    done(null, payload);
  });

  // Add a simple response helper method to the reply object
  fastify.decorateReply('sendSafe', function (data) {
    // If the data is already a string, use it directly
    if (typeof data === 'string') {
      return this.type('text/plain; charset=utf-8').send(data);
    }

    try {
      // Try to stringify the data safely
      const safeJSON = JSON.stringify(data);
      return this.type('application/json; charset=utf-8').send(safeJSON);
    } catch (error) {
      logger.log("API", `Error stringifying response: ${error.message}`);
      // Send a fallback response
      return this.code(500).send(JSON.stringify({
        error: "Error generating response",
        message: "Failed to serialize response data"
      }));
    }
  });

  logger.log("API", "Response handling configuration completed");
}

/**
 * Handles event messages, processes them, generates responses, and optionally triggers voice responses.
 * @param {object} data - The event data object.
 * @param {object} authObject - The authentication object.
 * @param {object} response - The Fastify response object.
 * @returns {Promise<void>} - A promise that resolves when the response is sent.
 */
async function handleEventMessage(data, authObject, response) {
  try {
    logger.log(
      "API",
      `A Twitch event fired for ${authObject.user_id}, type: ${data.eventType}`
    );

    // Get the response from the AI
    const aiResponse = await aiHelper.respondToEvent(data, authObject.user_id);

    // Check if response is valid
    if (!aiResponse) {
      logger.log("API", "Empty AI response received");
      response.code(500).send({
        error: "Error generating response",
        success: false
      });
      return;
    }

    // Log the full response structure for debugging
    logger.log("API", `AI response structure: ${JSON.stringify(Object.keys(aiResponse))}`);

    // Make a new object with just what we need to return
    const responseToSend = {
      response: aiResponse.response || "",
      thoughts: aiResponse.thoughtProcess || ""
    };

    // If TTS is enabled, add the audio URL
    if (authObject.tts_enabled) {
      try {
        // Only send the text response to TTS, not the thought process
        const textToVocalize = aiResponse.response || "";
        const audio_url = await aiHelper.respondWithVoice(
          textToVocalize,
          authObject.user_id,
        );

        if (audio_url) {
          responseToSend.audio_url = audio_url;
        }
      } catch (ttsError) {
        logger.log("API", `TTS error: ${ttsError.message}`);
        // Continue without audio if TTS fails
      }
    }

    // Set explicit content type and send response
    response.type('application/json').send(responseToSend);
    return response;
  } catch (error) {
    logger.log("API", `Error handling event message: ${error.message}`);
    response.code(500).send({
      error: "Server error",
      message: error.message,
      success: false
    });
    return response;
  }
}

/**
 * Handles chat messages not directed at the character.
 * @param {object} data - The data object containing message details.
 * @param {object} authObject - The authentication object.
 * @param {string} text - The text to process on the TTS server.
 * @param {object} response - The response object.
 * @returns {Promise<void>} - A promise that resolves when the response is sent.
 */
async function handleVoiceConversion(data, authObject, response) {
  const ttsResponse = authObject.tts_enabled
    ? {
      audio_url: await aiHelper.respondWithVoice(
        data.text,
        authObject.user_id,
      ),
    }
    : {
      error: "TTS not enabled for user.",
    };
  response.send({ ...ttsResponse });
}

/**
 * Handles chat messages not directed at the character.
 * @param {object} data - The data object containing message details.
 * @param {object} authObject - The authentication object.
 * @param {string} message - The message object.
 * @param {string} moderationResult - The result of the moderation check.
 * @param {string} user - The user who sent the message.
 * @param {string} formattedDate - The formatted date and time of the message.
 * @param {object} response - The response object.
 * @returns {Promise<void>} - A promise that resolves when the response is sent.
 */
async function handleNonChatMessage(
  data,
  authObject,
  message,
  user,
  formattedDate,
  response,
) {
  const fromBot = await containsAuxBotName(data.user, authObject.user_id);

  if (
    (await twitchHelper.isCommandMatch(data.message, authObject.user_id)) ==
    false
  ) {
    if (containsJailbreakAttempt(message)) {
      logger.log("API", `Jailbreak attempt. Not saving.`);
      response.send({ response: "OK" });
    } else if (!fromBot) {
      if (data.firstMessage) {
        const aiResp = await aiHelper.respondToEvent(
          data,
          authObject.user_id,
        );
        const contextString = `On ${formattedDate}, ${user} said in ${user === authObject.player_name
          ? "their own"
          : `${authObject.player_name}'s`
          } chat: "${message}". You responded by saying: ${aiResp.response}`;
        const summaryString = `On ${formattedDate}, ${user} said to you in ${user === authObject.player_name
          ? "their own"
          : `${authObject.player_name}'s`
          } chat: "${message}". You responded by saying: ${aiResp.response}`;
        await aiHelper.addChatMessageAsVector(
          summaryString,
          message,
          user,
          formattedDate,
          aiResp.response,
          authObject.user_id,
        );
        logger.log(
          "API",
          `Processing ${data.user}'s message '${message}' into vector memory.`,
        );
        const ttsResponse = authObject.tts_enabled
          ? {
            response: aiResp.response,
            audio_url: await aiHelper.respondWithVoice(
              aiResp.response,
              authObject.user_id,
            ),
            thoughtProcess: aiResp.thoughtProcess
          }
          : { response: aiResp.response };
        response.send({ ...ttsResponse });
      } else {
        const summaryString = `On ${formattedDate} ${user} said in ${user === authObject.player_name
          ? "their own"
          : `${authObject.player_name}'s`
          } Twitch chat: "${message}"`;
        const contextString = `On ${formattedDate}, ${user} said in ${user === authObject.player_name
          ? "their own"
          : `${authObject.player_name}'s`
          } chat: "${message}"`;
        await aiHelper.addChatMessageAsVector(
          summaryString,
          message,
          user,
          formattedDate,
          "None",
          authObject.user_id,
        );
        logger.log("API", `Processing memory request.`);
        response.send({ response: "OK" });
      }
    }
  } else {
    logger.log("API", `Known bot ${data.user}, ignoring.`);
    response.send({ response: "OK" });
  }
}

export default routes;
