import Fastify from "fastify";
import fs from "fs-extra";
import { join } from "path";
import { audioRoutes } from "./routes/audio.js";
import twitchEventSubRoutes from "./routes/twitch.js";
import * as aiHelper from "./ai-logic.js";
import webRoutes from "./routes/web.js";
import { initAllAPIs, returnAPIKeys } from "./api-helper.js";
import { preloadAllTokenizers } from "./token-helper.js";
import { retrieveConfigValue, loadConfig } from "./config-helper.js";
import routes from "./routes/v1.js";
import "./create-global-logger.js"; // This ensures the logger is properly set up
import { logger } from "./create-global-logger.js";
import fastifyCookie from "@fastify/cookie";
import * as crypto from "crypto";
import { setupTemplating } from "./template-engine.js";

process.on("uncaughtException", (err) => {
  logger.error("System", `UNCAUGHT EXCEPTION: ${err.message}`);
  logger.error("System", `Stack trace: ${err.stack}`);
  // Keep process alive for debugging
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("System", `UNHANDLED REJECTION: ${reason}`);
  logger.error(
    "System",
    `Stack trace: ${reason?.stack || "No stack trace available"}`
  );
  // Keep process alive for debugging
});

// Create the fastify instance
const createServer = async () => {
  // Check if certificates exist, if not create HTTP server for development
  const certPath = join(process.cwd(), "self_signed.crt");
  const keyPath = join(process.cwd(), "self_signed.key");

  let serverOptions = {
    trustProxy: true,
    methodNotAllowed: true,
    logger: false,
    requestTimeout: 30000,
    bodyLimit: 10485760, // 10MB for request body size
    maxParamLength: 2000, // Increase param length limit
  };

  // Only use HTTPS if certificates exist
  if ((await fs.pathExists(certPath)) && (await fs.pathExists(keyPath))) {
    serverOptions.https = {
      allowHTTP1: true,
      key: await fs.readFile(keyPath),
      cert: await fs.readFile(certPath),
    };
    serverOptions.http2 = true;
    // Add HTTP/1 header size configuration
    serverOptions.http = {
      maxHeaderSize: 81920, // 80KB
      keepAliveTimeout: 120000, // 2 minutes
      headersTimeout: 65000, // 65 seconds
    };
    logger.log(
      "Server",
      "HTTPS server configured with self-signed certificates"
    );
  } else {
    logger.warn(
      "Server",
      "SSL certificates not found, running HTTP server for development"
    );
  }

  const fastify = Fastify(serverOptions);

  await fastify.register(fastifyCookie, {
    secret:
      (await retrieveConfigValue("server.cookieSecret")) ||
      crypto.randomBytes(32).toString("hex"),
    parseOptions: {},
  });

  await fastify.register(import("@fastify/multipart"), {
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

  fastify.setErrorHandler((error, request, reply) => {
    if (
      error instanceof Fastify.errorCodes.FST_ERR_ROUTE_METHOD_NOT_SUPPORTED
    ) {
      reply.code(405).send({
        error: "Method Not Allowed",
        message: `HTTP method "${request.method}" is not supported for this route.`,
        allowedMethods: reply.context.config.allowedMethods,
      });
    } else {
      reply.send(error);
    }
  });

  await setupTemplating(fastify);

  // Register WebSocket plugin globally with proper error handling
  await fastify.register(import("@fastify/websocket"), {
    errorHandler: function (error, conn, req, reply) {
      logger.error("WebSocket", `WebSocket error: ${error.message}`);
    },
    preClose: function (done) {
      logger.log("WebSocket", "WebSocket server closing...");
      done();
    },
  });

  // MEMORY OPTIMIZATION: Enhanced connection management with resource limits
  const CONNECTION_LIMITS = {
    MAX_CONNECTIONS: 1000,
    MAX_CONNECTIONS_PER_IP: 10,
    MAX_MESSAGE_RATE: 30, // messages per minute
    CONNECTION_TIMEOUT: 300000, // 5 minutes
    HEARTBEAT_INTERVAL: 30000, // 30 seconds
    CLEANUP_INTERVAL: 60000, // 1 minute
    MAX_MESSAGE_SIZE: 10240, // 10KB
    AUTH_TIMEOUT: 30000, // 30 seconds
  };

  const activeConnections = new Map();
  const connectionsByIP = new Map();
  const cleanupQueue = new Set();
  const messageRateLimits = new Map(); // Track message rates per connection

  // MEMORY OPTIMIZATION: Periodic cleanup of stale connections and rate limits
  const cleanupInterval = setInterval(() => {
    cleanupStaleConnections();
    cleanupStaleRateLimits();
  }, CONNECTION_LIMITS.CLEANUP_INTERVAL);

  // MEMORY OPTIMIZATION: Cleanup stale connections
  function cleanupStaleConnections() {
    const now = Date.now();
    let cleanedUp = 0;

    for (const [clientId, state] of activeConnections) {
      const timeSinceActivity = now - state.lastActivity;
      const timeSinceConnection = now - state.connectedAt.getTime();

      if (
        state.isDestroyed ||
        timeSinceActivity > CONNECTION_LIMITS.CONNECTION_TIMEOUT ||
        timeSinceConnection > CONNECTION_LIMITS.CONNECTION_TIMEOUT * 2 ||
        (state.socket && state.socket.readyState >= 2) // CLOSING or CLOSED
      ) {
        logger.log(
          "WebSocket",
          `Cleaning up stale connection ${clientId} (inactive: ${timeSinceActivity}ms)`
        );
        forceCleanupConnection(clientId, "stale_cleanup");
        cleanedUp++;
      }
    }

    if (cleanedUp > 0) {
      logger.log("WebSocket", `Cleaned up ${cleanedUp} stale connections`);
    }
  }

  // MEMORY OPTIMIZATION: Cleanup stale rate limit entries
  function cleanupStaleRateLimits() {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, data] of messageRateLimits) {
      if (now - data.lastReset > 120000) { // 2 minutes
        messageRateLimits.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.log("WebSocket", `Cleaned up ${cleaned} stale rate limit entries`);
    }
  }

  // MEMORY OPTIMIZATION: Rate limiting for message processing
  function checkMessageRateLimit(clientId) {
    const now = Date.now();
    const key = clientId;

    if (!messageRateLimits.has(key)) {
      messageRateLimits.set(key, {
        count: 1,
        lastReset: now,
        blocked: false
      });
      return true;
    }

    const rateData = messageRateLimits.get(key);
    const timeSinceReset = now - rateData.lastReset;

    // Reset every minute
    if (timeSinceReset > 60000) {
      rateData.count = 1;
      rateData.lastReset = now;
      rateData.blocked = false;
      return true;
    }

    rateData.count++;

    if (rateData.count > CONNECTION_LIMITS.MAX_MESSAGE_RATE) {
      if (!rateData.blocked) {
        logger.warn("WebSocket", `Rate limit exceeded for ${clientId}`);
        rateData.blocked = true;
      }
      return false;
    }

    return true;
  }

  // MEMORY OPTIMIZATION: Enhanced connection state class with proper cleanup
  class ConnectionState {
    constructor(clientId, socket, clientIP) {
      this.id = clientId;
      this.socket = socket;
      this.user = null;
      this.isAuthenticated = false;
      this.lastPingTime = Date.now();
      this.modelInfo = null;
      this.currentResponseId = null;
      this.connectedAt = new Date();
      this.isDestroyed = false;
      this.processingMessage = false;
      this.sendInProgress = false;
      this.connectionIP = clientIP;
      this.messageCount = 0;
      this.lastActivity = Date.now();
      this.authAttempts = 0;
      this.maxAuthAttempts = 3;
      
      // MEMORY OPTIMIZATION: AbortController for cancelling async operations
      this.abortController = new AbortController();
      this.heartbeatInterval = null;
      this.authTimeout = null;
      this.eventListeners = new Set(); // Track event listeners for cleanup
      
      // MEMORY OPTIMIZATION: Weak references to avoid circular dependencies
      this.socketRef = new WeakRef(socket);
    }

    // MEMORY OPTIMIZATION: Get socket with validation
    getSocket() {
      const socket = this.socketRef.deref();
      if (!socket) {
        logger.warn("WebSocket", `Socket has been garbage collected for ${this.id}`);
        return null;
      }
      return socket;
    }

    // MEMORY OPTIMIZATION: Complete cleanup of all resources
    destroy() {
      if (this.isDestroyed) return;
      
      this.isDestroyed = true;
      
      // Cancel all pending async operations
      this.abortController.abort();
      
      // Clear timeouts/intervals
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      
      if (this.authTimeout) {
        clearTimeout(this.authTimeout);
        this.authTimeout = null;
      }

      // Remove all event listeners
      const socket = this.getSocket();
      if (socket) {
        this.eventListeners.forEach(({ event, handler }) => {
          try {
            socket.removeListener(event, handler);
          } catch (error) {
            logger.warn("WebSocket", `Error removing listener: ${error.message}`);
          }
        });
      }
      this.eventListeners.clear();

      // Clear object references
      this.socket = null;
      this.user = null;
      this.modelInfo = null;
      
      logger.log("WebSocket", `Connection state destroyed for ${this.id}`);
    }

    // MEMORY OPTIMIZATION: Add event listener with tracking
    addEventListenerTracked(event, handler) {
      const socket = this.getSocket();
      if (!socket) return false;

      socket.on(event, handler);
      this.eventListeners.add({ event, handler });
      return true;
    }
  }

  // MEMORY OPTIMIZATION: Connection validation with IP limits
  function validateNewConnection(clientIP) {
    // Check global connection limit
    if (activeConnections.size >= CONNECTION_LIMITS.MAX_CONNECTIONS) {
      logger.warn("WebSocket", `Global connection limit reached (${CONNECTION_LIMITS.MAX_CONNECTIONS})`);
      return { valid: false, reason: "Global connection limit reached" };
    }

    // Check per-IP limit
    const ipConnections = connectionsByIP.get(clientIP) || new Set();
    if (ipConnections.size >= CONNECTION_LIMITS.MAX_CONNECTIONS_PER_IP) {
      logger.warn("WebSocket", `IP connection limit reached for ${clientIP} (${CONNECTION_LIMITS.MAX_CONNECTIONS_PER_IP})`);
      return { valid: false, reason: "IP connection limit reached" };
    }

    return { valid: true };
  }

  // MEMORY OPTIMIZATION: Enhanced connection cleanup with proper resource management
  function forceCleanupConnection(clientId, reason = "unknown") {
    if (cleanupQueue.has(clientId)) {
      return; // Already being cleaned up
    }

    cleanupQueue.add(clientId);
    
    try {
      const state = activeConnections.get(clientId);
      if (state) {
        // Update IP tracking
        const ipConnections = connectionsByIP.get(state.connectionIP);
        if (ipConnections) {
          ipConnections.delete(clientId);
          if (ipConnections.size === 0) {
            connectionsByIP.delete(state.connectionIP);
          }
        }

        // Destroy connection state (handles all cleanup)
        state.destroy();
        
        logger.log(
          "WebSocket",
          `Connection ${clientId} cleanup completed - reason: ${reason}, remaining: ${activeConnections.size - 1}`
        );
      }

      // Remove from active connections
      activeConnections.delete(clientId);
      
      // Clean up rate limiting data
      messageRateLimits.delete(clientId);
      
    } catch (error) {
      logger.error("WebSocket", `Error during cleanup for ${clientId}: ${error.message}`);
    } finally {
      cleanupQueue.delete(clientId);
    }
  }

  // MEMORY OPTIMIZATION: Enhanced message sending with timeout and proper error handling
  async function sendMessageToConnection(connectionState, message, timeout = 5000) {
    if (connectionState.isDestroyed || cleanupQueue.has(connectionState.id)) {
      return { success: false, reason: "connection_destroyed" };
    }

    if (connectionState.sendInProgress) {
      return { success: false, reason: "send_in_progress" };
    }

    connectionState.sendInProgress = true;

    try {
      const socket = connectionState.getSocket();
      if (!socket || socket.readyState !== 1) {
        return { success: false, reason: "socket_not_ready" };
      }

      // MEMORY OPTIMIZATION: Create message with timeout
      const messageToSend = JSON.stringify({
        timestamp: new Date().toISOString(),
        client_id: connectionState.id,
        server_time: new Date().toISOString(),
        ...message,
      });

      // Check message size
      if (messageToSend.length > CONNECTION_LIMITS.MAX_MESSAGE_SIZE) {
        logger.warn("WebSocket", `Message too large for ${connectionState.id}: ${messageToSend.length} bytes`);
        return { success: false, reason: "message_too_large" };
      }

      // MEMORY OPTIMIZATION: Send with timeout using AbortController
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), timeout);

      try {
        if (connectionState.abortController.signal.aborted) {
          return { success: false, reason: "operation_aborted" };
        }

        await new Promise((resolve, reject) => {
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

        // Update activity tracking
        connectionState.lastActivity = Date.now();
        connectionState.messageCount++;

        return { success: true };

      } finally {
        clearTimeout(timeoutId);
      }

    } catch (error) {
      logger.error("WebSocket", `Send failed for ${connectionState.id}: ${error.message}`);
      return { success: false, reason: "send_error", error: error.message };
    } finally {
      connectionState.sendInProgress = false;
    }
  }

  // MEMORY OPTIMIZATION: WebSocket route with enhanced resource management
  fastify.register(async function (fastify) {
    fastify.get(
      "/ws-client",
      {
        websocket: true,
        preHandler: async (request, reply) => {
          reply.header("Access-Control-Allow-Origin", "*");
          reply.header(
            "Access-Control-Allow-Methods",
            "GET, POST, PUT, DELETE, OPTIONS"
          );
          reply.header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization"
          );
        },
      },
      async (socket, request) => {
        const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
        const clientIP = request.ip || request.socket.remoteAddress || "unknown";

        // MEMORY OPTIMIZATION: Validate connection limits
        const validation = validateNewConnection(clientIP);
        if (!validation.valid) {
          logger.warn("WebSocket", `Connection rejected for ${clientIP}: ${validation.reason}`);
          try {
            socket.close(1013, validation.reason);
          } catch (error) {
            logger.error("WebSocket", `Error closing rejected connection: ${error.message}`);
          }
          return;
        }

        logger.log("WebSocket", `New client connecting: ${clientId} from ${clientIP}`);

        // MEMORY OPTIMIZATION: Create enhanced connection state
        const connectionState = new ConnectionState(clientId, socket, clientIP);

        // Track connection by IP
        if (!connectionsByIP.has(clientIP)) {
          connectionsByIP.set(clientIP, new Set());
        }
        connectionsByIP.get(clientIP).add(clientId);

        // Store connection
        activeConnections.set(clientId, connectionState);

        // MEMORY OPTIMIZATION: Authentication timeout
        connectionState.authTimeout = setTimeout(() => {
          if (!connectionState.isAuthenticated && !connectionState.isDestroyed) {
            logger.warn("WebSocket", `Authentication timeout for ${clientId}`);
            forceCleanupConnection(clientId, "auth_timeout");
          }
        }, CONNECTION_LIMITS.AUTH_TIMEOUT);

        // MEMORY OPTIMIZATION: Enhanced message handler with rate limiting and async operations control
        const messageHandler = async (data) => {
          try {
            if (connectionState.isDestroyed || cleanupQueue.has(clientId)) {
              return;
            }

            // Rate limiting
            if (!checkMessageRateLimit(clientId)) {
              await sendMessageToConnection(connectionState, {
                type: "error",
                message: "Rate limit exceeded"
              });
              return;
            }

            connectionState.lastActivity = Date.now();

            let message;
            try {
              const messageStr = data.toString();
              if (messageStr.length > CONNECTION_LIMITS.MAX_MESSAGE_SIZE) {
                throw new Error("Message too large");
              }
              message = JSON.parse(messageStr);
            } catch (parseError) {
              logger.error("WebSocket", `Parse error for ${clientId}: ${parseError.message}`);
              await sendMessageToConnection(connectionState, {
                type: "error",
                message: "Invalid message format"
              });
              return;
            }

            // Process message with timeout
            const processingTimeout = setTimeout(() => {
              logger.warn("WebSocket", `Message processing timeout for ${clientId}`);
              connectionState.abortController.abort();
            }, 30000);

            try {
              await processMessage(connectionState, message);
            } finally {
              clearTimeout(processingTimeout);
            }

          } catch (error) {
            logger.error("WebSocket", `Message handler error for ${clientId}: ${error.message}`);
          }
        };

        // MEMORY OPTIMIZATION: Connection close handler
        const closeHandler = (code, reason) => {
          logger.log("WebSocket", `Client ${clientId} disconnected: ${code} - ${reason || "no reason"}`);
          forceCleanupConnection(clientId, `close_${code}`);
        };

        // MEMORY OPTIMIZATION: Error handler
        const errorHandler = (error) => {
          logger.error("WebSocket", `Socket error for ${clientId}: ${error.message}`);
          forceCleanupConnection(clientId, `error_${error.code || 'unknown'}`);
        };

        // MEMORY OPTIMIZATION: Add tracked event listeners
        connectionState.addEventListenerTracked('message', messageHandler);
        connectionState.addEventListenerTracked('close', closeHandler);
        connectionState.addEventListenerTracked('error', errorHandler);

        // MEMORY OPTIMIZATION: Enhanced heartbeat with resource cleanup
        connectionState.heartbeatInterval = setInterval(async () => {
          try {
            if (connectionState.isDestroyed || cleanupQueue.has(clientId)) {
              clearInterval(connectionState.heartbeatInterval);
              return;
            }

            const socket = connectionState.getSocket();
            if (!socket || socket.readyState !== 1) {
              logger.log("WebSocket", `Socket not available for heartbeat ${clientId}`);
              forceCleanupConnection(clientId, "heartbeat_socket_unavailable");
              return;
            }

            const result = await sendMessageToConnection(connectionState, { type: "ping" });
            if (!result.success) {
              logger.warn("WebSocket", `Heartbeat failed for ${clientId}: ${result.reason}`);
              if (result.reason !== "send_in_progress") {
                forceCleanupConnection(clientId, "heartbeat_failed");
              }
            }

            // Check for stale connections
            const now = Date.now();
            const timeSinceLastPing = now - connectionState.lastPingTime;
            const timeSinceLastActivity = now - connectionState.lastActivity;

            if (timeSinceLastPing > 90000 || timeSinceLastActivity > 120000) {
              logger.warn("WebSocket", `Connection ${clientId} is stale, closing`);
              forceCleanupConnection(clientId, "stale_connection");
            }

          } catch (error) {
            logger.error("WebSocket", `Heartbeat error for ${clientId}: ${error.message}`);
            forceCleanupConnection(clientId, "heartbeat_error");
          }
        }, CONNECTION_LIMITS.HEARTBEAT_INTERVAL);

        // MEMORY OPTIMIZATION: Send initial messages with timeout
        setTimeout(async () => {
          if (connectionState.isDestroyed) return;

          const establishResult = await sendMessageToConnection(connectionState, {
            type: "connection-established",
            client_id: clientId,
            server_time: new Date().toISOString(),
            server_info: {
              version: "1.0.0",
              capabilities: ["text-input", "model-info", "audio", "interrupt"],
            },
          });

          if (establishResult.success) {
            setTimeout(async () => {
              if (!connectionState.isDestroyed) {
                await sendMessageToConnection(connectionState, {
                  type: "auth-required",
                  message: "Please provide authentication token",
                });
              }
            }, 200);
          }
        }, 300);

        logger.log("WebSocket", `Client ${clientId} setup completed successfully`);
      }
    );
  });

  // MEMORY OPTIMIZATION: Enhanced message processing with timeout and cancellation
  async function processMessage(connectionState, message) {
    if (connectionState.abortController.signal.aborted) {
      return;
    }

    logger.log("WebSocket", `Processing ${message.type} from ${connectionState.id}`);

    // Handle authentication for non-system messages
    if (
      !connectionState.isAuthenticated &&
      message.type !== "ping" &&
      message.type !== "pong"
    ) {
      const user = await authenticateMessage(connectionState, message);

      if (!user) {
        await sendMessageToConnection(connectionState, {
          type: "auth-failed",
          message: "Invalid or missing authentication token",
        });
        return;
      }

      connectionState.user = user;
      connectionState.isAuthenticated = true;

      // Clear auth timeout
      if (connectionState.authTimeout) {
        clearTimeout(connectionState.authTimeout);
        connectionState.authTimeout = null;
      }

      await sendMessageToConnection(connectionState, {
        type: "auth-success",
        message: "Authentication successful",
        user_id: user.user_id,
      });

      logger.log("WebSocket", `Client ${connectionState.id} authenticated as user: ${user.user_id}`);
    }

    // Process message types
    switch (message.type) {
      case "ping":
        await sendMessageToConnection(connectionState, { type: "pong" });
        break;

      case "pong":
        connectionState.lastPingTime = Date.now();
        break;

      case "model-info":
        if (connectionState.isAuthenticated && message.model_info) {
          connectionState.modelInfo = message.model_info;
          logger.log("WebSocket", `Model info received for ${connectionState.id}`);
          await sendMessageToConnection(connectionState, {
            type: "model-info-received",
            message: "Model information updated successfully",
          });
        }
        break;

      case "text-input":
        if (connectionState.isAuthenticated) {
          await handleTextInput(connectionState, message);
        } else {
          await sendMessageToConnection(connectionState, {
            type: "error",
            message: "Authentication required for text input",
          });
        }
        break;

      case "interrupt":
        if (connectionState.isAuthenticated) {
          handleInterrupt(connectionState);
        }
        break;

      case "connection-test":
        await sendMessageToConnection(connectionState, {
          type: "connection-test-response",
          message: "Connection is working properly",
          client_id: connectionState.id,
          connection_stats: {
            messages_processed: connectionState.messageCount,
            connected_duration: Date.now() - connectionState.connectedAt.getTime(),
            last_activity: connectionState.lastActivity,
          },
        });
        break;

      default:
        logger.warn("WebSocket", `Unknown message type: ${message.type} from ${connectionState.id}`);
        await sendMessageToConnection(connectionState, {
          type: "error",
          message: `Unknown message type: ${message.type}`,
        });
    }
  }

  // MEMORY OPTIMIZATION: Authentication with timeout and abort support
  async function authenticateMessage(connectionState, message) {
    connectionState.authAttempts++;
    if (connectionState.authAttempts > connectionState.maxAuthAttempts) {
      logger.warn("WebSocket", `Too many auth attempts for ${connectionState.id}`);
      forceCleanupConnection(connectionState.id, "too_many_auth_attempts");
      return null;
    }

    if (!message.auth_token) {
      logger.warn("WebSocket", `No auth_token for ${connectionState.id}`);
      return null;
    }

    try {
      // MEMORY OPTIMIZATION: Add timeout to auth check
      const authPromise = import("./api-helper.js").then((m) =>
        m.checkForAuth(message.auth_token)
      );
      
      const authResult = await Promise.race([
        authPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Auth timeout')), 10000)
        )
      ]);

      if (authResult && authResult.valid) {
        logger.log("WebSocket", `Authentication successful for ${connectionState.id}`);
        connectionState.authAttempts = 0;
        return authResult;
      } else {
        logger.warn("WebSocket", `Authentication failed for ${connectionState.id}`);
        return null;
      }
    } catch (error) {
      logger.error("WebSocket", `Authentication error for ${connectionState.id}: ${error.message}`);
      return null;
    }
  }

  // MEMORY OPTIMIZATION: Text input handler with timeout and abort support
  async function handleTextInput(connectionState, message) {
    if (connectionState.abortController.signal.aborted) {
      return;
    }

    const { user } = connectionState;

    if (!message.text || !message.text.trim()) {
      await sendMessageToConnection(connectionState, {
        type: "error",
        message: "Empty text input received",
      });
      return;
    }

    const responseId = `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    connectionState.currentResponseId = responseId;

    try {
      await sendMessageToConnection(connectionState, {
        type: "response-queued",
        response_id: responseId,
      });

      // Apply alternate spelling replacements
      let processedText = await applyAlternateSpelling(message.text, user.user_id);

      logger.log("WebSocket", `Processing text input for user ${user.user_id}`);

      // MEMORY OPTIMIZATION: Add timeout to AI response
      const chatPromise = aiHelper.respondToChat(
        {
          message: processedText,
          user: user.user_name || "User",
        },
        user.user_id
      );

      const chatResponse = await Promise.race([
        chatPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('AI response timeout')), 60000)
        )
      ]);

      if (!chatResponse || !chatResponse.success || !chatResponse.text) {
        throw new Error(chatResponse?.error || "Failed to generate response");
      }

      // Send text response
      await sendMessageToConnection(connectionState, {
        type: "full-text",
        text: chatResponse.text,
        response_id: responseId,
      });

      logger.log("WebSocket", `Text response sent for user ${user.user_id}`);

      // Generate audio if enabled
      if (user.tts_enabled) {
        await generateAndSendAudio(connectionState, chatResponse.text, responseId);
      } else {
        await sendMessageToConnection(connectionState, {
          type: "synthesis-complete",
          response_id: responseId,
        });
      }

    } catch (error) {
      logger.error("WebSocket", `Error processing text input for ${connectionState.id}: ${error.message}`);
      await sendMessageToConnection(connectionState, {
        type: "error",
        message: "Failed to generate response: " + error.message,
        response_id: responseId,
      });
      connectionState.currentResponseId = null;
    }
  }

  // Apply alternate spelling replacements for vocal inputs
  async function applyAlternateSpelling(text, userId) {
    try {
      const userObj = await import("./api-helper.js").then((m) =>
        m.returnAuthObject(userId)
      );

      if (
        !userObj ||
        !userObj.alternateSpell ||
        !Array.isArray(userObj.alternateSpell)
      ) {
        return text;
      }

      let processedText = text;

      for (const alternateEntry of userObj.alternateSpell) {
        if (typeof alternateEntry === "string") {
          const regex = new RegExp(
            `\\b${escapeRegExp(alternateEntry)}\\b`,
            "gi"
          );
          processedText = processedText.replace(regex, userObj.bot_name);
        } else if (
          typeof alternateEntry === "object" &&
          alternateEntry.from &&
          alternateEntry.to
        ) {
          const regex = new RegExp(
            `\\b${escapeRegExp(alternateEntry.from)}\\b`,
            "gi"
          );
          processedText = processedText.replace(regex, alternateEntry.to);
        }
      }

      return processedText;
    } catch (error) {
      logger.error("WebSocket", `Error applying alternate spelling: ${error.message}`);
      return text;
    }
  }

  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // MEMORY OPTIMIZATION: Audio generation with timeout and abort support
  async function generateAndSendAudio(connectionState, text, responseId) {
    if (connectionState.abortController.signal.aborted) {
      return;
    }

    const { user, modelInfo } = connectionState;

    try {
      await sendMessageToConnection(connectionState, {
        type: "synthesis-started",
        response_id: responseId,
      });

      logger.log("WebSocket", `Generating TTS audio for user ${user.user_id}`);

      // MEMORY OPTIMIZATION: Add timeout to audio generation
      const audioPromise = aiHelper.respondWithVoice(text, user.user_id);
      const audioResult = await Promise.race([
        audioPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Audio generation timeout')), 30000)
        )
      ]);

      if (audioResult.error) {
        throw new Error(audioResult.error);
      }

      await sendMessageToConnection(connectionState, {
        type: "synthesis-complete",
        response_id: responseId,
      });

      const displayText = {
        text: text,
        name: user.bot_name || "Assistant",
        avatar: user.avatar_url || "",
      };

      const actions = {};
      if (
        modelInfo &&
        modelInfo.expressions &&
        Array.isArray(modelInfo.expressions)
      ) {
        actions.expressions = selectExpressions(text, modelInfo.expressions);
      }

      await sendMessageToConnection(connectionState, {
        type: "audio-url",
        audio_url: audioResult,
        display_text: displayText,
        actions: Object.keys(actions).length > 0 ? actions : undefined,
        response_id: responseId,
        audio_format: "wav",
        sample_rate: 22050,
        bit_depth: 16,
      });

      logger.log("WebSocket", `Audio URL sent for user ${user.user_id}`);
    } catch (error) {
      logger.error("WebSocket", `Error generating audio for ${user.user_id}: ${error.message}`);
      await sendMessageToConnection(connectionState, {
        type: "error",
        message: "Failed to generate audio response",
        response_id: responseId,
        error_details: error.message,
      });
    }
  }

  function handleInterrupt(connectionState) {
    const { user } = connectionState;
    logger.log("WebSocket", `Interrupt received from user ${user?.user_id || "unknown"}`);
    connectionState.currentResponseId = null;
    connectionState.abortController.abort(); // Cancel any ongoing operations
    sendMessageToConnection(connectionState, {
      type: "interrupt",
      message: "Response interrupted",
    });
  }

  // Enhanced status endpoint with memory information
  fastify.get("/ws-status", async (request, reply) => {
    const connections = Array.from(activeConnections.values()).map((conn) => ({
      id: conn.id,
      authenticated: conn.isAuthenticated,
      user_id: conn.user?.user_id || null,
      connected_at: conn.connectedAt,
      socket_state: conn.getSocket()?.readyState ?? "destroyed",
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

  // MEMORY OPTIMIZATION: Graceful shutdown cleanup
  const gracefulShutdown = () => {
    logger.log("WebSocket", "Starting graceful shutdown...");
    
    // Clear cleanup interval
    clearInterval(cleanupInterval);
    
    // Cleanup all active connections
    for (const [clientId] of activeConnections) {
      forceCleanupConnection(clientId, "server_shutdown");
    }
    
    // Clear tracking maps
    activeConnections.clear();
    connectionsByIP.clear();
    messageRateLimits.clear();
    cleanupQueue.clear();
    
    logger.log("WebSocket", "Graceful shutdown completed");
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  // Expression selection utility (unchanged for brevity)
  function selectExpressions(text, availableExpressions) {
    const emotionKeywords = {
      happy: ["happy", "joy", "excited", "great", "awesome", "wonderful", "amazing", "!", "😊", "😄"],
      sad: ["sad", "sorry", "disappointed", "unfortunate", "regret", "😢", "😞"],
      surprised: ["wow", "amazing", "incredible", "unbelievable", "surprise", "!", "😮", "😲"],
      angry: ["angry", "frustrated", "annoyed", "mad", "irritated", "😠", "😡"],
      neutral: ["hello", "hi", "okay", "alright", "yes", "no", "maybe"],
    };

    const textLower = text.toLowerCase();
    let detectedEmotion = "neutral";
    let maxMatches = 0;

    for (const [emotion, keywords] of Object.entries(emotionKeywords)) {
      const matches = keywords.filter((keyword) => textLower.includes(keyword)).length;
      if (matches > maxMatches) {
        maxMatches = matches;
        detectedEmotion = emotion;
      }
    }

    const expressionMapping = {
      happy: ["smile", "happy", "joy", "cheerful", 0, 1],
      sad: ["sad", "disappointed", "down", 2, 3],
      surprised: ["surprised", "shock", "amazed", 4, 5],
      angry: ["angry", "mad", "annoyed", 6, 7],
      neutral: ["neutral", "default", "calm", 8, 9],
    };

    const possibleExpressions = expressionMapping[detectedEmotion] || expressionMapping.neutral;
    const selectedExpressions = [];

    for (const expr of possibleExpressions) {
      if (availableExpressions.includes(expr)) {
        selectedExpressions.push(expr);
        break;
      }
    }

    if (selectedExpressions.length === 0 && availableExpressions.length > 0) {
      selectedExpressions.push(availableExpressions[0]);
    }

    return selectedExpressions;
  }

  logger.log("WebSocket", "Memory-optimized WebSocket route registered at /ws-client");

  // Register other routes
  await fastify.register(routes, { prefix: "/api/v1" });
  await fastify.register(audioRoutes, {
    outputDir: "final",
    prefix: "/files/audio",
    addContentDisposition: true,
  });
  await fastify.register(twitchEventSubRoutes, { prefix: "/api/v1/twitch" });
  await fastify.register(webRoutes, { prefix: "/web" });

  return fastify;
};

// Rest of the code remains the same (preflightChecks, launchRest, initializeApp functions)
export async function preflightChecks() {
  try {
    const axios = (await import("axios")).default;
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

    logger.log(
      "API",
      `Current TTS engine: ${ttsPreference}, ${ttsRes.status == 200 ? "is alive." : "is not alive."}`
    );
    const databaseRes = await aiHelper.checkMilvusHealth();

    return {
      llmStatuses: {
        allTalkIsOnline: ttsRes.status == 200 ? true : false,
        embeddingIsOnline: await aiHelper.checkEndpoint(
          await retrieveConfigValue("models.embedding.endpoint"),
          await retrieveConfigValue("models.embedding.apiKey"),
          await retrieveConfigValue("models.embedding.model")
        ),
        llmIsOnline: await aiHelper.checkEndpoint(
          await retrieveConfigValue("models.chat.endpoint"),
          await retrieveConfigValue("models.chat.apiKey"),
          await retrieveConfigValue("models.chat.model")
        ),
        summaryIsOnline: await aiHelper.checkEndpoint(
          await retrieveConfigValue("models.summary.endpoint"),
          await retrieveConfigValue("models.summary.apiKey"),
          await retrieveConfigValue("models.summary.model")
        ),
        queryIsOnline: await aiHelper.checkEndpoint(
          await retrieveConfigValue("models.query.endpoint"),
          await retrieveConfigValue("models.query.apiKey"),
          await retrieveConfigValue("models.query.model")
        ),
        conversionIsOnline: await aiHelper.checkEndpoint(
          await retrieveConfigValue("models.conversion.endpoint"),
          await retrieveConfigValue("models.conversion.apiKey"),
          await retrieveConfigValue("models.conversion.model")
        ),
      },
      restIsOnline: true,
      dbIsOnline: databaseRes,
      websocketEnabled: true,
    };
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
      websocketEnabled: false,
    };
  }
}

export async function launchRest(fastify) {
  const portNum = await retrieveConfigValue("server.port");
  const internalHost = await retrieveConfigValue("server.endpoints.internal");

  try {
    await fastify.listen({ port: portNum, host: internalHost });

    const isHttps = fastify.initialConfig.https ? true : false;
    const protocol = isHttps ? "https" : "http";
    const wsProtocol = isHttps ? "wss" : "ws";

    logger.log(
      "API",
      `Fastify server launched successfully on ${protocol}://${internalHost}:${portNum}`
    );
    logger.log(
      "WebSocket",
      `WebSocket endpoint available at ${wsProtocol}://${internalHost}:${portNum}/ws-client`
    );
    logger.log(
      "WebSocket",
      `WebSocket status endpoint available at ${protocol}://${internalHost}:${portNum}/ws-status`
    );

    return Promise.resolve();
  } catch (err) {
    logger.error("API", `Failed to launch API server with error: ${err}`);
    await fs.writeFile("./error.txt", JSON.stringify(err));
    throw err;
  }
}

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
            user.user_id
          );
          if (!collectionExists) {
            logger.error(
              "Milvus",
              `Failed to create collection ${collectionName} for user ${user.user_id}`
            );
            continue;
          }

          const isLoaded = await aiHelper.loadCollectionIfNeeded(
            collectionName,
            user.user_id
          );
          if (!isLoaded) {
            logger.error(
              "Milvus",
              `Failed to load collection ${collectionName} for user ${user.user_id}`
            );
            continue;
          }
        } catch (error) {
          logger.error(
            "Milvus",
            `Error with collection ${collectionName} for user ${user.user_id}: ${error.message}`
          );
          continue;
        }
      }
    }

    await Promise.all(
      allUsers.map((user) => aiHelper.startIndexingVectors(user.user_id))
    );
    await preloadAllTokenizers();

    const server = await createServer();
    await launchRest(server);

    const status = await preflightChecks();
    await initAllAPIs();

    try {
      logger.log("System", "Importing Twitch EventSub manager...");
      const { registerAllUsersEventSub, setupTwitchCronJobs } = await import(
        "./twitch-eventsub-manager.js"
      );

      logger.log("System", "Registering Twitch EventSub subscriptions...");
      const eventSubResults = await registerAllUsersEventSub();
      logger.log(
        "System",
        `EventSub registration complete: ${eventSubResults.success} successful, ${eventSubResults.failures} failed`
      );

      logger.log("System", "Setting up Twitch cron jobs...");
      setupTwitchCronJobs();
    } catch (eventSubError) {
      logger.error(
        "System",
        `Error with Twitch integration: ${eventSubError.message}`
      );
    }

    logger.log("System", "Enspira is fully initialized and ready!");
    logger.log(
      "WebSocket",
      "Memory-optimized VTuber WebSocket integration is active and ready for connections!"
    );

    return { server, status };
  } catch (error) {
    logger.error(
      "System",
      `Failed to initialize the application: ${error.message}`
    );
    throw error;
  }
}

if (import.meta.url === import.meta.main) {
  initializeApp().catch((err) => {
    logger.error("System", `Fatal error in application: ${err.message}`);
    process.exit(1);
  });
}

export default initializeApp;