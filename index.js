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

  // Enhanced WebSocket connection tracking with proper state management
  // Enhanced WebSocket connection tracking with correct API
  const activeConnections = new Map();
  const connectionCleanupQueue = new Set();

  // Helper function to safely get connection state
  function getConnectionState(clientId) {
    const state = activeConnections.get(clientId);
    if (!state) {
      logger.warn("WebSocket", `Connection state not found for ${clientId}`);
      return null;
    }

    if (state.isDestroyed) {
      logger.warn("WebSocket", `Connection ${clientId} is marked as destroyed`);
      return null;
    }

    return state;
  }

  // Socket validation function
  function validateSocket(socket, clientId) {
    if (!socket) {
      logger.warn("WebSocket", `Socket is null/undefined for ${clientId}`);
      return false;
    }

    if (typeof socket.send !== "function") {
      logger.error(
        "WebSocket",
        `Socket for ${clientId} is not a valid WebSocket - missing send method`
      );
      return false;
    }

    const readyState = socket.readyState;
    if (readyState === undefined || readyState === null) {
      logger.warn(
        "WebSocket",
        `Socket for ${clientId} has invalid readyState: ${readyState}`
      );
      return false;
    }

    return true;
  }

  // FIXED: WebSocket route using the correct API pattern
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
      // FIXED: Correct handler signature - socket is the first parameter
      async (socket, request) => {
        const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
        const clientIP =
          request.ip || request.socket.remoteAddress || "unknown";

        logger.log(
          "WebSocket",
          `New client connecting: ${clientId} from ${clientIP}`
        );

        // FIXED: Direct socket validation - no connection object
        if (!validateSocket(socket, clientId)) {
          logger.error("WebSocket", `Socket validation failed for ${clientId}`);
          try {
            socket.close(1003, "Socket validation failed");
          } catch (closeError) {
            logger.error(
              "WebSocket",
              `Error closing invalid socket: ${closeError.message}`
            );
          }
          return;
        }

        logger.log(
          "WebSocket",
          `Socket validation passed for ${clientId} - readyState: ${socket.readyState}`
        );

        // FIXED: Enhanced connection state with direct socket reference
        const connectionState = {
          id: clientId,
          socket: socket, // Direct socket reference
          user: null,
          isAuthenticated: false,
          lastPingTime: Date.now(),
          modelInfo: null,
          currentResponseId: null,
          connectedAt: new Date(),
          isDestroyed: false,
          processingMessage: false,
          sendInProgress: false,
          connectionIP: clientIP,
          messageCount: 0,
          lastActivity: Date.now(),
          authAttempts: 0,
          maxAuthAttempts: 3,
        };

        // Store connection
        activeConnections.set(clientId, connectionState);
        logger.log(
          "WebSocket",
          `Connection ${clientId} stored - Active connections: ${activeConnections.size}`
        );

        // Enhanced message sending function
        function sendMessage(message, retryCount = 0) {
          const maxRetries = 2;

          try {
            const state = getConnectionState(clientId);
            if (!state) {
              logger.error(
                "WebSocket",
                `Cannot send message - connection state not found for ${clientId}`
              );
              return false;
            }

            if (connectionCleanupQueue.has(clientId)) {
              logger.warn(
                "WebSocket",
                `Cannot send message - ${clientId} is being cleaned up`
              );
              return false;
            }

            if (state.sendInProgress) {
              if (retryCount < maxRetries) {
                setTimeout(
                  () => sendMessage(message, retryCount + 1),
                  100 * (retryCount + 1)
                );
                return true;
              } else {
                logger.warn(
                  "WebSocket",
                  `Send still in progress for ${clientId} after retries, dropping message`
                );
                return false;
              }
            }

            state.sendInProgress = true;

            const currentSocket = state.socket;
            if (!validateSocket(currentSocket, clientId)) {
              logger.warn(
                "WebSocket",
                `Socket validation failed during send for ${clientId}`
              );
              state.sendInProgress = false;
              return false;
            }

            // Check socket state
            const WebSocketStates = {
              CONNECTING: 0,
              OPEN: 1,
              CLOSING: 2,
              CLOSED: 3,
            };

            if (currentSocket.readyState !== WebSocketStates.OPEN) {
              logger.warn(
                "WebSocket",
                `Cannot send to ${clientId} - socket not open (state: ${currentSocket.readyState})`
              );
              state.sendInProgress = false;
              return false;
            }

            // Create and send message
            const messageToSend = JSON.stringify({
              timestamp: new Date().toISOString(),
              client_id: clientId,
              server_time: new Date().toISOString(),
              ...message,
            });

            try {
              currentSocket.send(messageToSend);

              // Update activity tracking
              state.lastActivity = Date.now();
              state.messageCount++;

              logger.log(
                "WebSocket",
                `Message sent successfully to ${clientId}: ${message.type} (total: ${state.messageCount})`
              );

              state.sendInProgress = false;
              return true;
            } catch (sendError) {
              logger.error(
                "WebSocket",
                `Send operation failed for ${clientId}: ${sendError.message}`
              );
              state.sendInProgress = false;

              if (
                retryCount < maxRetries &&
                !sendError.message.includes("ENOTCONN")
              ) {
                logger.log(
                  "WebSocket",
                  `Retrying send for ${clientId} (attempt ${retryCount + 1})`
                );
                setTimeout(
                  () => sendMessage(message, retryCount + 1),
                  200 * (retryCount + 1)
                );
                return true;
              }

              return false;
            }
          } catch (error) {
            const state = getConnectionState(clientId);
            if (state) {
              state.sendInProgress = false;
            }

            logger.error(
              "WebSocket",
              `Failed to send message to ${clientId}: ${error.message}`
            );
            return false;
          }
        }

        // Authentication function
        async function authenticateMessage(message) {
          const state = getConnectionState(clientId);
          if (!state) return null;

          state.authAttempts++;
          if (state.authAttempts > state.maxAuthAttempts) {
            logger.warn(
              "WebSocket",
              `Too many auth attempts for ${clientId}, blocking`
            );
            return null;
          }

          logger.log(
            "WebSocket",
            `Authentication attempt ${state.authAttempts}/${state.maxAuthAttempts} for ${clientId}:`,
            {
              hasAuthToken: !!message.auth_token,
              tokenLength: message.auth_token?.length || 0,
              messageType: message.type,
            }
          );

          if (!message.auth_token) {
            logger.warn(
              "WebSocket",
              `No auth_token in message from ${clientId}`
            );
            return null;
          }

          try {
            const { checkForAuth } = await import("./api-helper.js");
            const authResult = await checkForAuth(message.auth_token);

            if (authResult && authResult.valid) {
              logger.log(
                "WebSocket",
                `Authentication successful for ${clientId}: user ${authResult.user_id}`
              );
              state.authAttempts = 0;
              return authResult;
            } else {
              logger.warn(
                "WebSocket",
                `Authentication failed for ${clientId}: invalid token`
              );
              return null;
            }
          } catch (error) {
            logger.error(
              "WebSocket",
              `Authentication error for ${clientId}: ${error.message}`
            );
            return null;
          }
        }

        // Connection cleanup function
        function cleanupConnection(reason = "unknown") {
          if (connectionCleanupQueue.has(clientId)) {
            logger.log(
              "WebSocket",
              `Cleanup already in progress for ${clientId}`
            );
            return;
          }

          connectionCleanupQueue.add(clientId);
          logger.log(
            "WebSocket",
            `Starting cleanup for ${clientId} - reason: ${reason}`
          );

          try {
            const state = activeConnections.get(clientId);
            if (state) {
              state.isDestroyed = true;
              state.socket = null;

              logger.log(
                "WebSocket",
                `Connection ${clientId} stats: ${state.messageCount} messages, active for ${Date.now() - state.connectedAt.getTime()}ms`
              );
            }

            if (heartbeatInterval) {
              clearInterval(heartbeatInterval);
            }

            activeConnections.delete(clientId);

            logger.log(
              "WebSocket",
              `Cleanup completed for ${clientId} - Active connections: ${activeConnections.size}`
            );
          } catch (error) {
            logger.error(
              "WebSocket",
              `Error during cleanup for ${clientId}: ${error.message}`
            );
          } finally {
            connectionCleanupQueue.delete(clientId);
          }
        }

        // Heartbeat with proper socket validation
        const heartbeatInterval = setInterval(() => {
          try {
            const state = getConnectionState(clientId);
            if (!state) {
              logger.log(
                "WebSocket",
                `No valid state for ${clientId} in heartbeat, cleaning up`
              );
              clearInterval(heartbeatInterval);
              return;
            }

            if (connectionCleanupQueue.has(clientId)) {
              logger.log(
                "WebSocket",
                `Connection ${clientId} is being cleaned up, stopping heartbeat`
              );
              clearInterval(heartbeatInterval);
              return;
            }

            const currentSocket = state.socket;
            if (
              !validateSocket(currentSocket, clientId) ||
              currentSocket.readyState !== 1
            ) {
              logger.log(
                "WebSocket",
                `Socket not available for ${clientId} in heartbeat, cleaning up`
              );
              clearInterval(heartbeatInterval);
              cleanupConnection("heartbeat_socket_unavailable");
              return;
            }

            const pingSuccess = sendMessage({ type: "ping" });
            if (!pingSuccess) {
              logger.warn("WebSocket", `Failed to send ping to ${clientId}`);
            }

            // Check for stale connections
            const timeSinceLastPing = Date.now() - state.lastPingTime;
            const timeSinceLastActivity = Date.now() - state.lastActivity;

            if (timeSinceLastPing > 90000 || timeSinceLastActivity > 120000) {
              logger.warn(
                "WebSocket",
                `Connection ${clientId} is stale, closing`
              );
              try {
                currentSocket.close(1000, "Connection timeout");
              } catch (error) {
                logger.error(
                  "WebSocket",
                  `Error closing stale connection ${clientId}: ${error.message}`
                );
              }
              cleanupConnection("stale_connection");
            }
          } catch (error) {
            logger.error(
              "WebSocket",
              `Error in heartbeat for ${clientId}: ${error.message}`
            );
            clearInterval(heartbeatInterval);
            cleanupConnection("heartbeat_error");
          }
        }, 30000);

        // FIXED: Message handler using direct socket API
        socket.on("message", async (data) => {
          try {
            const state = getConnectionState(clientId);
            if (!state) {
              logger.warn(
                "WebSocket",
                `Received message for invalid connection ${clientId}`
              );
              return;
            }

            if (connectionCleanupQueue.has(clientId)) {
              logger.warn(
                "WebSocket",
                `Ignoring message for ${clientId} - cleanup in progress`
              );
              return;
            }

            state.processingMessage = true;
            state.lastActivity = Date.now();

            let message;
            try {
              message = JSON.parse(data.toString());
            } catch (parseError) {
              logger.error(
                "WebSocket",
                `Failed to parse message from ${clientId}: ${parseError.message}`
              );
              sendMessage({
                type: "error",
                message: "Invalid message format",
              });
              state.processingMessage = false;
              return;
            }

            logger.log(
              "WebSocket",
              `Processing ${message.type} from ${clientId} (msg #${state.messageCount + 1})`
            );

            // Handle authentication for non-system messages
            if (
              !state.isAuthenticated &&
              message.type !== "ping" &&
              message.type !== "pong"
            ) {
              const user = await authenticateMessage(message);

              if (!user) {
                sendMessage({
                  type: "auth-failed",
                  message: "Invalid or missing authentication token",
                });
                state.processingMessage = false;
                return;
              }

              state.user = user;
              state.isAuthenticated = true;

              sendMessage({
                type: "auth-success",
                message: "Authentication successful",
                user_id: user.user_id,
              });

              logger.log(
                "WebSocket",
                `Client ${clientId} authenticated as user: ${user.user_id}`
              );
            }

            // Process message types
            switch (message.type) {
              case "ping":
                sendMessage({ type: "pong" });
                break;

              case "pong":
                state.lastPingTime = Date.now();
                break;

              case "model-info":
                if (state.isAuthenticated && message.model_info) {
                  state.modelInfo = message.model_info;
                  logger.log(
                    "WebSocket",
                    `Model info received for ${clientId}: ${message.model_info.name || "Unknown"}`
                  );
                  sendMessage({
                    type: "model-info-received",
                    message: "Model information updated successfully",
                  });
                }
                break;

              case "text-input":
                if (state.isAuthenticated) {
                  await handleTextInput(state, message);
                } else {
                  sendMessage({
                    type: "error",
                    message: "Authentication required for text input",
                  });
                }
                break;

              case "interrupt":
                if (state.isAuthenticated) {
                  handleInterrupt(state);
                }
                break;

              case "connection-test":
                sendMessage({
                  type: "connection-test-response",
                  message: "Connection is working properly",
                  client_id: clientId,
                  connection_stats: {
                    messages_processed: state.messageCount,
                    connected_duration:
                      Date.now() - state.connectedAt.getTime(),
                    last_activity: state.lastActivity,
                  },
                });
                break;

              default:
                logger.warn(
                  "WebSocket",
                  `Unknown message type: ${message.type} from ${clientId}`
                );
                sendMessage({
                  type: "error",
                  message: `Unknown message type: ${message.type}`,
                });
            }
          } catch (error) {
            logger.error(
              "WebSocket",
              `Error processing message from ${clientId}: ${error.message}`
            );
            sendMessage({
              type: "error",
              message: "Failed to process message",
            });
          } finally {
            const state = getConnectionState(clientId);
            if (state) {
              state.processingMessage = false;
            }
          }
        });

        // Text input handler
        async function handleTextInput(connectionState, message) {
          const { user } = connectionState;

          if (!message.text || !message.text.trim()) {
            sendMessage({
              type: "error",
              message: "Empty text input received",
            });
            return;
          }

          const responseId = `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          connectionState.currentResponseId = responseId;

          try {
            sendMessage({
              type: "response-queued",
              response_id: responseId,
            });

            // FIXED: Apply alternateSpell replacements for vocal inputs
            let processedText = await applyAlternateSpelling(
              message.text,
              user.user_id
            );

            logger.log(
              "WebSocket",
              `Processing text input for user ${user.user_id}: "${processedText.substring(0, 50)}..."`
            );

            // FIXED: Enhanced chat response with better error handling and logging
            const chatResponse = await aiHelper.respondToChat(
              {
                message: processedText,
                user: user.user_name || "User",
              },
              user.user_id
            );

            // FIXED: Better error handling and response validation
            if (!chatResponse) {
              logger.error(
                "WebSocket",
                `No response object returned for user ${user.user_id}`
              );
              throw new Error("No response generated from AI system");
            }

            if (!chatResponse.success) {
              logger.error(
                "WebSocket",
                `AI response failed for user ${user.user_id}: ${chatResponse.error}`
              );
              throw new Error(
                chatResponse.error || "Failed to generate response"
              );
            }

            if (!chatResponse.text || chatResponse.text.trim() === "") {
              logger.error(
                "WebSocket",
                `Empty response text for user ${user.user_id}`
              );
              throw new Error("AI generated empty response");
            }

            // FIXED: Send the text response immediately
            sendMessage({
              type: "full-text",
              text: chatResponse.text,
              response_id: responseId,
            });

            logger.log(
              "WebSocket",
              `Text response sent for user ${user.user_id}: "${chatResponse.text.substring(0, 50)}..."`
            );

            // FIXED: Enhanced TTS generation with better error handling
            if (user.tts_enabled) {
              await generateAndSendAudio(
                connectionState,
                chatResponse.text,
                responseId
              );
            } else {
              logger.log(
                "WebSocket",
                `TTS disabled for user ${user.user_id}, skipping audio generation`
              );
              // Still mark the response as complete
              sendMessage({
                type: "synthesis-complete",
                response_id: responseId,
              });
            }

            logger.log(
              "WebSocket",
              `Response completed successfully for user ${user.user_id} (${clientId})`
            );
          } catch (error) {
            logger.error(
              "WebSocket",
              `Error processing text input for ${clientId}: ${error.message}`
            );

            // FIXED: Send proper error response
            sendMessage({
              type: "error",
              message: "Failed to generate response: " + error.message,
              response_id: responseId,
            });

            // Reset AI state if this was set
            connectionState.currentResponseId = null;
          }
        }

        /**
         * FIXED: Apply alternate spelling replacements for vocal inputs
         * @param {string} text - The original text from speech recognition
         * @param {string} userId - User ID for getting alternate spellings
         * @returns {Promise<string>} - Text with alternate spellings replaced
         */
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
              // No alternate spellings configured, return original text
              return text;
            }

            let processedText = text;

            // Apply each alternate spelling replacement
            for (const alternateEntry of userObj.alternateSpell) {
              if (typeof alternateEntry === "string") {
                // Simple string replacement - replace with bot name
                const regex = new RegExp(
                  `\\b${escapeRegExp(alternateEntry)}\\b`,
                  "gi"
                );
                processedText = processedText.replace(regex, userObj.bot_name);

                logger.log(
                  "WebSocket",
                  `Replaced "${alternateEntry}" with "${userObj.bot_name}" in vocal input`
                );
              } else if (
                typeof alternateEntry === "object" &&
                alternateEntry.from &&
                alternateEntry.to
              ) {
                // Object with from/to mapping
                const regex = new RegExp(
                  `\\b${escapeRegExp(alternateEntry.from)}\\b`,
                  "gi"
                );
                processedText = processedText.replace(regex, alternateEntry.to);

                logger.log(
                  "WebSocket",
                  `Replaced "${alternateEntry.from}" with "${alternateEntry.to}" in vocal input`
                );
              }
            }

            return processedText;
          } catch (error) {
            logger.error(
              "WebSocket",
              `Error applying alternate spelling: ${error.message}`
            );
            return text; // Return original text if replacement fails
          }
        }

        /**
         * Escape special regex characters
         * @param {string} string - String to escape
         * @returns {string} - Escaped string
         */
        function escapeRegExp(string) {
          return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }

        // Audio generation
        async function generateAndSendAudio(connectionState, text, responseId) {
          const { user, modelInfo } = connectionState;

          try {
            sendMessage({
              type: "synthesis-started",
              response_id: responseId,
            });

            logger.log(
              "WebSocket",
              `Generating TTS audio for user ${user.user_id} (${clientId})`
            );

            const audioResult = await aiHelper.respondWithVoice(
              text,
              user.user_id
            );

            if (audioResult.error) {
              throw new Error(audioResult.error);
            }

            // FIXED: Send audio URL directly instead of converting to base64
            sendMessage({
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
              actions.expressions = selectExpressions(
                text,
                modelInfo.expressions
              );
            }

            // UPDATED: Send audio URL instead of base64 data
            sendMessage({
              type: "audio-url", // Changed message type to indicate URL format
              audio_url: audioResult, // Direct URL instead of base64
              display_text: displayText,
              actions: Object.keys(actions).length > 0 ? actions : undefined,
              response_id: responseId,
              audio_format: "wav", // Additional metadata for client
              sample_rate: 22050, // TTS output format info
              bit_depth: 16, // TTS output format info
            });

            logger.log(
              "WebSocket",
              `Audio URL sent for user ${user.user_id} (${clientId}): ${audioResult}`
            );
          } catch (error) {
            logger.error(
              "WebSocket",
              `Error generating audio for ${user.user_id} (${clientId}): ${error.message}`
            );
            sendMessage({
              type: "error",
              message: "Failed to generate audio response",
              response_id: responseId,
              error_details: error.message,
            });
          }
        }

        function handleInterrupt(connectionState) {
          const { user } = connectionState;
          logger.log(
            "WebSocket",
            `Interrupt received from user ${user?.user_id || "unknown"} (${clientId})`
          );
          connectionState.currentResponseId = null;
          sendMessage({
            type: "interrupt",
            message: "Response interrupted",
          });
        }

        // FIXED: Connection close handler using direct socket API
        socket.on("close", (code, reason) => {
          logger.log(
            "WebSocket",
            `Client ${clientId} disconnected: ${code} - ${reason || "no reason"}`
          );
          cleanupConnection(`close_${code}`);
        });

        // FIXED: Error handler using direct socket API
        socket.on("error", (error) => {
          logger.error(
            "WebSocket",
            `Socket error for ${clientId}: ${error.message}`
          );
          cleanupConnection(`error_${error.message}`);
        });

        // Send initial messages with proper timing
        setTimeout(() => {
          const state = getConnectionState(clientId);
          if (!state) {
            logger.error(
              "WebSocket",
              `Connection ${clientId} not available for initial messages`
            );
            return;
          }

          if (!validateSocket(state.socket, clientId)) {
            logger.error(
              "WebSocket",
              `Socket invalid for initial messages ${clientId}`
            );
            cleanupConnection("invalid_socket_initial");
            return;
          }

          const establishmentSuccess = sendMessage({
            type: "connection-established",
            client_id: clientId,
            server_time: new Date().toISOString(),
            server_info: {
              version: "1.0.0",
              capabilities: ["text-input", "model-info", "audio", "interrupt"],
            },
          });

          if (establishmentSuccess) {
            setTimeout(() => {
              const currentState = getConnectionState(clientId);
              if (
                currentState &&
                validateSocket(currentState.socket, clientId)
              ) {
                sendMessage({
                  type: "auth-required",
                  message: "Please provide authentication token",
                });
              }
            }, 200);
          }
        }, 300);

        logger.log(
          "WebSocket",
          `Client ${clientId} setup completed successfully`
        );
      }
    );
  });

  // Enhanced status endpoint
  fastify.get("/ws-status", async (request, reply) => {
    const connections = Array.from(activeConnections.values()).map((conn) => ({
      id: conn.id,
      authenticated: conn.isAuthenticated,
      user_id: conn.user?.user_id || null,
      connected_at: conn.connectedAt,
      socket_state:
        conn.socket?.readyState !== undefined
          ? conn.socket.readyState
          : "unknown",
      is_destroyed: conn.isDestroyed,
      processing_message: conn.processingMessage,
      send_in_progress: conn.sendInProgress,
      message_count: conn.messageCount,
      last_activity: conn.lastActivity,
      connection_ip: conn.connectionIP,
      auth_attempts: conn.authAttempts,
    }));

    return {
      websocket_enabled: true,
      active_connections: activeConnections.size,
      cleanup_queue_size: connectionCleanupQueue.size,
      connections: connections,
      system_info: {
        uptime: process.uptime(),
        memory_usage: process.memoryUsage(),
        timestamp: new Date().toISOString(),
      },
    };
  });

  logger.log(
    "WebSocket",
    "Fixed VTuber WebSocket route registered at /ws-client"
  );

  /**
   * Expression selection utility
   */
  function selectExpressions(text, availableExpressions) {
    const emotionKeywords = {
      happy: [
        "happy",
        "joy",
        "excited",
        "great",
        "awesome",
        "wonderful",
        "amazing",
        "!",
        "😊",
        "😄",
      ],
      sad: [
        "sad",
        "sorry",
        "disappointed",
        "unfortunate",
        "regret",
        "😢",
        "😞",
      ],
      surprised: [
        "wow",
        "amazing",
        "incredible",
        "unbelievable",
        "surprise",
        "!",
        "😮",
        "😲",
      ],
      angry: ["angry", "frustrated", "annoyed", "mad", "irritated", "😠", "😡"],
      neutral: ["hello", "hi", "okay", "alright", "yes", "no", "maybe"],
    };

    const textLower = text.toLowerCase();
    let detectedEmotion = "neutral";
    let maxMatches = 0;

    for (const [emotion, keywords] of Object.entries(emotionKeywords)) {
      const matches = keywords.filter((keyword) =>
        textLower.includes(keyword)
      ).length;
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

    const possibleExpressions =
      expressionMapping[detectedEmotion] || expressionMapping.neutral;
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

  logger.log("WebSocket", "VTuber WebSocket route registered at /ws-client");

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

/**
 * Preflight checks
 */
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

/**
 * Server launch
 */
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

/**
 * Application initialization
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
      "VTuber WebSocket integration is active and ready for connections!"
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
