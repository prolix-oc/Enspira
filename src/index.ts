/**
 * Main Fastify server entry point
 * Handles HTTP/HTTPS server setup, WebSocket connections, and route registration
 */

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs-extra';
import { join } from 'path';
import * as crypto from 'crypto';
import type { WebSocket } from 'ws';

// Route imports
import { audioRoutes } from './routes/audio.js';
import twitchEventSubRoutes from './routes/twitch.js';
import webRoutes from './routes/web.js';
import routes from './routes/v1.js';

// Core imports
import * as aiHelper from './core/ai-engine.js';
import * as vectorDb from './core/vector-db.js';
import * as responseGenerator from './core/response-generator.js';
import * as embeddings from './core/embeddings.js';
import { initAllAPIs, returnAPIKeys, checkForAuth, returnAuthObject } from './core/api-helper.js';
import { retrieveConfigValue, loadConfig } from './core/config.js';
import { setupTemplating } from '../template-engine.js';

// Logger
import { logger } from './core/logger.js';

// Type imports
import type {
  ServerOptions,
  ConnectionLimits,
  RateLimitData,
  ModelInfo,
  WebSocketMessage,
  OutgoingWebSocketMessage,
  SendMessageResult,
  ConnectionValidation,
  WebSocketStatusResponse,
  ConnectionInfo,
  LLMStatuses,
  PreflightResult,
  InitializeResult,
  AuthResult,
  AlternateSpelling,
  EmotionType,
  EmotionKeywords,
  ExpressionMapping,
  EventListenerEntry,
} from './types/server.types.js';

// ==================== ERROR HANDLERS ====================

process.on('uncaughtException', (err: Error) => {
  logger.error('System', `UNCAUGHT EXCEPTION: ${err.message}`);
  logger.error('System', `Stack trace: ${err.stack}`);
});

process.on('unhandledRejection', (reason: unknown) => {
  const reasonObj = reason as Error | null;
  logger.error('System', `UNHANDLED REJECTION: ${reason}`);
  logger.error('System', `Stack trace: ${reasonObj?.stack || 'No stack trace available'}`);
});

// ==================== CONNECTION LIMITS ====================

const CONNECTION_LIMITS: ConnectionLimits = {
  MAX_CONNECTIONS: 1000,
  MAX_CONNECTIONS_PER_IP: 10,
  MAX_MESSAGE_RATE: 30,
  CONNECTION_TIMEOUT: 300000,
  HEARTBEAT_INTERVAL: 30000,
  CLEANUP_INTERVAL: 60000,
  MAX_MESSAGE_SIZE: 10240,
  AUTH_TIMEOUT: 30000,
};

// ==================== CONNECTION STATE CLASS ====================

class ConnectionState {
  id: string;
  socketRef: WeakRef<WebSocket>;
  user: AuthResult | null = null;
  isAuthenticated = false;
  lastPingTime: number;
  modelInfo: ModelInfo | null = null;
  currentResponseId: string | null = null;
  connectedAt: Date;
  isDestroyed = false;
  processingMessage = false;
  sendInProgress = false;
  connectionIP: string;
  messageCount = 0;
  lastActivity: number;
  authAttempts = 0;
  maxAuthAttempts = 3;
  abortController: AbortController;
  heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  authTimeout: ReturnType<typeof setTimeout> | null = null;
  eventListeners: Set<EventListenerEntry> = new Set();

  constructor(clientId: string, socket: WebSocket, clientIP: string) {
    this.id = clientId;
    this.socketRef = new WeakRef(socket);
    this.lastPingTime = Date.now();
    this.connectedAt = new Date();
    this.connectionIP = clientIP;
    this.lastActivity = Date.now();
    this.abortController = new AbortController();
  }

  getSocket(): WebSocket | null {
    const socket = this.socketRef.deref();
    if (!socket) {
      logger.warn('WebSocket', `Socket has been garbage collected for ${this.id}`);
      return null;
    }
    return socket;
  }

  destroy(): void {
    if (this.isDestroyed) return;

    this.isDestroyed = true;
    this.abortController.abort();

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.authTimeout) {
      clearTimeout(this.authTimeout);
      this.authTimeout = null;
    }

    const socket = this.getSocket();
    if (socket) {
      this.eventListeners.forEach(({ event, handler }) => {
        try {
          socket.removeListener(event, handler);
        } catch (error) {
          const err = error as Error;
          logger.warn('WebSocket', `Error removing listener: ${err.message}`);
        }
      });
    }
    this.eventListeners.clear();

    this.user = null;
    this.modelInfo = null;

    logger.log('WebSocket', `Connection state destroyed for ${this.id}`);
  }

  addEventListenerTracked(event: string, handler: (...args: unknown[]) => void): boolean {
    const socket = this.getSocket();
    if (!socket) return false;

    socket.on(event, handler);
    this.eventListeners.add({ event, handler });
    return true;
  }
}

// ==================== SERVER CREATION ====================

