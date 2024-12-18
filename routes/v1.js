import * as aiHelper from "../ai-logic.js";
import {
  filterCharacterFromMessage,
  containsCharacterName,
  containsAuxBotName,
  containsPlayerSocials,
} from "../prompt-helper.js";
import { checkForAuth, updateUserParameter } from "../api-helper.js";
import { maintainVoiceContext } from "../data-helper.js";
import * as twitchHelper from "../twitch_helper.js";
import moment from "moment";
import fastifyFormbody from "@fastify/formbody";
import cors from "@fastify/cors";
import fastifyCompress from "@fastify/compress";

const endPointDoc = [
  { chat: "/chats", method: "POST" },
  { voice: "/voice", method: "POST" },
  { events: "/events", method: "POST" },
  { tts: "/speak", method: "POST" },
  { healthcheck: "/healthcheck", method: "GET" },
];

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

async function getModerationResult(data, user_id, strippedMessage, fromBot) {
  if (!(await containsPlayerSocials(data.user, user_id)) || !fromBot) {
    return twitchHelper.prepareModerationChatRequest(
      data.user,
      strippedMessage,
      data.emoteCount,
      user_id,
    );
  }
  return "safe";
}

async function routes(fastify, options) {
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
    encodings: ["gzip", "deflate", "br"],
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

      if (finalResp !== "") {
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
      } else {
        reply.send({ response: "error" });
      }
    } catch (error) {
      reply.code(400).send({ success: false, error: error.message });
    }
  });
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
      const strippedMessage = await filterCharacterFromMessage(
        data.message,
        authObject.user_id,
      );
      const isCharMessage = await containsCharacterName(data.user, authObject.user_id)
      const mentionsChar = await containsCharacterName(data.message, authObject.user_id)
      // Moved to separate function to prevent duplication error
      let moderationResult = null;
      if (!fromBot || !isCharMessage) {
        moderationResult = await getModerationResult(
          data,
          authObject.user_id,
          strippedMessage,
          fromBot
        );
      } else {
        moderationResult["action"] = "safe";
      }
      const user = (await twitchHelper.checkForUser(
        data.user,
        authObject.user_id,
      ))
        ? `${authObject.display_name}`
        : `${data.user}`;

      if (
        (mentionsChar &&
        !isCharMessage)
      ) {
        // Process messages directed at the character when not sent by the character
        await handleChatMessage(
          data,
          authObject,
          strippedMessage,
          moderationResult,
          user,
          formattedDate,
          response,
        );
      } else if (
        !(mentionsChar &&
        !isCharMessage)
      ) {
        // Process other messages not directed at the character
        await handleNonChatMessage(
          data,
          authObject,
          strippedMessage,
          moderationResult,
          user,
          formattedDate,
          response,
        );
      } else {
        response.send({ response: "OK" });
      }
    } catch (error) {
      response.code(500).send({ error: error.message });
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
    }
  });
  /**
   * Handles event requests, processes them, and sends responses.
   * @param {object} request - The request object.
   * @param {object} response - The response object.
   * @returns {Promise<void>} - A promise that resolves when the response is sent.
   */
  fastify.post(endPoints.events, async (request, response) => {
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
    }
  });
  /**
   * Handles health check requests.
   * @param {object} request - The request object.
   * @param {object} response - The response object.
   * @returns {Promise<void>} - A promise that resolves when the response is sent.
   */
  fastify.get(endPoints.healthcheck, async (request, response) => {
    logger.log("API", `Received healthcheck request from ${request.ip}`);
    response.code(200).send({ status: "up" });
  });
}

/**
 * Handles chat messages directed at the character.
 * @param {object} data - The data object containing message details.
 * @param {object} authObject - The authentication object.
 * @param {string} strippedMessage - The message with character names removed.
 * @param {string} moderationResult - The result of the moderation check.
 * @param {string} user - The user who sent the message.
 * @param {string} formattedDate - The formatted date and time of the message.
 * @param {object} response - The response object.
 * @returns {Promise<void>} - A promise that resolves when the response is sent.
 */
