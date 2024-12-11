import moment from 'moment';
import axios, { AxiosHeaders } from 'axios';
import fs from "fs-extra"
import Fastify from "fastify";
import * as aiHelper from './ai-logic.js'
import fastifyFormbody from '@fastify/formbody';
import { join } from 'path';
import cors from '@fastify/cors';
import * as twitchHelper from './twitch_helper.js'
import { filterCharacterFromMessage, containsCharacterName, stripNonStandardSpeech } from './prompt-helper.js';
import { initAllAPIs, checkForAuth, loadAPIKeys, returnAPIKeys, returnAuthObject } from './api-helper.js';
import { maintainVoiceContext } from './data-helper.js';

const fastify = Fastify({
  logger: false,
  requestTimeout: 30000, // 30 seconds
});

fastify.register(cors, {
  origin: true // You can specify specific origins instead of true
});

fastify.addContentTypeParser('application/json', { parseAs: 'string' }, async (req, body) => {
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error('Invalid JSON');
  }
});

fastify.register(fastifyFormbody);

function containsJailbreakAttempt(input) {
  const pattern = /\b(ignore|disregard|bypass|override|forget|delete|remove|disable|break|reset|unlock|nullify|circumvent|destroy)\b\s+(all\s+)?(previous\s+|prior\s+|any\s+)?(instructions?|prompts?|rules?|filters?|limitations?|constraints?|policies?|protocols?|restrictions?|directives?|guidelines?)/i;
  return pattern.test(input);
}

fastify.post('/voicereq', async (request, reply) => {
  const authObject = await checkForAuth(request.headers.authorization.split(' ')[1])
  if (authObject.valid == false) {
    logger.log('API', `Received unauthenticated voice request.`)
    res.status(401).json({
      "success": false,
      "message": "Unauthorized. Please send your API token with this request."
    })
  } else {
    try {
      const data = request.body;
      const now = moment();
      const formattedDate = now.format('MMMM Do [at] h:mmA');
      const finalResp = await aiHelper.findRelevantVoiceInMilvus(data.message, authObject.player_name, authObject.user_id)
      logger.log('Server', `${process.env.USER_NAME} sent a voice message: ${data.message}`)
      if (finalResp !== "") {
        const voiceData = await aiHelper.respondToDirectVoice(data.message, authObject.user_id)
        const summaryString = `On ${formattedDate} ${authObject.player_name} said to you: "${data.message}". You responded to them by saying: ${voiceData.response}`
        maintainVoiceContext(summaryString)
        aiHelper.addVoiceMessageAsVector(summaryString, data.message, authObject.player_name, formattedDate, voiceData.response)
        reply.send(voiceData)
      } else {
        reply.send({ response: "error" })
      }
    } catch (error) {
      reply.code(400).send({ success: false, error: error.message });
    }
  }
});