const createServer = async (): Promise<FastifyInstance<any, any, any, any, any>> => {
  const certPath = join(process.cwd(), 'self_signed.crt');
  const keyPath = join(process.cwd(), 'self_signed.key');

  const serverOptions: ServerOptions = {
    trustProxy: true,
    methodNotAllowed: true,
    logger: false,
    requestTimeout: 30000,
    bodyLimit: 10485760,
    routerOptions: {
      maxParamLength: 2000,
    },
  };

  if ((await fs.pathExists(certPath)) && (await fs.pathExists(keyPath))) {
    serverOptions.https = {
      allowHTTP1: true,
      key: await fs.readFile(keyPath),
      cert: await fs.readFile(certPath),
    };
    serverOptions.http2 = true;
    serverOptions.http = {
      maxHeaderSize: 81920,
      keepAliveTimeout: 120000,
      headersTimeout: 65000,
    };
    logger.log('Server', 'HTTPS server configured with self-signed certificates');
  } else {
    logger.warn('Server', 'SSL certificates not found, running HTTP server for development');
  }

  const fastify = Fastify(serverOptions as Parameters<typeof Fastify>[0]);

  // Register cookie plugin
  const fastifyCookie = await import('@fastify/cookie');
  await fastify.register(fastifyCookie.default, {
    secret: (await retrieveConfigValue('server.cookieSecret')) as string || crypto.randomBytes(32).toString('hex'),
    parseOptions: {},
  });

  // Register multipart plugin
  await fastify.register(import('@fastify/multipart'), {
    limits: {
      fieldNameSize: 100,
      fieldSize: 1000000,
      fields: 20,
      fileSize: 5000000,
      files: 5,
      headerPairs: 2000,
    },
    attachFieldsToBody: true,
  });

  // Error handler - use generic handler to avoid HTTP2 type conflicts
  fastify.setErrorHandler((error, request, reply) => {
    const err = error as Error & { code?: string };
    if (err.code === 'FST_ERR_ROUTE_METHOD_NOT_SUPPORTED') {
      reply.code(405).send({
        error: 'Method Not Allowed',
        message: `HTTP method "${request.method}" is not supported for this route.`,
      });
    } else {
      reply.send(error);
    }
  });

  // Setup templating
  await setupTemplating(fastify);

  // Register WebSocket plugin
  await fastify.register(import('@fastify/websocket'), {
    errorHandler: function (error: Error) {
      logger.error('WebSocket', `WebSocket error: ${error.message}`);
    },
    preClose: function (done: () => void) {
      logger.log('WebSocket', 'WebSocket server closing...');
      done();
    },
  });

  // Connection tracking
  const activeConnections = new Map<string, ConnectionState>();
  const connectionsByIP = new Map<string, Set<string>>();
  const cleanupQueue = new Set<string>();
  const messageRateLimits = new Map<string, RateLimitData>();

  // Cleanup interval
  const cleanupInterval = setInterval(() => {
    cleanupStaleConnections();
    cleanupStaleRateLimits();
  }, CONNECTION_LIMITS.CLEANUP_INTERVAL);

  function cleanupStaleConnections(): void {
    const now = Date.now();
    let cleanedUp = 0;

    for (const [clientId, state] of activeConnections) {
      const timeSinceActivity = now - state.lastActivity;
      const timeSinceConnection = now - state.connectedAt.getTime();

      const socket = state.getSocket();
      if (
        state.isDestroyed ||
        timeSinceActivity > CONNECTION_LIMITS.CONNECTION_TIMEOUT ||
        timeSinceConnection > CONNECTION_LIMITS.CONNECTION_TIMEOUT * 2 ||
        (socket && socket.readyState >= 2)
      ) {
        logger.log('WebSocket', `Cleaning up stale connection ${clientId} (inactive: ${timeSinceActivity}ms)`);
        forceCleanupConnection(clientId, 'stale_cleanup');
        cleanedUp++;
      }
    }

    if (cleanedUp > 0) {
      logger.log('WebSocket', `Cleaned up ${cleanedUp} stale connections`);
    }
  }

  function cleanupStaleRateLimits(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, data] of messageRateLimits) {
      if (now - data.lastReset > 120000) {
        messageRateLimits.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.log('WebSocket', `Cleaned up ${cleaned} stale rate limit entries`);
    }
  }

  function checkMessageRateLimit(clientId: string): boolean {
    const now = Date.now();

    if (!messageRateLimits.has(clientId)) {
      messageRateLimits.set(clientId, {
        count: 1,
        lastReset: now,
        blocked: false,
      });
      return true;
    }

    const rateData = messageRateLimits.get(clientId)!;
    const timeSinceReset = now - rateData.lastReset;

    if (timeSinceReset > 60000) {
      rateData.count = 1;
      rateData.lastReset = now;
      rateData.blocked = false;
      return true;
    }

    rateData.count++;

    if (rateData.count > CONNECTION_LIMITS.MAX_MESSAGE_RATE) {
      if (!rateData.blocked) {
        logger.warn('WebSocket', `Rate limit exceeded for ${clientId}`);
        rateData.blocked = true;
      }
      return false;
    }

    return true;
  }

  function validateNewConnection(clientIP: string): ConnectionValidation {
    if (activeConnections.size >= CONNECTION_LIMITS.MAX_CONNECTIONS) {
      logger.warn('WebSocket', `Global connection limit reached (${CONNECTION_LIMITS.MAX_CONNECTIONS})`);
      return { valid: false, reason: 'Global connection limit reached' };
    }

    const ipConnections = connectionsByIP.get(clientIP) || new Set();
    if (ipConnections.size >= CONNECTION_LIMITS.MAX_CONNECTIONS_PER_IP) {
      logger.warn('WebSocket', `IP connection limit reached for ${clientIP} (${CONNECTION_LIMITS.MAX_CONNECTIONS_PER_IP})`);
      return { valid: false, reason: 'IP connection limit reached' };
    }

    return { valid: true };
  }

  function forceCleanupConnection(clientId: string, reason = 'unknown'): void {
    if (cleanupQueue.has(clientId)) {
      return;
    }

    cleanupQueue.add(clientId);

    try {
      const state = activeConnections.get(clientId);
      if (state) {
        const ipConnections = connectionsByIP.get(state.connectionIP);
        if (ipConnections) {
          ipConnections.delete(clientId);
          if (ipConnections.size === 0) {
            connectionsByIP.delete(state.connectionIP);
          }
        }

        state.destroy();

        logger.log(
          'WebSocket',
          `Connection ${clientId} cleanup completed - reason: ${reason}, remaining: ${activeConnections.size - 1}`
        );
      }

      activeConnections.delete(clientId);
      messageRateLimits.delete(clientId);
    } catch (error) {
      const err = error as Error;
      logger.error('WebSocket', `Error during cleanup for ${clientId}: ${err.message}`);
    } finally {
      cleanupQueue.delete(clientId);
    }
  }

  async function sendMessageToConnection(
    connectionState: ConnectionState,
    message: Partial<OutgoingWebSocketMessage>,
    timeout = 5000
  ): Promise<SendMessageResult> {
    if (connectionState.isDestroyed || cleanupQueue.has(connectionState.id)) {
      return { success: false, reason: 'connection_destroyed' };
    }

    if (connectionState.sendInProgress) {
      return { success: false, reason: 'send_in_progress' };
    }

    connectionState.sendInProgress = true;

    try {
      const socket = connectionState.getSocket();
      if (!socket || socket.readyState !== 1) {
        return { success: false, reason: 'socket_not_ready' };
      }

      const messageToSend = JSON.stringify({
        timestamp: new Date().toISOString(),
        client_id: connectionState.id,
        server_time: new Date().toISOString(),
        ...message,
      });

      if (messageToSend.length > CONNECTION_LIMITS.MAX_MESSAGE_SIZE) {
        logger.warn('WebSocket', `Message too large for ${connectionState.id}: ${messageToSend.length} bytes`);
        return { success: false, reason: 'message_too_large' };
      }

      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), timeout);

      try {
        if (connectionState.abortController.signal.aborted) {
          return { success: false, reason: 'operation_aborted' };
        }

        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timeoutId);
            timeoutController.signal.removeEventListener('abort', onAbort);
          };

          const onAbort = () => {
            cleanup();
            reject(new Error('Send operation timed out'));
          };

          timeoutController.signal.addEventListener('abort', onAbort);

          try {
            socket.send(messageToSend);
            cleanup();
            resolve();
          } catch (error) {
            cleanup();
            reject(error);
          }
        });

        connectionState.lastActivity = Date.now();
        connectionState.messageCount++;

        return { success: true };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      const err = error as Error;
      logger.error('WebSocket', `Send failed for ${connectionState.id}: ${err.message}`);
      return { success: false, reason: 'send_error', error: err.message };
    } finally {
      connectionState.sendInProgress = false;
    }
  }

  // WebSocket route registration
  fastify.register(async function (fastify) {
    fastify.get(
      '/ws-client',
      {
        websocket: true,
        preHandler: async (_request: FastifyRequest, reply: FastifyReply) => {
          reply.header('Access-Control-Allow-Origin', '*');
          reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        },
      },
      async (socket: WebSocket, request: FastifyRequest) => {
        const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
        const clientIP = request.ip || (request.socket as { remoteAddress?: string }).remoteAddress || 'unknown';

        const validation = validateNewConnection(clientIP);
        if (!validation.valid) {
          logger.warn('WebSocket', `Connection rejected for ${clientIP}: ${validation.reason}`);
          try {
            socket.close(1013, validation.reason);
          } catch (error) {
            const err = error as Error;
            logger.error('WebSocket', `Error closing rejected connection: ${err.message}`);
          }
          return;
        }

        logger.log('WebSocket', `New client connecting: ${clientId} from ${clientIP}`);

        const connectionState = new ConnectionState(clientId, socket, clientIP);

        if (!connectionsByIP.has(clientIP)) {
          connectionsByIP.set(clientIP, new Set());
        }
        connectionsByIP.get(clientIP)!.add(clientId);

        activeConnections.set(clientId, connectionState);

        connectionState.authTimeout = setTimeout(() => {
          if (!connectionState.isAuthenticated && !connectionState.isDestroyed) {
            logger.warn('WebSocket', `Authentication timeout for ${clientId}`);
            forceCleanupConnection(clientId, 'auth_timeout');
          }
        }, CONNECTION_LIMITS.AUTH_TIMEOUT);

        const messageHandler = async (data: Buffer | string): Promise<void> => {
          try {
            if (connectionState.isDestroyed || cleanupQueue.has(clientId)) {
              return;
            }

            if (!checkMessageRateLimit(clientId)) {
              await sendMessageToConnection(connectionState, {
                type: 'error',
                message: 'Rate limit exceeded',
              });
              return;
            }

            connectionState.lastActivity = Date.now();

            let message: WebSocketMessage;
            try {
              const messageStr = data.toString();
              if (messageStr.length > CONNECTION_LIMITS.MAX_MESSAGE_SIZE) {
                throw new Error('Message too large');
              }
              message = JSON.parse(messageStr);
            } catch (parseError) {
              const err = parseError as Error;
              logger.error('WebSocket', `Parse error for ${clientId}: ${err.message}`);
              await sendMessageToConnection(connectionState, {
                type: 'error',
                message: 'Invalid message format',
              });
              return;
            }

            const processingTimeout = setTimeout(() => {
              logger.warn('WebSocket', `Message processing timeout for ${clientId}`);
              connectionState.abortController.abort();
            }, 30000);

            try {
              await processMessage(connectionState, message);
            } finally {
              clearTimeout(processingTimeout);
            }
          } catch (error) {
            const err = error as Error;
            logger.error('WebSocket', `Message handler error for ${clientId}: ${err.message}`);
          }
        };

        const closeHandler = (code: number, reason: Buffer): void => {
          logger.log('WebSocket', `Client ${clientId} disconnected: ${code} - ${reason.toString() || 'no reason'}`);
          forceCleanupConnection(clientId, `close_${code}`);
        };

        const errorHandler = (error: Error & { code?: string }): void => {
          logger.error('WebSocket', `Socket error for ${clientId}: ${error.message}`);
          forceCleanupConnection(clientId, `error_${error.code || 'unknown'}`);
        };

        connectionState.addEventListenerTracked('message', messageHandler as (...args: unknown[]) => void);
        connectionState.addEventListenerTracked('close', closeHandler as (...args: unknown[]) => void);
        connectionState.addEventListenerTracked('error', errorHandler as (...args: unknown[]) => void);

        connectionState.heartbeatInterval = setInterval(async () => {
          try {
            if (connectionState.isDestroyed || cleanupQueue.has(clientId)) {
              if (connectionState.heartbeatInterval) {
                clearInterval(connectionState.heartbeatInterval);
              }
              return;
            }

            const sock = connectionState.getSocket();
            if (!sock || sock.readyState !== 1) {
              logger.log('WebSocket', `Socket not available for heartbeat ${clientId}`);
              forceCleanupConnection(clientId, 'heartbeat_socket_unavailable');
              return;
            }

            const result = await sendMessageToConnection(connectionState, { type: 'ping' });
            if (!result.success) {
              logger.warn('WebSocket', `Heartbeat failed for ${clientId}: ${result.reason}`);
              if (result.reason !== 'send_in_progress') {
                forceCleanupConnection(clientId, 'heartbeat_failed');
              }
            }

            const now = Date.now();
            const timeSinceLastPing = now - connectionState.lastPingTime;
            const timeSinceLastActivity = now - connectionState.lastActivity;

            if (timeSinceLastPing > 90000 || timeSinceLastActivity > 120000) {
              logger.warn('WebSocket', `Connection ${clientId} is stale, closing`);
              forceCleanupConnection(clientId, 'stale_connection');
            }
          } catch (error) {
            const err = error as Error;
            logger.error('WebSocket', `Heartbeat error for ${clientId}: ${err.message}`);
            forceCleanupConnection(clientId, 'heartbeat_error');
          }
        }, CONNECTION_LIMITS.HEARTBEAT_INTERVAL);

        setTimeout(async () => {
          if (connectionState.isDestroyed) return;

          const establishResult = await sendMessageToConnection(connectionState, {
            type: 'connection-established',
            client_id: clientId,
            server_time: new Date().toISOString(),
            server_info: {
              version: '1.0.0',
              capabilities: ['text-input', 'model-info', 'audio', 'interrupt'],
            },
          });

          if (establishResult.success) {
            setTimeout(async () => {
              if (!connectionState.isDestroyed) {
                await sendMessageToConnection(connectionState, {
                  type: 'auth-required',
                  message: 'Please provide authentication token',
                });
              }
            }, 200);
          }
        }, 300);

        logger.log('WebSocket', `Client ${clientId} setup completed successfully`);
      }
    );
  });

  async function processMessage(connectionState: ConnectionState, message: WebSocketMessage): Promise<void> {
    if (connectionState.abortController.signal.aborted) {
      return;
    }

    logger.log('WebSocket', `Processing ${message.type} from ${connectionState.id}`);

    if (!connectionState.isAuthenticated && message.type !== 'ping' && message.type !== 'pong') {
      const user = await authenticateMessage(connectionState, message);

      if (!user) {
        await sendMessageToConnection(connectionState, {
          type: 'auth-failed',
          message: 'Invalid or missing authentication token',
        });
        return;
      }

      connectionState.user = user;
      connectionState.isAuthenticated = true;

      if (connectionState.authTimeout) {
        clearTimeout(connectionState.authTimeout);
        connectionState.authTimeout = null;
      }

      await sendMessageToConnection(connectionState, {
        type: 'auth-success',
        message: 'Authentication successful',
        user_id: user.user_id,
      });

      logger.log('WebSocket', `Client ${connectionState.id} authenticated as user: ${user.user_id}`);
    }

    switch (message.type) {
      case 'ping':
        await sendMessageToConnection(connectionState, { type: 'pong' });
        break;

      case 'pong':
        connectionState.lastPingTime = Date.now();
        break;

      case 'model-info':
        if (connectionState.isAuthenticated && message.model_info) {
          connectionState.modelInfo = message.model_info;
          logger.log('WebSocket', `Model info received for ${connectionState.id}`);
          await sendMessageToConnection(connectionState, {
            type: 'model-info-received',
            message: 'Model information updated successfully',
          });
        }
        break;

      case 'text-input':
        if (connectionState.isAuthenticated) {
          await handleTextInput(connectionState, message);
        } else {
          await sendMessageToConnection(connectionState, {
            type: 'error',
            message: 'Authentication required for text input',
          });
        }
        break;

      case 'interrupt':
        if (connectionState.isAuthenticated) {
          handleInterrupt(connectionState);
        }
        break;

      case 'connection-test':
        await sendMessageToConnection(connectionState, {
          type: 'connection-test-response',
          message: 'Connection is working properly',
          client_id: connectionState.id,
          connection_stats: {
            messages_processed: connectionState.messageCount,
            connected_duration: Date.now() - connectionState.connectedAt.getTime(),
            last_activity: connectionState.lastActivity,
          },
        });
        break;

      default:
        logger.warn('WebSocket', `Unknown message type: ${message.type} from ${connectionState.id}`);
        await sendMessageToConnection(connectionState, {
          type: 'error',
          message: `Unknown message type: ${message.type}`,
        });
    }
  }

  async function authenticateMessage(connectionState: ConnectionState, message: WebSocketMessage): Promise<AuthResult | null> {
    connectionState.authAttempts++;
    if (connectionState.authAttempts > connectionState.maxAuthAttempts) {
      logger.warn('WebSocket', `Too many auth attempts for ${connectionState.id}`);
      forceCleanupConnection(connectionState.id, 'too_many_auth_attempts');
      return null;
    }

    if (!message.auth_token) {
      logger.warn('WebSocket', `No auth_token for ${connectionState.id}`);
      return null;
    }

    try {
      const authPromise = checkForAuth(message.auth_token) as Promise<AuthResult | null>;

      const authResult = await Promise.race([
        authPromise,
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Auth timeout')), 10000)),
      ]);

      if (authResult && (authResult as AuthResult).valid) {
        logger.log('WebSocket', `Authentication successful for ${connectionState.id}`);
        connectionState.authAttempts = 0;
        return authResult as AuthResult;
      } else {
        logger.warn('WebSocket', `Authentication failed for ${connectionState.id}`);
        return null;
      }
    } catch (error) {
      const err = error as Error;
      logger.error('WebSocket', `Authentication error for ${connectionState.id}: ${err.message}`);
      return null;
    }
  }

  async function handleTextInput(connectionState: ConnectionState, message: WebSocketMessage): Promise<void> {
    if (connectionState.abortController.signal.aborted) {
      return;
    }

    const { user } = connectionState;

    if (!message.text || !(message.text as string).trim()) {
      await sendMessageToConnection(connectionState, {
        type: 'error',
        message: 'Empty text input received',
      });
      return;
    }

    const responseId = `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    connectionState.currentResponseId = responseId;

    try {
      await sendMessageToConnection(connectionState, {
        type: 'response-queued',
        response_id: responseId,
      });

      let processedText = await applyAlternateSpelling(message.text as string, user!.user_id!);

      logger.log('WebSocket', `Processing text input for user ${user!.user_id}`);

      const chatPromise = aiHelper.respondToChat(
        {
          message: processedText,
          user: user!.user_name || 'User',
        },
        user!.user_id!
      );

      const chatResponse = await Promise.race([
        chatPromise,
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('AI response timeout')), 60000)),
      ]);

      if (!chatResponse || !chatResponse.success || !chatResponse.text) {
        throw new Error((chatResponse as { error?: string })?.error || 'Failed to generate response');
      }

      await sendMessageToConnection(connectionState, {
        type: 'full-text',
        text: chatResponse.text,
        response_id: responseId,
      });

      logger.log('WebSocket', `Text response sent for user ${user!.user_id}`);

      if (user!.tts_enabled) {
        await generateAndSendAudio(connectionState, chatResponse.text, responseId);
      } else {
        await sendMessageToConnection(connectionState, {
          type: 'synthesis-complete',
          response_id: responseId,
        });
      }
    } catch (error) {
      const err = error as Error;
      logger.error('WebSocket', `Error processing text input for ${connectionState.id}: ${err.message}`);
      await sendMessageToConnection(connectionState, {
        type: 'error',
        message: 'Failed to generate response: ' + err.message,
        response_id: responseId,
      });
      connectionState.currentResponseId = null;
    }
  }

  async function applyAlternateSpelling(text: string, userId: string): Promise<string> {
    try {
      const userObj = (await returnAuthObject(userId)) as AuthResult | null;

      if (!userObj || !userObj.alternateSpell || !Array.isArray(userObj.alternateSpell)) {
        return text;
      }

      let processedText = text;
      const alternateSpellings = userObj.alternateSpell as AlternateSpelling[];

      for (const alternateEntry of alternateSpellings) {
        if (typeof alternateEntry === 'string') {
          const regex = new RegExp(`\\b${escapeRegExp(alternateEntry)}\\b`, 'gi');
          processedText = processedText.replace(regex, userObj.bot_name || '');
        } else if (typeof alternateEntry === 'object' && alternateEntry.from && alternateEntry.to) {
          const regex = new RegExp(`\\b${escapeRegExp(alternateEntry.from)}\\b`, 'gi');
          processedText = processedText.replace(regex, alternateEntry.to);
        }
      }

      return processedText;
    } catch (error) {
      const err = error as Error;
      logger.error('WebSocket', `Error applying alternate spelling: ${err.message}`);
      return text;
    }
  }

  function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  async function generateAndSendAudio(connectionState: ConnectionState, text: string, responseId: string): Promise<void> {
    if (connectionState.abortController.signal.aborted) {
      return;
    }

    const { user, modelInfo } = connectionState;

    try {
      await sendMessageToConnection(connectionState, {
        type: 'synthesis-started',
        response_id: responseId,
      });

      logger.log('WebSocket', `Generating TTS audio for user ${user!.user_id}`);

      const audioPromise = responseGenerator.respondWithVoice(text, user!.user_id!);
      const audioResult = await Promise.race([
        audioPromise,
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Audio generation timeout')), 30000)),
      ]);

      if ((audioResult as { error?: string })?.error) {
        throw new Error((audioResult as { error: string }).error);
      }

      await sendMessageToConnection(connectionState, {
        type: 'synthesis-complete',
        response_id: responseId,
      });

      const displayText = {
        text: text,
        name: user!.bot_name || 'Assistant',
        avatar: user!.avatar_url || '',
      };

      const actions: { expressions?: (string | number)[] } = {};
      if (modelInfo && modelInfo.expressions && Array.isArray(modelInfo.expressions)) {
        actions.expressions = selectExpressions(text, modelInfo.expressions);
      }

      await sendMessageToConnection(connectionState, {
        type: 'audio-url',
        audio_url: audioResult as string,
        display_text: displayText,
        actions: Object.keys(actions).length > 0 ? actions : undefined,
        response_id: responseId,
        audio_format: 'wav',
        sample_rate: 22050,
        bit_depth: 16,
      });

      logger.log('WebSocket', `Audio URL sent for user ${user!.user_id}`);
    } catch (error) {
      const err = error as Error;
      logger.error('WebSocket', `Error generating audio for ${user!.user_id}: ${err.message}`);
      await sendMessageToConnection(connectionState, {
        type: 'error',
        message: 'Failed to generate audio response',
        response_id: responseId,
        error_details: err.message,
      });
    }
  }

  function handleInterrupt(connectionState: ConnectionState): void {
    const { user } = connectionState;
    logger.log('WebSocket', `Interrupt received from user ${user?.user_id || 'unknown'}`);
    connectionState.currentResponseId = null;
    connectionState.abortController.abort();
    sendMessageToConnection(connectionState, {
      type: 'interrupt',
      message: 'Response interrupted',
    });
  }

  function selectExpressions(text: string, availableExpressions: string[]): (string | number)[] {
    const emotionKeywords: EmotionKeywords = {
      happy: ['happy', 'joy', 'excited', 'great', 'awesome', 'wonderful', 'amazing', '!', '😊', '😄'],
      sad: ['sad', 'sorry', 'disappointed', 'unfortunate', 'regret', '😢', '😞'],
      surprised: ['wow', 'amazing', 'incredible', 'unbelievable', 'surprise', '!', '😮', '😲'],
      angry: ['angry', 'frustrated', 'annoyed', 'mad', 'irritated', '😠', '😡'],
      neutral: ['hello', 'hi', 'okay', 'alright', 'yes', 'no', 'maybe'],
    };

    const textLower = text.toLowerCase();
    let detectedEmotion: EmotionType = 'neutral';
    let maxMatches = 0;

    for (const [emotion, keywords] of Object.entries(emotionKeywords) as [EmotionType, string[]][]) {
      const matches = keywords.filter((keyword) => textLower.includes(keyword)).length;
      if (matches > maxMatches) {
        maxMatches = matches;
        detectedEmotion = emotion;
      }
    }

    const expressionMapping: ExpressionMapping = {
      happy: ['smile', 'happy', 'joy', 'cheerful', 0, 1],
      sad: ['sad', 'disappointed', 'down', 2, 3],
      surprised: ['surprised', 'shock', 'amazed', 4, 5],
      angry: ['angry', 'mad', 'annoyed', 6, 7],
      neutral: ['neutral', 'default', 'calm', 8, 9],
    };

    const possibleExpressions = expressionMapping[detectedEmotion] || expressionMapping.neutral;
    const selectedExpressions: (string | number)[] = [];

    for (const expr of possibleExpressions) {
      if (typeof expr === 'string' && availableExpressions.includes(expr)) {
        selectedExpressions.push(expr);
        break;
      }
    }

    if (selectedExpressions.length === 0 && availableExpressions.length > 0) {
      selectedExpressions.push(availableExpressions[0]!);
    }

    return selectedExpressions;
  }

  // WebSocket status endpoint
  fastify.get('/ws-status', async (): Promise<WebSocketStatusResponse> => {
    const connections: ConnectionInfo[] = Array.from(activeConnections.values()).map((conn) => ({
      id: conn.id,
      authenticated: conn.isAuthenticated,
      user_id: conn.user?.user_id || null,
      connected_at: conn.connectedAt,
      socket_state: conn.getSocket()?.readyState ?? 'destroyed',
      is_destroyed: conn.isDestroyed,
      processing_message: conn.processingMessage,
      send_in_progress: conn.sendInProgress,
      message_count: conn.messageCount,
      last_activity: conn.lastActivity,
      connection_ip: conn.connectionIP,
      auth_attempts: conn.authAttempts,
    }));

    const memoryUsage = process.memoryUsage();

    return {
      websocket_enabled: true,
      active_connections: activeConnections.size,
      cleanup_queue_size: cleanupQueue.size,
      rate_limit_entries: messageRateLimits.size,
      ip_tracking_entries: connectionsByIP.size,
      connections: connections,
      memory_info: {
        heap_used: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
        heap_total: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
        external: `${Math.round(memoryUsage.external / 1024 / 1024)}MB`,
        rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`,
      },
      system_info: {
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      },
    };
  });

  // Graceful shutdown
  const gracefulShutdown = (): void => {
    logger.log('WebSocket', 'Starting graceful shutdown...');

    clearInterval(cleanupInterval);

    for (const [clientId] of activeConnections) {
      forceCleanupConnection(clientId, 'server_shutdown');
    }

    activeConnections.clear();
    connectionsByIP.clear();
    messageRateLimits.clear();
    cleanupQueue.clear();

    logger.log('WebSocket', 'Graceful shutdown completed');
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  logger.log('WebSocket', 'Memory-optimized WebSocket route registered at /ws-client');

  // Register routes
  await fastify.register(routes, { prefix: '/api/v1' });
  await fastify.register(audioRoutes, {
    outputDir: 'final',
    prefix: '/files/audio',
    addContentDisposition: true,
  });
  await fastify.register(twitchEventSubRoutes, { prefix: '/api/v1/twitch' });
  await fastify.register(webRoutes, { prefix: '/web' });

  return fastify;
};

