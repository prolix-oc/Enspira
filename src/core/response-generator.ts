/**
 * Response Generator
 * Handles voice/TTS responses, event responses, and endpoint health checks
 */

import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import FormData from 'form-data';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

import { logger } from './logger.js';
import { retrieveConfigValue } from './config.js';
import { returnAuthObject } from './api-helper.js';
import {
  findRelevantDocuments,
  findRelevantVoiceInMilvus,
  addVoiceMessageAsVector,
} from './rag-context.js';
import { resultsReranked } from './data-helper.js';
import { contextPromptChat, eventPromptChat } from './prompt-builder.js';
import { replyStripped, fixTTSString } from './message-utils.js';
import { sendChatCompletionRequest } from './llm-client.js';
import {
  respondWithContextAndExpressions,
  getUserExpressions,
} from './ai-engine.js';
import { processResponseWithExpressions } from './expression-parser.js';
import { processAudio } from '../../audio-processor.js';
import { returnTwitchEvent } from '../integrations/twitch/helper.js';

import type {
  VoiceResponseResult,
  FishTTSParameters,
  EventResponseResult,
  ModelConfig,
  PromptContextData,
} from '@/types/ai.types.js';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== TTS GENERATION ====================

/**
 * Generate TTS audio from text
 */
export async function respondWithVoice(
  message: string,
  userId: string
): Promise<string | { error: string }> {
  const startTime = performance.now();

  const fixedAcro = await fixTTSString(message);
  const userObj = (await returnAuthObject(userId)) as {
    bot_name?: string;
    fishTTSVoice?: string;
    speaker_file?: string;
    user_id?: string;
    is_local?: boolean;
    ttsUpsamplePref?: boolean;
    ttsEqPref?: string;
    user_name?: string;
  } | null;

  if (!userObj) {
    return { error: 'User not found' };
  }

  logger.log(
    'LLM',
    `Converted ${fixedAcro.acronymCount} acronyms in ${userObj.bot_name}'s TTS message.`
  );

  try {
    const tempDir = path.join(__dirname, '../../temp');
    await fs.mkdir(tempDir, { recursive: true }).catch(() => {});

    const ttsPreference = await retrieveConfigValue('ttsPreference');

    let audioFilePath: string;
    let outputFileName: string;
    let externalGenUrl: string | undefined;
    let internalGenUrl: string | undefined;

    if (ttsPreference === 'fish') {
      const fishParameters: FishTTSParameters = {
        text: fixedAcro.fixedString,
        chunk_length: 400,
        format: 'wav',
        reference_id: userObj.fishTTSVoice || '',
        seed: null,
        normalize: false,
        streaming: false,
        max_new_tokens: 4096,
        top_p: 0.82,
        repetition_penalty: 1.2,
        temperature: 0.75,
      };

      const res = await axios.post(
        String(await retrieveConfigValue('fishTTS.ttsGenEndpoint.internal')),
        fishParameters,
        { responseType: 'arraybuffer' }
      );

      outputFileName = `fish_${userId}_${Date.now()}.wav`;
      const tempFilePath = path.join('./final', outputFileName);
      await fs.writeFile(tempFilePath, Buffer.from(res.data as ArrayBuffer));

      audioFilePath = tempFilePath;
    } else {
      const voiceForm = new FormData();
      voiceForm.append('text_input', fixedAcro.fixedString);
      voiceForm.append('text_filtering', 'standard');
      voiceForm.append('character_voice_gen', userObj.speaker_file || '');
      voiceForm.append('narrator_enabled', 'false');
      voiceForm.append('text_not_inside', 'character');
      voiceForm.append('language', 'en');
      voiceForm.append('output_file_name', userObj.user_id || '');
      voiceForm.append('output_file_timestamp', 'true');
      voiceForm.append('autoplay', 'false');
      voiceForm.append('temperature', '0.9');
      voiceForm.append('repetition_penalty', '1.5');

      const res = await axios.post(
        String(await retrieveConfigValue('alltalk.ttsGenEndpoint.internal')),
        voiceForm
      );

      internalGenUrl = `${await retrieveConfigValue('alltalk.ttsServeEndpoint.internal')}${res.data.output_file_url}`;
      externalGenUrl = `${await retrieveConfigValue('alltalk.ttsServeEndpoint.external')}${res.data.output_file_url}`;

      const fileRes = await axios({
        method: 'GET',
        url: `${await retrieveConfigValue('alltalk.ttsServeEndpoint.internal')}${res.data.output_file_url}`,
        responseType: 'arraybuffer',
      });

      outputFileName = `${userId}_${Date.now()}.wav`;
      const tempFilePath = path.join('./final', outputFileName);
      await fs.writeFile(tempFilePath, Buffer.from(fileRes.data as ArrayBuffer));

      audioFilePath = tempFilePath;
    }

    const timeElapsed = (performance.now() - startTime) / 1000;

    if (userObj.ttsUpsamplePref) {
      try {
        const processedFilePath = processAudio(audioFilePath, {
          preset: userObj.ttsEqPref || 'clarity',
          userId: userObj.user_id,
        });

        logger.log('API', `Processed audio file to ${processedFilePath}`);

        const serviceEndpoint =
          ttsPreference === 'fish' ? 'fishTTS' : 'alltalk';
        const audioUrl = userObj.is_local ? internalGenUrl : externalGenUrl;

        logger.log(
          'LLM',
          `TTS request completed in ${timeElapsed.toFixed(2)} seconds.`
        );
        return audioUrl || processedFilePath;
      } catch (processingError) {
        logger.error(
          'API',
          `Error processing audio: ${(processingError as Error).message}`
        );
        const serviceEndpoint =
          ttsPreference === 'fish' ? 'fishTTS' : 'alltalk';
        return userObj.is_local
          ? `${await retrieveConfigValue(`${serviceEndpoint}.ttsServeEndpoint.internal`)}/${path.basename(audioFilePath)}`
          : `${await retrieveConfigValue(`${serviceEndpoint}.ttsServeEndpoint.external`)}/${path.basename(audioFilePath)}`;
      }
    } else {
      const audioUrl = userObj.is_local ? internalGenUrl : externalGenUrl;

      logger.log(
        'LLM',
        `TTS request completed in ${timeElapsed.toFixed(2)} seconds.`
      );
      return audioUrl || `/${path.basename(audioFilePath)}`;
    }
  } catch (error) {
    logger.error('TTS', `Error during TTS request: ${(error as Error).message}`);
    return { error: (error as Error).message };
  }
}