fastify.post('/chatreq', async (request, response) => {
  const data = request.body
  const authObject = await checkForAuth(request.headers.authorization.split(' ')[1])
  if (authObject.valid == false) {
    logger.log('API', `Received unauthenticated chat request.`)
    res.status(401).json({
      "success": false,
      "message": "Unauthorized. Please send your API token with this request."
    })
  } else {
    logger.log('API', `Received authenticated request from user ${authObject.display_name}`)
    const now = moment();
    const formattedDate = now.format('MMMM Do [at] h:mmA');
    const strippedMessage = await filterCharacterFromMessage(data.message, authObject.user_id)
    var finalResp = ""
    var audioUrl = ""
    const user = await twitchHelper.checkForUser(data.user, authObject.user_id) ? `${authObject.display_name}` : `${data.user}`
    if (await containsCharacterName(data.message, authObject.user_id) && !await containsCharacterName(data.user, authObject.user_id)) {
      if ((await twitchHelper.isCommandMatch(data.message, authObject.user_id)) == false) {
        if (containsJailbreakAttempt(strippedMessage)) {
          logger.log('Server', `Processing message as jailbreak attempt.`)
          const aiJBResp = await aiHelper.respondWithoutContext(`Creatively be mean towards me for trying to stop you from doing your job and ruin ${authObject.player_name}'s stream.`)
          return { response: aiJBResp }
        } else {
          if (data.firstMessage) {
            const aiResp = await aiHelper.respondToEvent(data, authObject.user_id)
            const contextString = `On ${formattedDate}, ${user} said in ${user === authObject.player_name ? 'their own' : `${authObject.player_name}'s`} chat: "${strippedMessage}". You responded by saying: ${aiResp}`
            const summaryString = `On ${formattedDate}, ${user} said to you in ${user === authObject.player_name ? 'their own' : `${authObject.player_name}'s`} chat: "${strippedMessage}". You responded by saying: ${aiResp}`
            await twitchHelper.maintainChatContext(contextString, authObject.user_id)
            aiHelper.addChatMessageAsVector(summaryString, strippedMessage, user, formattedDate, aiResp, authObject.user_id)
            if (authObject.tts_enabled) {
              audioUrl = await aiHelper.respondWithVoice(aiResp, authObject.user_id)
              return { response: aiResp, audio_url: audioUrl }
            } else {
              return { response: aiResp }
            }
          } else {
            finalResp = await aiHelper.respondWithContext(strippedMessage, user, authObject.user_id)
            const contextString = `On ${formattedDate}, ${user} said in ${user === authObject.player_name ? 'their own' : `${authObject.player_name}'s`} chat: "${strippedMessage}". You responded by saying: ${finalResp}`
            const summaryString = `On ${formattedDate}, ${user} said to you in ${user === authObject.player_name ? 'their own' : `${authObject.player_name}'s`} chat: "${strippedMessage}". You responded by saying: ${finalResp}`
            await twitchHelper.maintainChatContext(contextString, authObject.user_id)
            aiHelper.addChatMessageAsVector(summaryString, strippedMessage, user, formattedDate, finalResp, authObject.user_id)
            logger.log('Server', `Processing message as normal.`)
            if (finalResp !== "") {
              if (authObject.tts_enabled) {
                audioUrl = await aiHelper.respondWithVoice(finalResp, authObject.user_id)
                return { response: finalResp, audio_url: audioUrl }
              } else {
                return { response: finalResp }
              }
            } else {
              return { response: "error" }
            }
          }
        }
      } else {
        return { response: "OK" }
      }
    } else if (!(await containsCharacterName(data.message, authObject.user_id)) && !(await containsCharacterName(data.user, authObject.user_id))) {
      if ((await twitchHelper.isCommandMatch(data.message, authObject.user_id)) == false) {
        logger.log('Server', `Processing ${data.user}'s message: ${strippedMessage} into vector memory.`)
        if (containsJailbreakAttempt(strippedMessage)) {
          logger.log('Server', `Jailbreak attempt. Not saving.`)
          return { response: "OK" }
        } else {
          if (data.firstMessage) {
            const aiResp = await aiHelper.respondToEvent(data, authObject.user_id)
            const contextString = `On ${formattedDate}, ${user} said in ${user === authObject.player_name ? 'their own' : `${authObject.player_name}'s`} chat: "${strippedMessage}". You responded by saying: ${aiResp}`
            const summaryString = `On ${formattedDate}, ${user} said to you in ${user === authObject.player_name ? 'their own' : `${authObject.player_name}'s`} chat: "${strippedMessage}". You responded by saying: ${aiResp}`
            twitchHelper.maintainChatContext(contextString, authObject.user_id)
            aiHelper.addChatMessageAsVector(summaryString, strippedMessage, user, formattedDate, aiResp, authObject.user_id)
            if (authObject.tts_enabled) {
              const audioUrl = await aiHelper.respondWithVoice(aiResp, authObject.user_id)
              return { response: aiResp, audio_url: audioUrl }
            } else {
              return { response: aiResp }
            }
          } else {
            const summaryString = `On ${formattedDate} ${user} said in ${user === authObject.player_name ? 'their own' : `${authObject.player_name}'s`} Twitch chat: "${strippedMessage}"`
            const contextString = `On ${formattedDate}, ${user} said in ${user === authObject.player_name ? 'their own' : `${authObject.player_name}'s`} chat: "${strippedMessage}"`
            twitchHelper.maintainChatContext(contextString, authObject.user_id)
            aiHelper.addChatMessageAsVector(summaryString, strippedMessage, user, formattedDate, "None", authObject.user_id)
            logger.log('Server', `Processing memory request.`)
            return { response: "OK" }
          }
        }
      } else {
        return { response: "OK" }
      }
    } else {
      return { response: "OK" }
    }
  }
})