// ==================== PREFLIGHT CHECKS ====================

export async function preflightChecks(): Promise<PreflightResult> {
  try {
    const axios = (await import('axios')).default;
    let ttsRes = { status: 0 };
    const ttsPreference = await retrieveConfigValue('ttsPreference');

    try {
      switch (ttsPreference) {
        case 'fish':
          ttsRes = await axios.get((await retrieveConfigValue('fishTTS.healthcheck.internal')) as string);
          break;
        case 'alltalk':
          ttsRes = await axios.get((await retrieveConfigValue('alltalk.healthcheck.internal')) as string);
          break;
        default:
          ttsRes = { status: 200 };
          break;
      }
    } catch (ttsError) {
      const err = ttsError as Error;
      logger.log('API', `TTS healthcheck error: ${err.message}`);
    }

    logger.log('API', `Current TTS engine: ${ttsPreference}, ${ttsRes.status == 200 ? 'is alive.' : 'is not alive.'}`);
    const databaseRes = await vectorDb.checkMilvusHealth();

    return {
      llmStatuses: {
        allTalkIsOnline: ttsRes.status == 200,
        embeddingIsOnline: (await responseGenerator.checkEndpoint(
          (await retrieveConfigValue('models.embedding.endpoint')) as string || '',
          (await retrieveConfigValue('models.embedding.apiKey')) as string || '',
          (await retrieveConfigValue('models.embedding.model')) as string || ''
        )) ?? false,
        llmIsOnline: (await responseGenerator.checkEndpoint(
          (await retrieveConfigValue('models.chat.endpoint')) as string || '',
          (await retrieveConfigValue('models.chat.apiKey')) as string || '',
          (await retrieveConfigValue('models.chat.model')) as string || ''
        )) ?? false,
        summaryIsOnline: (await responseGenerator.checkEndpoint(
          (await retrieveConfigValue('models.summary.endpoint')) as string || '',
          (await retrieveConfigValue('models.summary.apiKey')) as string || '',
          (await retrieveConfigValue('models.summary.model')) as string || ''
        )) ?? false,
        queryIsOnline: (await responseGenerator.checkEndpoint(
          (await retrieveConfigValue('models.query.endpoint')) as string || '',
          (await retrieveConfigValue('models.query.apiKey')) as string || '',
          (await retrieveConfigValue('models.query.model')) as string || ''
        )) ?? false,
        conversionIsOnline: (await responseGenerator.checkEndpoint(
          (await retrieveConfigValue('models.conversion.endpoint')) as string || '',
          (await retrieveConfigValue('models.conversion.apiKey')) as string || '',
          (await retrieveConfigValue('models.conversion.model')) as string || ''
        )) ?? false,
      },
      restIsOnline: true,
      dbIsOnline: databaseRes,
      websocketEnabled: true,
    };
  } catch (error) {
    const err = error as Error;
    logger.error('System', `Error during preflight checks: ${err.message}`);
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
      websocketEnabled: false,
    };
  }
}

