import fastifyWebsocket from '@fastify/websocket';
import { checkForAuth } from '../api-helper.js';
import { respondToChat, respondWithVoice } from '../ai-logic.js';
import { logger } from '../create-global-logger.js';
import { retrieveConfigValue } from '../config-helper.js';

/**
 * WebSocket route for VTuber application integration
 * Provides real-time bidirectional communication for AI chat and TTS
 */
async function websocketVTuberRoute(fastify, options) {
  // Register WebSocket support
  await fastify.register(fastifyWebsocket);

  // Connection state management
  const connections = new Map();
  const heartbeatInterval = 30000; // 30 seconds
  
  /**
   * Validates and authenticates WebSocket messages
   * @param {Object} message - Incoming WebSocket message
   * @returns {Promise<Object|null>} - User object if valid, null otherwise
   */
  async function authenticateMessage(message) {
    if (!message.auth_token) {
      return null;
    }

    try {
      const authResult = await checkForAuth(message.auth_token);
      return authResult.valid ? authResult : null;
    } catch (error) {
      logger.error('WebSocket', `Authentication error: ${error.message}`);
      return null;
    }
  }

  /**
   * Sends a message to WebSocket client with error handling
   * @param {WebSocket} socket - WebSocket connection
   * @param {Object} message - Message to send
   */
  function sendMessage(socket, message) {
    if (socket.readyState === socket.OPEN) {
      try {
        socket.send(JSON.stringify({
          timestamp: new Date().toISOString(),
          ...message
        }));
      } catch (error) {
        logger.error('WebSocket', `Failed to send message: ${error.message}`);
      }
    }
  }

  /**
   * Generates unique response ID for tracking
   * @returns {string} - Unique response identifier
   */
  function generateResponseId() {
    return `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Main WebSocket route handler
   */
  fastify.register(async function (fastify) {
    fastify.get('/ws-client', { websocket: true }, async (connection, request) => {
      const { socket } = connection;
      const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      
      logger.log('WebSocket', `New client connected: ${clientId}`);

      // Initialize connection state
      const connectionState = {
        id: clientId,
        socket,
        user: null,
        isAuthenticated: false,
        lastPingTime: Date.now(),
        modelInfo: null,
        currentResponseId: null
      };

      connections.set(clientId, connectionState);

      // Setup heartbeat for this connection
      const heartbeat = setInterval(() => {
        if (socket.readyState === socket.OPEN) {
          sendMessage(socket, { type: 'ping' });
          
          // Check for stale connections (no pong response in 60 seconds)
          if (Date.now() - connectionState.lastPingTime > 60000) {
            logger.warn('WebSocket', `Connection ${clientId} appears stale, closing`);
            socket.close(1000, 'Connection timeout');
          }
        } else {
          clearInterval(heartbeat);
        }
      }, heartbeatInterval);

      // Request authentication immediately
      sendMessage(socket, { type: 'auth-required' });

      // Handle incoming messages
      socket.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());
          
          logger.log('WebSocket', `Received message type: ${message.type} from ${clientId}`);

          // Handle authentication for all message types
          if (!connectionState.isAuthenticated && message.type !== 'ping' && message.type !== 'pong') {
            const user = await authenticateMessage(message);
            
            if (!user) {
              sendMessage(socket, { 
                type: 'auth-failed',
                message: 'Invalid or missing authentication token'
              });
              return;
            }

            connectionState.user = user;
            connectionState.isAuthenticated = true;
            
            sendMessage(socket, { 
              type: 'auth-success',
              message: 'Authentication successful'
            });
            
            logger.log('WebSocket', `Client ${clientId} authenticated as user: ${user.user_id}`);
          }

          // Process different message types
          switch (message.type) {
            case 'ping':
              sendMessage(socket, { type: 'pong' });
              break;

            case 'pong':
              connectionState.lastPingTime = Date.now();
              break;

            case 'model-info':
              if (connectionState.isAuthenticated && message.model_info) {
                connectionState.modelInfo = message.model_info;
                logger.log('WebSocket', `Model info received for ${clientId}: ${message.model_info.name}`);
              }
              break;

            case 'text-input':
              await handleTextInput(connectionState, message);
              break;

            case 'interrupt':
              handleInterrupt(connectionState);
              break;

            default:
              logger.warn('WebSocket', `Unknown message type: ${message.type} from ${clientId}`);
              sendMessage(socket, {
                type: 'error',
                message: `Unknown message type: ${message.type}`
              });
          }

        } catch (error) {
          logger.error('WebSocket', `Error processing message from ${clientId}: ${error.message}`);
          sendMessage(socket, {
            type: 'error',
            message: 'Failed to process message'
          });
        }
      });

      // Handle connection close
      socket.on('close', (code, reason) => {
        logger.log('WebSocket', `Client ${clientId} disconnected: ${code} - ${reason}`);
        clearInterval(heartbeat);
        connections.delete(clientId);
      });

      // Handle connection errors
      socket.on('error', (error) => {
        logger.error('WebSocket', `Socket error for ${clientId}: ${error.message}`);
        clearInterval(heartbeat);
        connections.delete(clientId);
      });
    });
  });

  /**
   * Handles text input messages and generates AI responses
   * @param {Object} connectionState - Connection state object
   * @param {Object} message - Incoming text input message
   */
  async function handleTextInput(connectionState, message) {
    const { socket, user, modelInfo } = connectionState;
    
    if (!message.text || !message.text.trim()) {
      sendMessage(socket, {
        type: 'error',
        message: 'Empty text input received'
      });
      return;
    }

    const responseId = generateResponseId();
    connectionState.currentResponseId = responseId;

    try {
      // Notify client that response is being generated
      sendMessage(socket, {
        type: 'response-queued',
        response_id: responseId
      });

      logger.log('WebSocket', `Processing text input for user ${user.user_id}: "${message.text}"`);

      // Generate AI response using existing chat framework
      const chatResponse = await respondToChat({
        message: message.text,
        user: user.user_name || 'User'
      }, user.user_id);

      if (!chatResponse.success) {
        throw new Error(chatResponse.error || 'Failed to generate response');
      }

      // Send the full text response
      sendMessage(socket, {
        type: 'full-text',
        text: chatResponse.text,
        response_id: responseId
      });

      // Check if TTS is enabled for this user
      if (user.tts_enabled) {
        await generateAndSendAudio(connectionState, chatResponse.text, responseId);
      }

    } catch (error) {
      logger.error('WebSocket', `Error processing text input for ${user.user_id}: ${error.message}`);
      
      sendMessage(socket, {
        type: 'error',
        message: 'Failed to generate response',
        response_id: responseId
      });
    }
  }

  /**
   * Generates TTS audio and sends it to the client
   * @param {Object} connectionState - Connection state object
   * @param {string} text - Text to convert to speech
   * @param {string} responseId - Response ID for tracking
   */
  async function generateAndSendAudio(connectionState, text, responseId) {
    const { socket, user, modelInfo } = connectionState;

    try {
      // Notify client that TTS synthesis is starting
      sendMessage(socket, {
        type: 'synthesis-started',
        response_id: responseId
      });

      logger.log('WebSocket', `Generating TTS audio for user ${user.user_id}`);

      // Generate audio using existing TTS framework
      const audioResult = await respondWithVoice(text, user.user_id);

      if (audioResult.error) {
        throw new Error(audioResult.error);
      }

      // Read the audio file and convert to base64
      const audioBase64 = await convertAudioToBase64(audioResult);

      // Notify client that synthesis is complete
      sendMessage(socket, {
        type: 'synthesis-complete',
        response_id: responseId
      });

      // Prepare display text object
      const displayText = {
        text: text,
        name: user.bot_name || 'Assistant',
        avatar: user.avatar_url || ''
      };

      // Prepare actions (expressions) if model info is available
      const actions = {};
      if (modelInfo && modelInfo.expressions && Array.isArray(modelInfo.expressions)) {
        // Select appropriate expressions based on the text content
        actions.expressions = selectExpressions(text, modelInfo.expressions);
      }

      // Send the audio response
      sendMessage(socket, {
        type: 'audio',
        audio: audioBase64,
        display_text: displayText,
        actions: Object.keys(actions).length > 0 ? actions : undefined,
        response_id: responseId
      });

      logger.log('WebSocket', `Audio response sent for user ${user.user_id}`);

    } catch (error) {
      logger.error('WebSocket', `Error generating audio for ${user.user_id}: ${error.message}`);
      
      sendMessage(socket, {
        type: 'error',
        message: 'Failed to generate audio response',
        response_id: responseId
      });
    }
  }

  /**
   * Handles interrupt requests from client
   * @param {Object} connectionState - Connection state object
   */
  function handleInterrupt(connectionState) {
    const { socket, user } = connectionState;
    
    logger.log('WebSocket', `Interrupt received from user ${user?.user_id || 'unknown'}`);
    
    // Clear any ongoing response
    connectionState.currentResponseId = null;
    
    // Acknowledge the interrupt
    sendMessage(socket, {
      type: 'interrupt',
      message: 'Response interrupted'
    });
  }

  /**
   * Converts audio file/URL to base64 format
   * @param {string} audioResult - Audio file path or URL
   * @returns {Promise<string>} - Base64 encoded audio
   */
  async function convertAudioToBase64(audioResult) {
    try {
      const fs = await import('fs-extra');
      const path = await import('path');
      const axios = await import('axios');

      // Check if it's a URL or file path
      if (audioResult.startsWith('http')) {
        // Download the audio file
        const response = await axios.default({
          method: 'GET',
          url: audioResult,
          responseType: 'arraybuffer'
        });
        
        return Buffer.from(response.data).toString('base64');
      } else {
        // Read local file
        const audioPath = path.resolve(audioResult);
        const audioBuffer = await fs.readFile(audioPath);
        return audioBuffer.toString('base64');
      }
    } catch (error) {
      logger.error('WebSocket', `Error converting audio to base64: ${error.message}`);
      throw error;
    }
  }

  /**
   * Selects appropriate expressions based on text content and available model expressions
   * @param {string} text - The text being spoken
   * @param {Array} availableExpressions - Available expressions from the model
   * @returns {Array} - Selected expressions
   */
  function selectExpressions(text, availableExpressions) {
    // Simple emotion detection based on text content
    const emotionKeywords = {
      happy: ['happy', 'joy', 'excited', 'great', 'awesome', 'wonderful', 'amazing', '!', '😊', '😄'],
      sad: ['sad', 'sorry', 'disappointed', 'unfortunate', 'regret', '😢', '😞'],
      surprised: ['wow', 'amazing', 'incredible', 'unbelievable', 'surprise', '!', '😮', '😲'],
      angry: ['angry', 'frustrated', 'annoyed', 'mad', 'irritated', '😠', '😡'],
      neutral: ['hello', 'hi', 'okay', 'alright', 'yes', 'no', 'maybe']
    };

    const textLower = text.toLowerCase();
    let detectedEmotion = 'neutral';
    let maxMatches = 0;

    // Find the emotion with the most keyword matches
    for (const [emotion, keywords] of Object.entries(emotionKeywords)) {
      const matches = keywords.filter(keyword => textLower.includes(keyword)).length;
      if (matches > maxMatches) {
        maxMatches = matches;
        detectedEmotion = emotion;
      }
    }

    // Map detected emotion to available expressions
    const expressionMapping = {
      happy: ['smile', 'happy', 'joy', 'cheerful', 0, 1], // Common happy expression indices
      sad: ['sad', 'disappointed', 'down', 2, 3],
      surprised: ['surprised', 'shock', 'amazed', 4, 5],
      angry: ['angry', 'mad', 'annoyed', 6, 7],
      neutral: ['neutral', 'default', 'calm', 8, 9]
    };

    const possibleExpressions = expressionMapping[detectedEmotion] || expressionMapping.neutral;
    
    // Find matching expressions from available model expressions
    const selectedExpressions = [];
    
    for (const expr of possibleExpressions) {
      if (availableExpressions.includes(expr)) {
        selectedExpressions.push(expr);
        break; // Only select the first matching expression
      }
    }

    // If no specific expression found, try to use a default
    if (selectedExpressions.length === 0 && availableExpressions.length > 0) {
      // Use first available expression as fallback
      selectedExpressions.push(availableExpressions[0]);
    }

    return selectedExpressions;
  }

  /**
   * Cleanup function for graceful shutdown
   */
  async function cleanup() {
    logger.log('WebSocket', 'Cleaning up WebSocket connections...');
    
    for (const [clientId, connectionState] of connections) {
      try {
        sendMessage(connectionState.socket, {
          type: 'error',
          message: 'Server is shutting down'
        });
        connectionState.socket.close(1000, 'Server shutdown');
      } catch (error) {
        logger.error('WebSocket', `Error closing connection ${clientId}: ${error.message}`);
      }
    }
    
    connections.clear();
  }

  // Register cleanup on server shutdown
  fastify.addHook('onClose', cleanup);

  logger.log('WebSocket', 'VTuber WebSocket route registered at /ws-client');
}

export default websocketVTuberRoute;