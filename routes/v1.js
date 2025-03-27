import * as aiHelper from "../ai-logic.js";
import {
  containsCharacterName,
  containsAuxBotName
} from "../prompt-helper.js";
import { checkForAuth, updateUserParameter, returnAuthObject } from "../api-helper.js";
import { maintainVoiceContext } from "../data-helper.js";
import * as twitchHelper from "../twitch-helper.js";
import { retrieveConfigValue } from "../config-helper.js";
import moment from "moment";
import fastifyFormbody from "@fastify/formbody";
import cors from "@fastify/cors";
import fastifyCompress from "@fastify/compress";
import fs from 'fs-extra'
import * as crypto from 'crypto'
import fastifyCookie from '@fastify/cookie';

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

const requireAuth = async (request, reply) => {
  const sessionToken = request.cookies.enspira_session;
  
  if (!sessionToken) {
    return reply.redirect('/v1/auth/login');
  }
  
  try {
    // Verify and decode the session token
    const decoded = verifySessionToken(sessionToken);
    
    if (!decoded || !decoded.userId) {
      // Invalid token
      reply.clearCookie('enspira_session');
      return reply.redirect('/v1/auth/login');
    }
    
    // Get user from database
    const user = await returnAuthObject(decoded.userId);
    
    if (!user) {
      // User doesn't exist
      reply.clearCookie('enspira_session');
      return reply.redirect('/v1/auth/login');
    }
    
    // Add user to request for use in route handlers
    request.user = user;
    
    // Continue to route handler
    return;
  } catch (error) {
    logger.error("Auth", `Session validation error: ${error.message}`);
    reply.clearCookie('enspira_session');
    return reply.redirect('/v1/auth/login');
  }
};