// ==================== LAUNCH REST ====================

export async function launchRest(fastify: FastifyInstance<any, any, any, any, any>): Promise<void> {
  const portNum = (await retrieveConfigValue('server.port')) as number || 3000;
  const internalHost = (await retrieveConfigValue('server.endpoints.internal')) as string || '0.0.0.0';

  try {
    await fastify.listen({ port: portNum, host: internalHost });

    const isHttps = (fastify as FastifyInstance & { initialConfig?: { https?: boolean } }).initialConfig?.https ? true : false;
    const protocol = isHttps ? 'https' : 'http';
    const wsProtocol = isHttps ? 'wss' : 'ws';

    logger.log('API', `Fastify server launched successfully on ${protocol}://${internalHost}:${portNum}`);
    logger.log('WebSocket', `WebSocket endpoint available at ${wsProtocol}://${internalHost}:${portNum}/ws-client`);
    logger.log('WebSocket', `WebSocket status endpoint available at ${protocol}://${internalHost}:${portNum}/ws-status`);
  } catch (err) {
    const error = err as Error;
    logger.error('API', `Failed to launch API server with error: ${error}`);
    await fs.writeFile('./error.txt', JSON.stringify(err));
    throw err;
  }
}

// ==================== INITIALIZE APP ====================

export async function initializeApp(): Promise<InitializeResult> {
  try {
    const allUsers = (await returnAPIKeys()) as unknown as Array<{ user_id: string }>;

    const collectionNames = [
      (await retrieveConfigValue('milvus.collections.user')) as string || 'user',
      (await retrieveConfigValue('milvus.collections.intelligence')) as string || 'intelligence',
      (await retrieveConfigValue('milvus.collections.chat')) as string || 'chat',
      (await retrieveConfigValue('milvus.collections.voice')) as string || 'voice',
    ];

    await loadConfig();
    for await (const user of allUsers) {
      for await (const collectionName of collectionNames) {
        try {
          const collectionExists = await vectorDb.checkAndCreateCollection(collectionName, user.user_id as string);
          if (!collectionExists) {
            logger.error('Milvus', `Failed to create collection ${collectionName} for user ${user.user_id}`);
            continue;
          }

          const isLoaded = await vectorDb.loadCollectionIfNeeded(collectionName, user.user_id as string);
          if (!isLoaded) {
            logger.error('Milvus', `Failed to load collection ${collectionName} for user ${user.user_id}`);
            continue;
          }
        } catch (error) {
          const err = error as Error;
          logger.error('Milvus', `Error with collection ${collectionName} for user ${user.user_id}: ${err.message}`);
          continue;
        }
      }
    }

    // Note: Vector indexing will be handled by the embeddings module
    // Note: tiktoken doesn't require preloading

    const server = await createServer();
    await launchRest(server);

    const status = await preflightChecks();
    await initAllAPIs();

    try {
      logger.log('System', 'Importing Twitch EventSub manager...');
      const { registerAllUsersEventSub, setupTwitchCronJobs } = await import('./integrations/twitch/eventsub.js');

      logger.log('System', 'Registering Twitch EventSub subscriptions...');
      const eventSubResults = await registerAllUsersEventSub();
      logger.log('System', `EventSub registration complete: ${eventSubResults.success} successful, ${eventSubResults.failures} failed`);

      logger.log('System', 'Setting up Twitch cron jobs...');
      setupTwitchCronJobs();
    } catch (eventSubError) {
      const err = eventSubError as Error;
      logger.error('System', `Error with Twitch integration: ${err.message}`);
    }

    logger.log('System', 'Enspira is fully initialized and ready!');
    logger.log('WebSocket', 'Memory-optimized VTuber WebSocket integration is active and ready for connections!');

    return { server, status };
  } catch (error) {
    const err = error as Error;
    logger.error('System', `Failed to initialize the application: ${err.message}`);
    throw error;
  }
}

// ==================== ENTRY POINT ====================

// Bun-compatible entry point check
const isMainModule = typeof Bun !== 'undefined'
  ? Bun.main === import.meta.path
  : import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  initializeApp().catch((err: Error) => {
    logger.error('System', `Fatal error in application: ${err.message}`);
    process.exit(1);
  });
}

export default initializeApp;

// Declare Bun global for TypeScript
declare const Bun: { main: string } | undefined;