fastify.get('/wake-sounds', async (request, reply) => {
  try {
    const soundsPath = join(process.cwd(), 'sound_assets');
    const files = await fs.readdir(soundsPath);

    // Filter for audio files (you can adjust the extensions as needed)
    const audioFiles = files.filter(file =>
      file.endsWith('.wav') ||
      file.endsWith('.mp3') ||
      file.endsWith('.ogg')
    );

    // Return the list of files with their full web paths
    return audioFiles.map(file => `/sounds/${file}`);
  } catch (error) {
    reply.code(500).send({ error: 'Failed to list sound files' });
  }
});

fastify.post('/eventreq', async (request, response) => {
  const authObject = await checkForAuth(request.headers.authorization.split(' ')[1])
  if (authObject.valid == false) {
    logger.log('API', `Received unauthenticated event request.`)
    res.status(401).json({
      "success": false,
      "message": "Unauthorized. Please send your API token with this request."
    })
  } else {
    const data = request.body
    var finalResp = ""
    logger.log('Server', `A Twitch event fired for ${authObject.user_id}, type: ${data.eventType}`)
    finalResp = await aiHelper.respondToEvent(data, authObject.user_id)
    if (finalResp !== "" || finalResp !== undefined) {
      if (authObject.tts_enabled) {
        const audioUrl = await aiHelper.respondWithVoice(finalResp, authObject.user_id)
        return { response: finalResp, audio_url: audioUrl }
      } else {
        return { response: finalResp }
      }
    } else {
      return { response: "error" }
    }
  }
});

fastify.get('/healthcheck', async (request, response) => {
  response.send(200)
});

async function preflightChecks() {

  const allTalkRes = await axios.get(process.env.ALLTALK_BASE + '/api/ready')
  const restAPIRes = await axios.get('http://127.0.0.1:' + process.env.SERVER_PORT_NUMBER + '/healthcheck')
  const databaseRes = await aiHelper.checkMilvusHealth();

  let checkResult = {
    llmStatuses: {
      allTalkIsOnline: allTalkRes.status == 200 ? true : false,
      embeddingIsOnline: await aiHelper.checkEndpoint(process.env.EMBEDDING_ENDPOINT, process.env.EMBEDDING_API_KEY, process.env.EMBEDDING_MODEL),
      llmIsOnline: await aiHelper.checkEndpoint(process.env.CHAT_COMPLETION_URL, process.env.CHAT_COMPLETION_KEY, process.env.CHAT_COMPLETION_MODEL),
      summaryIsOnline: await aiHelper.checkEndpoint(process.env.SUMMARY_ENDPOINT, process.env.SUMMARY_API_KEY, process.env.SUMMARY_MODEL),
      queryIsOnline: await aiHelper.checkEndpoint(process.env.QUERY_ENDPOINT, process.env.QUERY_API_KEY, process.env.QUERY_MODEL),
      conversionIsOnline: await aiHelper.checkEndpoint(process.env.CONVERSION_ENDPOINT, process.env.CONVERSION_API_KEY, process.env.CONVERSION_MODEL)
    },
    restIsOnline: restAPIRes.status == 200 ? true : false,
    dbIsOnline: databaseRes
  }
  process.send({ type: 'preflight', data: checkResult });
}

async function launchRest() {
  try {

    fastify.listen({ port: process.env.SERVER_PORT_NUMBER, host: "::" })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}
await loadAPIKeys().then(async function () {
  const allObjects = await returnAPIKeys()
  for await (const obj of allObjects) {
    await aiHelper.startIndexingVectors(obj.user_id);
  }
  await launchRest();
  await preflightChecks();
  await initAllAPIs()
})