function createSessionToken(userId, expiresIn = '7d') {
  // Create a token payload
  const payload = {
    userId,
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7) // 7 days
  };
  
  // Sign the token
  const token = crypto.createHmac('sha256', process.env.COOKIE_SECRET || 'enspira-secret-key')
    .update(JSON.stringify(payload))
    .digest('hex');
  
  // Return token and payload together
  return `${token}.${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
}

// Function to verify a session token
function verifySessionToken(token) {
  try {
    const [signature, payloadBase64] = token.split('.');
    
    // Decode the payload
    const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString());
    
    // Check if token is expired
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    
    // Verify the signature
    const expectedSignature = crypto.createHmac('sha256', process.env.COOKIE_SECRET || 'enspira-secret-key')
      .update(JSON.stringify(payload))
      .digest('hex');
    
    if (signature !== expectedSignature) {
      return null;
    }
    
    return payload;
  } catch (error) {
    logger.error("Auth", `Token verification error: ${error.message}`);
    return null;
  }
}

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

  await fastify.register(import("@fastify/rate-limit"), {
    max: 100,
    timeWindow: "20 seconds",
  });
  await fastify.register(fastifyCookie, {
    secret: await retrieveConfigValue("server.cookieSecret") || crypto.randomBytes(32).toString('hex'), // Use a stored secret or generate one
    parseOptions: {}
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
        authObject.user_name,
        authObject.user_id,
      );
      logger.log(
        "API",
        `${authObject.user_name} sent a voice message: ${data.message}`,
      );

      if (finalResp.response !== "") {
        const voiceData = await aiHelper.respondToDirectVoice(
          data.message,
          authObject.user_id,
        );
        const summaryString = `On ${formattedDate} ${authObject.user_name} said to you: "${data.message}". You responded to them by saying: ${voiceData.response}`;
        await maintainVoiceContext(summaryString);
        await aiHelper.addVoiceMessageAsVector(
          summaryString,
          data.message,
          authObject.user_name,
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
      } else if (!fromBot && isCharMessage) {
      }
      const user = (await twitchHelper.checkForUser(
        data.user,
        authObject.user_id,
      ))
        ? `${authObject.user_name}`
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
        response.send({ response: "OK" });
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
    return response;
  });

  fastify.get("/", async (request, response) => {
    logger.log("API", `Request hit root (by accident?) from ${request.ip}`)
    response.code(200).send({ error: "Please specify an endpoint before sending a request.", ...endPointDoc })
  })
  fastify.setErrorHandler((error, request, reply) => {
    if (error && error.code === 'FST_ERR_ROUTE_METHOD_NOT_SUPPORTED') {
      reply.code(405).send({
        error: "Method Not Allowed",
        message: `HTTP method "${request.method}" is not supported for this route.`,
        allowedMethods: reply.context.config.allowedMethods
      });
      return reply;
    } else {
      reply.send(error);
      return reply;
    }
  });

  fastify.get('/auth/login', async (request, reply) => {
    const loginForm = `<!doctype html>
    <html>
      <head>
        <title>Enspira Login</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 500px;
            margin: 0 auto;
            padding: 20px;
          }
          .form-group {
            margin-bottom: 15px;
          }
          label {
            display: block;
            margin-bottom: 5px;
          }
          input[type="text"],
          input[type="password"] {
            width: 100%;
            padding: 8px;
          }
          button {
            background: #6441a4;
            color: white;
            border: none;
            padding: 10px 15px;
            cursor: pointer;
          }
          .error {
            color: #e74c3c;
            margin-bottom: 15px;
          }
        </style>
      </head>
      <body>
        <h2>Enspira Login</h2>
        ${request.query.error ? `<div class="error">${request.query.error}</div>` : ''}
        
        <form action="/api/v1/auth/login" method="POST">
          <div class="form-group">
            <label for="user_id">User ID:</label>
            <input type="text" id="user_id" name="user_id" required />
          </div>
          <div class="form-group">
            <label for="password">Password:</label>
            <input type="password" id="password" name="password" required />
          </div>
          <button type="submit">Login</button>
        </form>
      </body>
    </html>`;
    
    reply.type('text/html').send(loginForm);
    return reply;
  });
  
  // Login POST handler
  fastify.post('/auth/login', async (request, reply) => {
    try {
      const { user_id, password } = request.body;
      
      if (!user_id || !password) {
        return reply.redirect('/v1/auth/login?error=Missing+required+fields');
      }
      
      // Get user
      const user = await returnAuthObject(user_id);
      
      if (!user) {
        return reply.redirect('/v1/auth/login?error=Invalid+credentials');
      }
      
      // Check password
      if (!user.webPasswordHash || !user.webPasswordSalt) {
        return reply.redirect('/v1/auth/login?error=No+password+set');
      }
      
      const passwordCorrect = await isPasswordCorrect(
        user.webPasswordHash,
        user.webPasswordSalt,
        user.webPasswordIterations || 20480,
        password
      );
      
      if (!passwordCorrect) {
        return reply.redirect('/v1/auth/login?error=Invalid+credentials');
      }
      
      // Create session
      const sessionToken = createSessionToken(user_id);
      
      // Set cookie
      reply.setCookie('enspira_session', sessionToken, {
        path: '/',
        httpOnly: true, // Prevents JavaScript access
        secure: process.env.NODE_ENV === 'production', // Use secure in production
        sameSite: 'lax', // Protects against CSRF
        maxAge: 60 * 60 * 24 * 7 // 7 days
      });
      
      // Redirect to dashboard or Twitch management
      return reply.redirect('/v1/auth/twitch/manage');
    } catch (error) {
      logger.error("Auth", `Login error: ${error.message}`);
      return reply.redirect('/v1/auth/login?error=An+error+occurred');
    }
  });
  
  // Logout route
  fastify.get('/auth/logout', async (request, reply) => {
    reply.clearCookie('enspira_session');
    return reply.redirect('/v1/auth/login');
  });
  
  // Twitch management dashboard
  fastify.get('/auth/twitch/manage', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const user = request.user;
      
      // Format date for display
      const formatDate = (timestamp) => {
        if (!timestamp) return 'Never';
        return new Date(timestamp).toLocaleString();
      };
      
      // Check bot connection
      const botConnected = user.twitch_tokens?.bot?.access_token ? true : false;
      
      // Check streamer connection
      const streamerConnected = user.twitch_tokens?.streamer?.access_token ? true : false;
      
      // Get scopes from config
      const streamerScopes = await retrieveConfigValue("twitch.scopes.streamer");
      const botScopes = await retrieveConfigValue("twitch.scopes.bot");
      
      // Build the HTML
      const html = `<!doctype html>
      <html>
        <head>
          <title>Twitch Integration - ${user.user_name}</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              max-width: 800px;
              margin: 0 auto;
              padding: 20px;
              line-height: 1.6;
            }
            .container {
              background: #f9f9f9;
              border-radius: 8px;
              padding: 20px;
              margin-bottom: 20px;
              border: 1px solid #eee;
            }
            .header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              border-bottom: 2px solid #6441a4;
              padding-bottom: 10px;
              margin-bottom: 20px;
            }
            .account-status {
              display: flex;
              margin-bottom: 15px;
            }
            .status-icon {
              width: 24px;
              height: 24px;
              margin-right: 10px;
            }
            .connected {
              color: #2ecc71;
              font-weight: bold;
            }
            .not-connected {
              color: #e74c3c;
            }
            .button {
              display: inline-block;
              background: #6441a4;
              color: white;
              padding: 10px 15px;
              border-radius: 4px;
              text-decoration: none;
              margin-top: 10px;
              transition: background 0.3s;
            }
            .button:hover {
              background: #7d5bbe;
            }
            .logout {
              color: #e74c3c;
              text-decoration: none;
            }
            .scopes {
              font-size: 0.9em;
              margin-top: 10px;
              color: #666;
            }
            .scope-list {
              display: flex;
              flex-wrap: wrap;
              margin-top: 5px;
            }
            .scope {
              background: #f1f1f1;
              padding: 3px 8px;
              border-radius: 12px;
              margin-right: 5px;
              margin-bottom: 5px;
              font-size: 0.85em;
            }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>Twitch Integration</h1>
            <div>
              <span>Logged in as ${user.user_name}</span> | 
              <a href="/api/v1/auth/logout" class="logout">Logout</a>
            </div>
          </div>
  
          <div class="container">
            <h2>Streamer Account</h2>
            <div class="account-status">
              ${streamerConnected ? 
                `<svg class="status-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#2ecc71">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
                </svg>
                <div>
                  <p class="connected">Connected as: ${user.twitch_tokens.streamer.twitch_display_name}</p>
                  <p>Last authenticated: ${formatDate(user.twitch_tokens.streamer.expires_at)}</p>
                </div>` : 
                `<svg class="status-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#e74c3c">
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/>
                </svg>
                <div>
                  <p class="not-connected">No streamer account connected</p>
                </div>`
              }
            </div>
            
            <p>The streamer account allows Enspira to access your channel information, manage raids, read subscriptions, and more.</p>
            
            <div class="scopes">
              <p>Permissions required:</p>
              <div class="scope-list">
                ${Array.isArray(streamerScopes) ? 
                  streamerScopes.map(scope => `<span class="scope">${scope}</span>`).join('') : 
                  (typeof streamerScopes === 'string' ? 
                    streamerScopes.split(' ').map(scope => `<span class="scope">${scope}</span>`).join('') : 
                    '')
                }
              </div>
            </div>
            
            <a href="/api/v1/auth/twitch/connect?type=streamer" class="button">
              ${streamerConnected ? 'Reconnect Streamer Account' : 'Connect Streamer Account'}
            </a>
          </div>
  
          <div class="container">
            <h2>Bot Account</h2>
            <div class="account-status">
              ${botConnected ? 
                `<svg class="status-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#2ecc71">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
                </svg>
                <div>
                  <p class="connected">Connected as: ${user.twitch_tokens.bot.twitch_display_name}</p>
                  <p>Last authenticated: ${formatDate(user.twitch_tokens.bot.expires_at)}</p>
                </div>` : 
                `<svg class="status-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#e74c3c">
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/>
                </svg>
                <div>
                  <p class="not-connected">No bot account connected</p>
                </div>`
              }
            </div>
            
            <p>The bot account allows Enspira to send chat messages, read chat, create clips, and more. This should be the Twitch account that will act as your AI assistant in chat.</p>
            
            <div class="scopes">
              <p>Permissions required:</p>
              <div class="scope-list">
                ${Array.isArray(botScopes) ? 
                  botScopes.map(scope => `<span class="scope">${scope}</span>`).join('') : 
                  (typeof botScopes === 'string' ? 
                    botScopes.split(' ').map(scope => `<span class="scope">${scope}</span>`).join('') : 
                    '')
                }
              </div>
            </div>
            
            <a href="/api/v1/auth/twitch/connect?type=bot" class="button">
              ${botConnected ? 'Reconnect Bot Account' : 'Connect Bot Account'}
            </a>
          </div>
  
          <div class="container">
            <h2>What's Next?</h2>
            <p>With your accounts connected, Enspira can now:</p>
            <ul>
              <li>Respond to channel events (follows, subscriptions, etc.)</li>
              <li>Send chat messages as your bot</li>
              <li>Track channel statistics</li>
              <li>Create clips and shoutouts</li>
            </ul>
          </div>
        </body>
      </html>`;
      
      reply.type('text/html').send(html);
      return reply;
    } catch (error) {
      logger.error("Auth", `Error in Twitch management: ${error.message}`);
      return reply.code(500).send("An error occurred loading the Twitch management page");
    }
  });

  fastify.get('/auth/twitch/login', async (request, reply) => {
    // Simple HTML form with user_id and password fields
    const loginForm = await fs.readFile('./pages/twitch-login.html', 'utf-8');

    // Add auth type as a hidden field if provided
    const authType = request.query.type || '';
    const loginFormWithType = loginForm.replace(
      '<form action="/api/v1/auth/twitch/authenticate" method="POST">',
      `<form action="/api/v1/auth/twitch/authenticate" method="POST">
        <input type="hidden" name="auth_type" value="${authType}">`
    );

    reply.type('text/html').send(loginFormWithType);
    return reply;
  });

  fastify.get('/auth/twitch/connect', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { type } = request.query;
      const user = request.user;
      
      if (!type || (type !== 'bot' && type !== 'streamer')) {
        return reply.code(400).send({ error: 'Invalid account type' });
      }
      
      // Generate auth token and store it temporarily
      const authToken = crypto.randomBytes(32).toString('hex');
  
      global.pendingTwitchAuths = global.pendingTwitchAuths || new Map();
      global.pendingTwitchAuths.set(authToken, {
        userId: user.user_id,
        createdAt: Date.now(),
        authType: type
      });
  
      // Get the scopes based on auth type
      const scopeType = type;
      let scopeValue;
      
      try {
        // Get the scopes from config
        const configScopes = await retrieveConfigValue(`twitch.scopes.${scopeType}`);
  
        // Handle different possible formats
        if (Array.isArray(configScopes)) {
          scopeValue = configScopes.join(' ');
        } else if (typeof configScopes === 'string') {
          scopeValue = configScopes;
        } else if (configScopes === null || configScopes === undefined) {
          if (scopeType === 'bot') {
            scopeValue = 'chat:read chat:edit user:read:email';
          } else {
            scopeValue = 'channel:read:broadcast channel:read:subscriptions channel:read:hype_train channel:read:follows';
          }
          logger.log("Auth", `No twitch.scopes.${scopeType} found in config, using defaults`);
        } else {
          scopeValue = String(configScopes);
          logger.log("Auth", `Unexpected type for twitch.scopes.${scopeType}: ${typeof configScopes}. Converting to string.`);
        }
      } catch (error) {
        logger.error("Auth", `Error getting Twitch scopes: ${error.message}. Using defaults.`);
        if (scopeType === 'bot') {
          scopeValue = 'chat:read chat:edit user:read:email';
        } else {
          scopeValue = 'channel:read:broadcast channel:read:subscriptions channel:read:hype_train channel:read:follows';
        }
      }
  
      // Create the Twitch OAuth URL
      const authUrl = new URL('https://id.twitch.tv/oauth2/authorize');
      authUrl.searchParams.set('client_id', await retrieveConfigValue("twitch.clientId"));
      authUrl.searchParams.set('redirect_uri', await retrieveConfigValue("twitch.redirectUri"));
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', scopeValue);
      authUrl.searchParams.set('state', authToken);
      
      // Force login prompt if connecting a bot account
      if (type === 'bot') {
        authUrl.searchParams.set('force_verify', 'true');
      }
  
      return reply.redirect(authUrl.toString());
    } catch (error) {
      logger.error("Auth", `Error in Twitch connect: ${error.message}`);
      return reply.code(500).send({ error: 'An error occurred' });
    }
  });

  // 2. Authentication endpoint that verifies credentials
  fastify.post('/auth/twitch/authenticate', async (request, reply) => {
    try {
      // 1. Validate request body
      if (!request.body || typeof request.body !== 'object') {
        return reply.code(400).send({ error: 'Invalid request format' });
      }

      const { user_id, password, auth_type } = request.body;

      // 2. Check for required fields
      if (!user_id || !password) {
        return reply.code(400).send({ error: 'Missing required fields' });
      }

      // Log the auth_type to debug
      logger.log("Auth", `Authenticating user: ${user_id} for ${auth_type || 'streamer'} account`);

      // 4. Get user details
      const user = await returnAuthObject(user_id);

      if (!user) {
        return reply.code(401).send({ error: 'User not found' });
      }

      // 5. Check if password hash and salt exist
      if (!user.webPasswordHash || !user.webPasswordSalt) {
        logger.log("Auth", `User ${user_id} has no password set`);
        return reply.code(401).send({
          error: 'No password set for this account',
          setupRequired: true
        });
      }

      // 6. Validate parameters for isPasswordCorrect
      const iterations = user.webPasswordIterations || 20480;

      logger.log("Auth", `Verifying password with hash=${user.webPasswordHash ? 'exists' : 'missing'}, salt=${user.webPasswordSalt ? 'exists' : 'missing'}`);

      // 7. Verify password with explicit parameter validation
      const passwordCorrect = await isPasswordCorrect(
        user.webPasswordHash,
        user.webPasswordSalt,
        iterations,
        password
      );

      if (!passwordCorrect) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      // Generate auth token and store it temporarily
      const authToken = crypto.randomBytes(32).toString('hex');

      global.pendingTwitchAuths = global.pendingTwitchAuths || new Map();
      global.pendingTwitchAuths.set(authToken, {
        userId: user_id,
        createdAt: Date.now(),
        authType: auth_type || 'streamer' // Default to streamer if not specified
      });

      // Get the scopes based on auth type (bot or streamer)
      const scopeType = auth_type === 'bot' ? 'bot' : 'streamer';
      let scopeValue;

      try {
        // Get the scopes from config
        const configScopes = await retrieveConfigValue(`twitch.scopes.${scopeType}`);

        // Handle different possible formats
        if (Array.isArray(configScopes)) {
          // If it's already an array, just join it
          scopeValue = configScopes.join(' ');
        } else if (typeof configScopes === 'string') {
          // If it's a single string, use it directly
          scopeValue = configScopes;
        } else if (configScopes === null || configScopes === undefined) {
          // If not configured, use default scopes based on type
          if (scopeType === 'bot') {
            scopeValue = 'chat:read chat:edit user:read:email';
          } else {
            scopeValue = 'channel:read:broadcast channel:read:subscriptions channel:read:hype_train channel:read:follows';
          }
          logger.log("Auth", `No twitch.scopes.${scopeType} found in config, using defaults`);
        } else {
          // Unexpected type, convert to string
          scopeValue = String(configScopes);
          logger.log("Auth", `Unexpected type for twitch.scopes.${scopeType}: ${typeof configScopes}. Converting to string.`);
        }
      } catch (error) {
        // Fallback to default scopes if there's an error
        logger.error("Auth", `Error getting Twitch scopes: ${error.message}. Using defaults.`);
        if (scopeType === 'bot') {
          scopeValue = 'chat:read chat:edit user:read:email';
        } else {
          scopeValue = 'channel:read:broadcast channel:read:subscriptions channel:read:hype_train channel:read:follows';
        }
      }

      // Now use scopeValue in the URL
      const authUrl = new URL('https://id.twitch.tv/oauth2/authorize');
      authUrl.searchParams.set('client_id', await retrieveConfigValue("twitch.clientId"));
      authUrl.searchParams.set('redirect_uri', await retrieveConfigValue("twitch.redirectUri"));
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', scopeValue);
      authUrl.searchParams.set('state', authToken);
      if (auth_type === 'bot') {
        authUrl.searchParams.set('force_verify', 'true');
      }
      return reply.redirect(authUrl.toString());
    } catch (error) {
      logger.error("Auth", `Error during Twitch authentication: ${error.message}`);
      return reply.code(500).send({ error: 'Authentication error', details: error.message });
    }
  });

  // 3. Callback from Twitch OAuth
  fastify.get('/auth/twitch/callback', async (request, reply) => {
    const { code, state } = request.query;
  
    // Verify state token exists in our pending auths
    if (!global.pendingTwitchAuths || !global.pendingTwitchAuths.has(state)) {
      return reply.code(400).send('Invalid or expired authorization request');
    }
  
    // Get user ID from the stored mapping
    const { userId, createdAt, authType } = global.pendingTwitchAuths.get(state);
  
    // Check if the token has expired (e.g., after 10 minutes)
    if (Date.now() - createdAt > 10 * 60 * 1000) {
      global.pendingTwitchAuths.delete(state);
      return reply.code(400).send('Authorization request expired');
    }
  
    try {
      const axios = (await import('axios')).default;
      // Exchange code for access token
      const tokenResponse = await axios.post('https://id.twitch.tv/oauth2/token', {
        client_id: await retrieveConfigValue("twitch.clientId"),
        client_secret: await retrieveConfigValue("twitch.clientSecret"),
        code,
        grant_type: 'authorization_code',
        redirect_uri: await retrieveConfigValue("twitch.redirectUri")
      });
  
      const { access_token, refresh_token, expires_in } = tokenResponse.data;
  
      // Get user info from Twitch
      const userResponse = await axios.get('https://api.twitch.tv/helix/users', {
        headers: {
          'Client-ID': await retrieveConfigValue("twitch.clientId"),
          'Authorization': `Bearer ${access_token}`
        }
      });
      
      const twitchUserInfo = userResponse.data.data[0];
      
      // Store tokens in user record - use the appropriate field based on auth type
      const tokenPath = authType === 'bot' ? "twitch_tokens.bot" : "twitch_tokens.streamer";
      
      await updateUserParameter(userId, tokenPath, {
        access_token,
        refresh_token,
        expires_at: Date.now() + (expires_in * 1000),
        twitch_user_id: twitchUserInfo.id,
        twitch_login: twitchUserInfo.login,
        twitch_display_name: twitchUserInfo.display_name
      });
  
      // Clean up the pending auth
      global.pendingTwitchAuths.delete(state);
      
      // Redirect back to the management page
      return reply.redirect('/v1/auth/twitch/manage');
    } catch (error) {
      logger.log("Auth", `Error during Twitch token exchange: ${error.message}`);
      return reply.code(500).send('Failed to complete Twitch authorization');
    }
  });

  fastify.get('/auth/twitch/status', async (request, reply) => {
    const { userId } = request.query;

    if (!userId) {
      return reply.code(400).send('Missing user ID');
    }

    try {
      const user = await returnAuthObject(userId);

      if (!user) {
        return reply.code(404).send('User not found');
      }

      // Get templates
      const statusTemplate = await fs.readFile('./pages/twitch-status.html', 'utf-8');

      // Format date for display
      const formatDate = (timestamp) => {
        if (!timestamp) return 'Never';
        return new Date(timestamp).toLocaleString();
      };

      // Check bot connection
      const botConnected = user.twitch_tokens?.bot?.access_token ? true : false;

      // Check streamer connection
      const streamerConnected = user.twitch_tokens?.streamer?.access_token ? true : false;

      // Get scopes from config
      const streamerScopes = await retrieveConfigValue("twitch.scopes.streamer");
      const botScopes = await retrieveConfigValue("twitch.scopes.bot");

      // Build template data
      const templateData = {
        username: user.user_name,

        botConnected,
        botName: user.twitch_tokens?.bot?.twitch_display_name || '',
        botDate: formatDate(user.twitch_tokens?.bot?.expires_at),
        botScopes: Array.isArray(botScopes) ? botScopes : (typeof botScopes === 'string' ? botScopes.split(' ') : []),

        streamerConnected,
        streamerName: user.twitch_tokens?.streamer?.twitch_display_name || '',
        streamerDate: formatDate(user.twitch_tokens?.streamer?.expires_at),
        streamerScopes: Array.isArray(streamerScopes) ? streamerScopes : (typeof streamerScopes === 'string' ? streamerScopes.split(' ') : []),
      };

      // Simple template rendering (in a real app, use a proper template engine)
      let renderedTemplate = statusTemplate;

      // Replace conditionals
      renderedTemplate = renderedTemplate
        .replace(/\{\{#if botConnected\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g,
          botConnected ? '$1' : '$2')
        .replace(/\{\{#if streamerConnected\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g,
          streamerConnected ? '$1' : '$2');

      // Replace variables
      for (const [key, value] of Object.entries(templateData)) {
        if (typeof value === 'string' || typeof value === 'number') {
          renderedTemplate = renderedTemplate.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
        }
      }

      // Handle scope arrays
      renderedTemplate = renderedTemplate
        .replace(/\{\{#each botScopes\}\}([\s\S]*?)\{\{\/each\}\}/g,
          templateData.botScopes.map(scope => {
            return `<span class="scope">${scope}</span>`;
          }).join('\n'))
        .replace(/\{\{#each streamerScopes\}\}([\s\S]*?)\{\{\/each\}\}/g,
          templateData.streamerScopes.map(scope => {
            return `<span class="scope">${scope}</span>`;
          }).join('\n'));

      // Fix return to dashboard button to point to the right location
      renderedTemplate = renderedTemplate.replace(
        '<a href="/" class="button">Return to Dashboard</a>',
        '<a href="/api/v1/auth/twitch/login" class="button">Return to Login</a>'
      );

      // Fix links in the status page to use /api/v1 for HTML pages
      renderedTemplate = renderedTemplate.replace(
        'href="/v1/auth/twitch/login?type=bot"',
        'href="/api/v1/auth/twitch/login?type=bot"'
      );

      renderedTemplate = renderedTemplate.replace(
        'href="/v1/auth/twitch/login?type=streamer"',
        'href="/api/v1/auth/twitch/login?type=streamer"'
      );

      reply.type('text/html').send(renderedTemplate);
      return reply;

    } catch (error) {
      logger.error("Auth", `Error showing Twitch status: ${error.message}`);
      return reply.code(500).send('Error loading Twitch status');
    }
  });
}

export async function refreshTwitchToken(userId, tokenType = 'streamer') {
  try {
    const user = await returnAuthObject(userId);

    // Validate token type
    if (tokenType !== 'bot' && tokenType !== 'streamer') {
      logger.log("Twitch", `Invalid token type: ${tokenType}`);
      return false;
    }

    // Get the tokens for the specified type
    const tokens = user.twitch_tokens?.[tokenType];

    if (!tokens || !tokens.refresh_token) {
      logger.log("Twitch", `No refresh token found for ${tokenType} account of user ${userId}`);
      return false;
    }

    // Check if token is expired or close to expiring (within 10 minutes)
    const isExpired = !tokens.expires_at ||
      Date.now() > (tokens.expires_at - (10 * 60 * 1000));

    if (!isExpired) {
      return tokens.access_token; // Return existing token if still valid
    }

    // Import axios if needed
    const axios = (await import('axios')).default;

    // Refresh the token
    const response = await axios.post('https://id.twitch.tv/oauth2/token', {
      client_id: await retrieveConfigValue("twitch.clientId"),
      client_secret: await retrieveConfigValue("twitch.clientSecret"),
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token
    });

    const { access_token, refresh_token, expires_in } = response.data;

    // Update token in user record
    await updateUserParameter(userId, `twitch_tokens.${tokenType}`, {
      ...tokens, // Keep existing data like user_id
      access_token,
      refresh_token,
      expires_at: Date.now() + (expires_in * 1000)
    });

    logger.log("Twitch", `Refreshed ${tokenType} token for user ${userId}`);
    return access_token;
  } catch (error) {
    logger.log("Twitch", `Failed to refresh ${tokenType} token: ${error.message}`);

    // If refresh fails, clear token data to force re-authentication
    await updateUserParameter(userId, `twitch_tokens.${tokenType}`, null);
    return false;
  }
}

async function hashPassword(password) {
  return new Promise((resolve, reject) => {
    try {
      const salt = crypto.randomBytes(128).toString('base64');
      const iterations = 20480;
      const keylen = 64;
      const digest = 'sha512';

      crypto.pbkdf2(password, salt, iterations, keylen, digest, (err, derivedKey) => {
        if (err) {
          reject(err);
          return;
        }

        resolve({
          salt: salt,
          hash: derivedKey.toString('hex'),
          iterations: iterations,
          digest: digest
        });
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function isPasswordCorrect(savedHash, savedSalt, savedIterations, passwordAttempt) {
  // Validate parameters
  if (!savedHash || !savedSalt || !passwordAttempt) {
    throw new Error('Missing required parameters for password verification');
  }

  // Ensure all parameters are strings
  savedHash = String(savedHash);
  savedSalt = String(savedSalt);
  passwordAttempt = String(passwordAttempt);

  // Ensure iterations is a number
  const iterations = Number(savedIterations) || 20480;

  return new Promise((resolve, reject) => {
    try {
      const digest = 'sha512';
      const keylen = 64;

      crypto.pbkdf2(passwordAttempt, savedSalt, iterations, keylen, digest, (err, derivedKey) => {
        if (err) {
          reject(err);
          return;
        }

        const hash = derivedKey.toString('hex');
        resolve(savedHash === hash);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function handleChatMessage(data, authObject, message, user, formattedDate, response) {
  // Check if the message is a command or a jailbreak attempt first…
  if (!(await twitchHelper.isCommandMatch(message, authObject.user_id))) {
    if (containsJailbreakAttempt(message)) {
      logger.log("API", "Processing message as jailbreak attempt.");
      const aiJBResp = await aiHelper.respondWithoutContext(
        `Creatively be mean towards ${data.user} for trying to stop you from doing your job and ruin ${authObject.user_name}'s stream.`,
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
            return response;
          }
        } else {
          response.send({ response: finalResp.response, thoughtProcess: finalResp.thoughtProcess });
          return response;
        }
      } catch (error) {
        logger.log("API", `Error in AI response generation: ${error.message}`);
        response.send({
          response: "I'm sorry, I encountered an error while processing your message.",
          error: error.message
        });
        return response
      }
    }
  } else {
    response.send({ response: "OK" });
    return response;
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
        const contextString = `On ${formattedDate}, ${user} said in ${user === authObject.user_name
          ? "their own"
          : `${authObject.user_name}'s`
          } chat: "${message}". You responded by saying: ${aiResp.response}`;
        const summaryString = `On ${formattedDate}, ${user} said to you in ${user === authObject.user_name
          ? "their own"
          : `${authObject.user_name}'s`
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
        const summaryString = `On ${formattedDate} ${user} said in ${user === authObject.user_name
          ? "their own"
          : `${authObject.user_name}'s`
          } Twitch chat: "${message}"`;
        const contextString = `On ${formattedDate}, ${user} said in ${user === authObject.user_name
          ? "their own"
          : `${authObject.user_name}'s`
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