// ==================== VOICE INTERACTION ====================

/**
 * Respond to direct voice interaction
 */
export async function respondToDirectVoice(
  message: string,
  userId: string,
  withVoice: boolean = false
): Promise<VoiceResponseResult> {
  try {
    logger.log(
      'Voice',
      `Processing voice interaction for user ${userId}: "${message.substring(0, 50)}..."`
    );

    const userObj = (await returnAuthObject(userId)) as {
      user_name?: string;
      user_id?: string;
    } | null;
    if (!userObj) {
      throw new Error(`User ${userId} not found`);
    }

    // Enhanced parallel processing for voice context
    const [voiceCtx, rawContext] = await Promise.allSettled([
      findRelevantVoiceInMilvus(message, userId, 3),
      findRelevantDocuments(message, userId, 6),
    ]);

    const voiceResults = voiceCtx.status === 'fulfilled' ? voiceCtx.value : [];
    const contextResults =
      rawContext.status === 'fulfilled' ? rawContext.value : [];

    logger.log(
      'Voice',
      `Voice context search completed for user ${userId}. Voice: ${voiceResults.length}, Context: ${contextResults.length}`
    );

    // Enhanced reranking with error handling
    const [contextBody, voiceCtxBody] = await Promise.allSettled([
      resultsReranked(contextResults, message, userId, true),
      withVoice
        ? resultsReranked(voiceResults, message, userId, false)
        : Promise.resolve('- No additional voice conversations to supply.'),
    ]);

    const finalContextBody =
      contextBody.status === 'fulfilled'
        ? contextBody.value
        : '- No additional context available due to processing error.';
    const finalVoiceBody =
      voiceCtxBody.status === 'fulfilled'
        ? voiceCtxBody.value
        : '- No additional voice conversations to supply.';

    const promptData: PromptContextData = {
      relChats: '- No additional chat content.',
      relContext: finalContextBody as string,
      relVoice: finalVoiceBody as string,
      chat_user: userObj.user_name || 'User',
      user: userObj.user_name,
    };

    logger.log('Voice', `Generating voice response for user ${userId}`);

    const body = await contextPromptChat(promptData, message, userId);
    const chatTask = await sendChatCompletionRequest(
      body,
      (await retrieveConfigValue('models.chat')) as ModelConfig
    );

    if (!chatTask.response) {
      throw new Error('No response generated for voice interaction');
    }

    await fs.writeFile(
      './chat_cmp_resp.json',
      JSON.stringify(chatTask.response, null, 2)
    );

    logger.log(
      'Voice',
      `Voice response generated for user ${userId}. Time to first token: ${chatTask.timeToFirstToken} seconds. Process speed: ${chatTask.tokensPerSecond}tps`
    );

    const strippedResp = await replyStripped(chatTask.response, userId);

    // Store voice interaction in vectors
    try {
      const formattedDate = new Date().toLocaleString();
      const summaryString = `On ${formattedDate}, ${userObj.user_name} said via voice: "${message}". You responded by saying: ${strippedResp}`;

      addVoiceMessageAsVector(
        summaryString,
        message,
        userObj.user_name || '',
        formattedDate,
        strippedResp,
        userId
      ).catch((err) =>
        logger.error('Voice', `Error storing voice vector: ${(err as Error).message}`)
      );
    } catch (vectorError) {
      logger.error(
        'Voice',
        `Error preparing voice vector: ${(vectorError as Error).message}`
      );
    }

    if (withVoice) {
      logger.log('Voice', `Generating TTS audio for user ${userId}`);
      const audioUrl = await respondWithVoice(strippedResp, userId);
      return {
        response: strippedResp,
        audio_url: typeof audioUrl === 'string' ? audioUrl : undefined,
        thoughtProcess: chatTask.thoughtProcess,
      };
    } else {
      return {
        response: strippedResp,
        thoughtProcess: chatTask.thoughtProcess,
      };
    }
  } catch (error) {
    logger.error(
      'Voice',
      `Error in respondToDirectVoice for user ${userId}: ${(error as Error).message}`
    );
    return {
      response:
        "I'm sorry, I'm having trouble processing voice interactions right now. Please try again.",
      error: (error as Error).message,
    };
  }
}