async function handleChatMessage(
  data,
  authObject,
  strippedMessage,
  moderationResult,
  user,
  formattedDate,
  response,
) {
  if (
    (await twitchHelper.isCommandMatch(data.message, authObject.user_id)) ==
    false
  ) {
    if (containsJailbreakAttempt(strippedMessage)) {
      logger.log("API", `Processing message as jailbreak attempt.`);
      const aiJBResp = await aiHelper.respondWithoutContext(
        `Creatively be mean towards ${data.user} for trying to stop you from doing your job and ruin ${authObject.player_name}'s stream.`,
        authObject.user_id,
      );
      response.send({ response: aiJBResp });
    } else {
      if (moderationResult === "safe") {
        let finalResp;
        if (data.firstMessage) {
          finalResp = await aiHelper.respondToEvent(data, authObject.user_id);
        } else {
          finalResp = await aiHelper.respondWithContext(
            strippedMessage,
            user,
            authObject.user_id,
          );
        }
        if (finalResp) {
          const contextString = `On ${formattedDate}, ${user} said in ${
            user === authObject.player_name
              ? "their own"
              : `${authObject.player_name}'s`
          } chat: "${strippedMessage}". You responded by saying: ${finalResp}`;
          const summaryString = `On ${formattedDate}, ${user} said to you in ${
            user === authObject.player_name
              ? "their own"
              : `${authObject.player_name}'s`
          } chat: "${strippedMessage}". You responded by saying: ${finalResp}`;
          await twitchHelper.maintainChatContext(
            contextString,
            authObject.user_id,
          );
          await aiHelper.addChatMessageAsVector(
            summaryString,
            strippedMessage,
            user,
            formattedDate,
            finalResp,
            authObject.user_id,
          );
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
        response.send({ ...moderationResult, moderation_action: "takeAction" });
      }
    }
  } else {
    response.send({ response: "OK" });
  }
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
    const finalResp = await aiHelper.respondToEvent(data, authObject.user_id);

    if (finalResp) {
      const ttsResponse = authObject.tts_enabled
          ? {
              response: finalResp,
              audio_url: await aiHelper.respondWithVoice(
                finalResp,
                authObject.user_id,
              ),
            }
          : { response: finalResp };
        response.send({ ...ttsResponse });
    } else {
      response.send({ error: "Unsuccessful generation. Try again later." });
    }
  } catch (error) {
    logger.log("API", `Error handling event message: ${error}`);
    response.code(500).send({ error: error.message });
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
 * @param {string} strippedMessage - The message with character names removed.
 * @param {string} moderationResult - The result of the moderation check.
 * @param {string} user - The user who sent the message.
 * @param {string} formattedDate - The formatted date and time of the message.
 * @param {object} response - The response object.
 * @returns {Promise<void>} - A promise that resolves when the response is sent.
 */
async function handleNonChatMessage(
  data,
  authObject,
  strippedMessage,
  moderationResult,
  user,
  formattedDate,
  response,
) {
  const fromBot = await containsAuxBotName(data.user, authObject.user_id);

  if (
    (await twitchHelper.isCommandMatch(data.message, authObject.user_id)) ==
    false
  ) {
    if (containsJailbreakAttempt(strippedMessage)) {
      logger.log("API", `Jailbreak attempt. Not saving.`);
      response.send({ response: "OK" });
    } else if (!fromBot) {
      if (data.firstMessage) {
        if (moderationResult === "safe") {
          const aiResp = await aiHelper.respondToEvent(
            data,
            authObject.user_id,
          );
          const contextString = `On ${formattedDate}, ${user} said in ${
            user === authObject.player_name
              ? "their own"
              : `${authObject.player_name}'s`
          } chat: "${strippedMessage}". You responded by saying: ${aiResp}`;
          const summaryString = `On ${formattedDate}, ${user} said to you in ${
            user === authObject.player_name
              ? "their own"
              : `${authObject.player_name}'s`
          } chat: "${strippedMessage}". You responded by saying: ${aiResp}`;
          await twitchHelper.maintainChatContext(
            contextString,
            authObject.user_id,
          );
          await aiHelper.addChatMessageAsVector(
            summaryString,
            strippedMessage,
            user,
            formattedDate,
            aiResp,
            authObject.user_id,
          );
          logger.log(
            "API",
            `Processing ${data.user}'s message '${strippedMessage}' into vector memory.`,
          );
          const ttsResponse = authObject.tts_enabled
            ? {
                response: aiResp,
                audio_url: await aiHelper.respondWithVoice(
                  aiResp,
                  authObject.user_id,
                ),
              }
            : { response: aiResp };
          response.send({ ...ttsResponse, moderator_action: moderationResult });
        } else {
          response.send({
            ...moderationResult,
            moderation_action: "takeAction",
          });
        }
      } else {
        if (moderationResult === "safe") {
          const summaryString = `On ${formattedDate} ${user} said in ${
            user === authObject.player_name
              ? "their own"
              : `${authObject.player_name}'s`
          } Twitch chat: "${strippedMessage}"`;
          const contextString = `On ${formattedDate}, ${user} said in ${
            user === authObject.player_name
              ? "their own"
              : `${authObject.player_name}'s`
          } chat: "${strippedMessage}"`;
          await twitchHelper.maintainChatContext(
            contextString,
            authObject.user_id,
          );
          await aiHelper.addChatMessageAsVector(
            summaryString,
            strippedMessage,
            user,
            formattedDate,
            "None",
            authObject.user_id,
          );
          logger.log("API", `Processing memory request.`);
          response.send({ response: "OK" });
        } else {
          response.send({
            ...moderationResult,
            moderation_action: "takeAction",
          });
        }
      }
    } else {
      logger.log("API", `Known bot ${data.user}, ignoring.`);
      response.send({ response: "OK" });
    }
  } else {
    response.send({ response: "OK" });
  }
}

export default routes;