/**
 * Enhanced voice response with expression support
 */
export async function respondToDirectVoiceWithExpressions(
  message: string,
  userId: string,
  withVoice: boolean = false
): Promise<VoiceResponseResult> {
  try {
    logger.log(
      'Voice',
      `Processing voice interaction with expressions for user ${userId}: "${message.substring(0, 50)}..."`
    );

    const userObj = (await returnAuthObject(userId)) as {
      user_name?: string;
      user_id?: string;
    } | null;
    if (!userObj) {
      throw new Error(`User ${userId} not found`);
    }

    // Get available expressions for this user
    const availableExpressions = getUserExpressions(userId);

    // Enhanced parallel processing for voice context
    const [voiceCtx, rawContext] = await Promise.allSettled([
      findRelevantVoiceInMilvus(message, userId, 3),
      findRelevantDocuments(message, userId, 6),
    ]);

    const voiceResults = voiceCtx.status === 'fulfilled' ? voiceCtx.value : [];
    const contextResults =
      rawContext.status === 'fulfilled' ? rawContext.value : [];

    logger.log(
      'Voice',
      `Voice context search completed for user ${userId}. Voice: ${voiceResults.length}, Context: ${contextResults.length}`
    );

    // Enhanced reranking with error handling
    const [contextBody, voiceCtxBody] = await Promise.allSettled([
      resultsReranked(contextResults, message, userId, true),
      withVoice
        ? resultsReranked(voiceResults, message, userId, false)
        : Promise.resolve('- No additional voice conversations to supply.'),
    ]);

    const finalContextBody =
      contextBody.status === 'fulfilled'
        ? contextBody.value
        : '- No additional context available due to processing error.';
    const finalVoiceBody =
      voiceCtxBody.status === 'fulfilled'
        ? voiceCtxBody.value
        : '- No additional voice conversations to supply.';

    const promptData: PromptContextData = {
      relChats: '- No additional chat content.',
      relContext: finalContextBody as string,
      relVoice: finalVoiceBody as string,
      chat_user: userObj.user_name || 'User',
      user: userObj.user_name,
    };

    logger.log(
      'Voice',
      `Generating voice response with expressions for user ${userId}`
    );

    // Use enhanced prompt generation from ai-engine
    const response = await respondWithContextAndExpressions(
      message,
      userObj.user_name || '',
      userId,
      availableExpressions
    );

    if (!response.success || !response.cleanText) {
      throw new Error('No response generated for voice interaction');
    }

    const finalText = response.cleanText;

    // Store voice interaction in vectors
    try {
      const formattedDate = new Date().toLocaleString();
      const summaryString = `On ${formattedDate}, ${userObj.user_name} said via voice: "${message}". You responded by saying: ${finalText}`;

      addVoiceMessageAsVector(
        summaryString,
        message,
        userObj.user_name || '',
        formattedDate,
        finalText,
        userId
      ).catch((err) =>
        logger.error('Voice', `Error storing voice vector: ${(err as Error).message}`)
      );
    } catch (vectorError) {
      logger.error(
        'Voice',
        `Error preparing voice vector: ${(vectorError as Error).message}`
      );
    }

    if (withVoice) {
      logger.log('Voice', `Generating TTS audio for user ${userId}`);
      const audioUrl = await respondWithVoice(finalText, userId);

      return {
        response: finalText,
        expressions: response.expressions,
        estimatedDuration: response.estimatedDuration || 0,
        audio_url: typeof audioUrl === 'string' ? audioUrl : undefined,
        thoughtProcess: response.thoughtProcess,
        debug: response.debug,
      };
    } else {
      return {
        response: finalText,
        expressions: response.expressions,
        estimatedDuration: response.estimatedDuration || 0,
        thoughtProcess: response.thoughtProcess,
        debug: response.debug,
      };
    }
  } catch (error) {
    logger.error(
      'Voice',
      `Error in respondToDirectVoiceWithExpressions for user ${userId}: ${(error as Error).message}`
    );
    return {
      response:
        "I'm sorry, I'm having trouble processing voice interactions right now. Please try again.",
      expressions: [],
      error: (error as Error).message,
    };
  }
}

// ==================== EVENT RESPONSES ====================

/**
 * Respond to a Twitch event
 */
export async function respondToEvent(
  event: { eventType: string; [key: string]: unknown },
  userId: string
): Promise<EventResponseResult> {
  try {
    // Ensure event has required InternalTwitchEvent structure
    const { eventType, ...restEvent } = event;
    const normalizedEvent = {
      ...restEvent,
      eventType,
      eventData: (event as { eventData?: Record<string, unknown> }).eventData ?? event,
    };
    const eventMessage = await returnTwitchEvent(normalizedEvent, userId);
    const instructPrompt = await eventPromptChat(eventMessage, userId);

    const chatTask = await sendChatCompletionRequest(
      instructPrompt,
      (await retrieveConfigValue('models.chat')) as ModelConfig
    );
    logger.log(
      'LLM',
      `Generated event response. Time to first token: ${chatTask.timeToFirstToken} seconds. Process speed: ${chatTask.tokensPerSecond}tps`
    );

    const strippedResp = await replyStripped(chatTask.response || '', userId);
    return { response: strippedResp, thoughtProcess: chatTask.thoughtProcess };
  } catch (error) {
    logger.log('System', `Error in respondToEvent: ${error}`);
    return {
      response: "I'm sorry, I encountered an error processing this event.",
      thoughtProcess: `Error: ${(error as Error).message}`,
    };
  }
}

// ==================== ENDPOINT HEALTH CHECKS ====================

/**
 * Check if an LLM endpoint is healthy
 */
export async function checkEndpoint(
  endpoint: string,
  key: string,
  modelName: string
): Promise<boolean> {
  try {
    if (endpoint === (await retrieveConfigValue('models.embedding.endpoint'))) {
      if (
        (await retrieveConfigValue('models.embedding.apiKeyType')) ===
        'infinity'
      ) {
        const response = await axios.get(`${endpoint}/models`, {
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          validateStatus: (status) => status < 500,
        });

        if (
          response.status === 200 &&
          response.data &&
          Array.isArray(response.data.data)
        ) {
          const modelFound = response.data.data.some(
            (model: { id: string }) => model.id === modelName
          );
          if (modelFound) {
            return true;
          } else {
            throw new Error(
              `Model ${modelName} not found in the list of available models.`
            );
          }
        } else {
          throw new Error(
            `Invalid response from embedding endpoint: ${response.status}`
          );
        }
      } else if (
        (await retrieveConfigValue('models.embedding.apiKeyType')) ===
        'enspiraEmb'
      ) {
        const response = await axios.get(
          `${await retrieveConfigValue('models.embedding.endpoint')}/health`,
          {
            headers: {
              Authorization: `Bearer ${await retrieveConfigValue('models.embedding.apiKey')}`,
            },
          }
        );
        if (response.status === 200) {
          return true;
        } else {
          return false;
        }
      }
    } else {
      const openai = new OpenAI({
        baseURL: endpoint,
        apiKey: key,
      });
      const response = await openai.models.list();
      if (
        response.data &&
        Array.isArray(response.data) &&
        response.data.length > 0
      ) {
        return true;
      } else {
        throw new Error(`Invalid or empty response from LLM endpoint`);
      }
    }
    return false;
  } catch (err) {
    logger.log('INIT', `Error checking endpoint ${endpoint}: ${err}`);
    return false;
  }
}

/**
 * Validate JSON input
 */
export function isValidJson(input: unknown): boolean {
  if (typeof input === 'string') {
    try {
      JSON.parse(input);
      return true;
    } catch {
      return false;
    }
  } else if (typeof input === 'object' && input !== null) {
    return true;
  }
  return false;
}
