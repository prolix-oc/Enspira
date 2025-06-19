import * as aiHelper from "../ai-logic.js";
import { containsCharacterName, containsAuxBotName } from "../prompt-helper.js";
import {
  checkForAuth,
  updateUserParameter,
  returnAuthObject,
} from "../api-helper.js";
import { maintainVoiceContext } from "../data-helper.js";
import * as twitchHelper from "../twitch-helper.js";
import { retrieveConfigValue } from "../config-helper.js";
import moment from "moment";
import fastifyFormbody from "@fastify/formbody";
import cors from "@fastify/cors";
import fastifyCompress from "@fastify/compress";
import fs from "fs-extra";
import * as crypto from "crypto";
import path from "path";

async function requireAuth(request, reply) {
  // First check if cookies object exists
  if (!request.cookies) {
    logger.error(
      "Auth",
      "Cookie parser not available - make sure fastify-cookie is registered"
    );
    return reply.redirect("/web/auth/login");
  }

  const sessionToken = request.cookies.enspira_session;

  if (!sessionToken) {
    return reply.redirect("/web/auth/login");
  }

  try {
    // Verify and decode the session token
    const decoded = verifySessionToken(sessionToken);

    if (!decoded || !decoded.userId) {
      // Invalid token
      reply.clearCookie("enspira_session");
      return reply.redirect("/web/auth/login");
    }

    // Get user from database
    const user = await returnAuthObject(decoded.userId);

    if (!user) {
      // User doesn't exist
      reply.clearCookie("enspira_session");
      return reply.redirect("/web/auth/login");
    }

    // Add user to request for use in route handlers
    request.user = user;

    // Continue to route handler
    return;
  } catch (error) {
    logger.error("Auth", `Session validation error: ${error.message}`);
    reply.clearCookie("enspira_session");
    return reply.redirect("/web/auth/login");
  }
}

export function createSessionToken(userId, expiresIn = "7d") {
  // Create a token payload
  const payload = {
    userId,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7, // 7 days
  };

  // Sign the token
  const token = crypto
    .createHmac("sha256", process.env.COOKIE_SECRET || "enspira-secret-key")
    .update(JSON.stringify(payload))
    .digest("hex");

  // Return token and payload together
  return `${token}.${Buffer.from(JSON.stringify(payload)).toString("base64")}`;
}

// Function to verify a session token
export function verifySessionToken(token) {
  try {
    const [signature, payloadBase64] = token.split(".");

    // Decode the payload
    const payload = JSON.parse(Buffer.from(payloadBase64, "base64").toString());

    // Check if token is expired
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    // Verify the signature
    const expectedSignature = crypto
      .createHmac("sha256", process.env.COOKIE_SECRET || "enspira-secret-key")
      .update(JSON.stringify(payload))
      .digest("hex");

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

  await fastify.register(cors, {
    origin: true,
  });

  await fastify.register(fastifyCompress, {
    global: true,
    threshold: 1024, // Start compressing at 1KB
    encodings: ["gzip", "deflate", "br"],
    inflateIfDeflated: true, // Handle already compressed payloads
    zlibOptions: {
      level: 4, // Balance between compression level and CPU usage
      memLevel: 8, // Use more memory for better compression
      windowBits: 15, // Maximum window size
    },
  });
  await fastify.register(fastifyFormbody);

  fastify.setErrorHandler((error, request, reply) => {
    if (error && error.code === "FST_ERR_ROUTE_METHOD_NOT_SUPPORTED") {
      reply.code(405).send({
        error: "Method Not Allowed",
        message: `HTTP method "${request.method}" is not supported for this route.`,
        allowedMethods: reply.context.config.allowedMethods,
      });
      return reply;
    } else {
      reply.send(error);
      return reply;
    }
  });

  // Login POST handler
  fastify.post("/auth/login", async (request, reply) => {
    try {
      const { user_id, password } = request.body;

      if (!user_id || !password) {
        return reply.redirect(
          "/web/auth/auth/login?error=Missing+required+fields"
        );
      }

      // Get user
      const user = await returnAuthObject(user_id);

      if (!user) {
        return reply.redirect("/web/auth/login?error=Invalid+credentials");
      }

      // Check password
      if (!user.webPasswordHash || !user.webPasswordSalt) {
        return reply.redirect("/web/auth/login?error=No+password+set");
      }

      const passwordCorrect = await isPasswordCorrect(
        user.webPasswordHash,
        user.webPasswordSalt,
        user.webPasswordIterations || 20480,
        password
      );

      if (!passwordCorrect) {
        return reply.redirect("/web/auth/login?error=Invalid+credentials");
      }

      // Create session
      const sessionToken = createSessionToken(user_id);

      // Set cookie
      reply.setCookie("enspira_session", sessionToken, {
        path: "/",
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 7, // 7 days
      });

      // Redirect to dashboard
      return reply.redirect("/web/dashboard");
    } catch (error) {
      logger.error("Auth", `Login error: ${error.message}`);
      return reply.redirect("/web/auth/auth/login?error=An+error+occurred");
    }
  });

  // Voice file upload endpoint
  // Updated server route to use the new JSON endpoint on the helper API
  fastify.post(
    "/character/voice-upload",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;

        // Debug logging
        logger.log(
          "Audio",
          `Voice upload request received for user ${user.user_id}`
        );

        // Extract file data from the request body
        const fileData = request.body.files || [];

        logger.log(
          "Audio",
          `Received ${fileData.length} files in Base64 format`
        );

        if (fileData.length === 0) {
          logger.error("Audio", "No files received in request");
          return reply.redirect("/web/character?error=No+files+uploaded");
        }

        // Validate file count
        if (fileData.length > 4) {
          logger.error("Audio", `Too many files: ${fileData.length}`);
          return reply.redirect("/web/character?error=Maximum+4+files+allowed");
        }

        // Process each file
        const processedFiles = [];

        for (const file of fileData) {
          try {
            // Validate the file data
            if (!file.name || !file.data) {
              logger.error("Audio", "Invalid file data: missing name or data");
              continue;
            }

            // Check file name
            if (!file.name.toLowerCase().endsWith(".wav")) {
              logger.error("Audio", `File ${file.name} is not a WAV file`);
              return reply.redirect(
                "/web/character?error=Only+WAV+files+are+accepted"
              );
            }

            // Decode Base64 data
            const base64Data = file.data.split(";base64,").pop();
            const buffer = Buffer.from(base64Data, "base64");

            // Check file size
            if (buffer.length > 3 * 1024 * 1024) {
              logger.error(
                "Audio",
                `File ${file.name} exceeds 3MB limit (${buffer.length} bytes)`
              );
              return reply.redirect(
                "/web/character?error=File+exceeds+3MB+limit"
              );
            }

            logger.log("Audio", `Decoded ${file.name}: ${buffer.length} bytes`);

            // Validate audio file - now using our lightweight parser
            const validationResult = await validateWavBuffer(buffer);

            if (!validationResult.valid) {
              logger.error(
                "Audio",
                `Audio validation failed for ${file.name}: ${validationResult.reason}`
              );
              return reply.redirect(
                `/web/character?error=${encodeURIComponent(validationResult.reason)}`
              );
            }

            // Add to processed files - we'll pass along the Base64 data directly
            processedFiles.push({
              name: file.name,
              data: file.data,
            });

            logger.log(
              "Audio",
              `Validated ${file.name}: sampleRate=${validationResult.sampleRate}Hz, duration=${validationResult.duration.toFixed(1)}s`
            );
          } catch (fileError) {
            logger.error(
              "Audio",
              `Error processing file ${file.name}: ${fileError.message}`
            );
            return reply.redirect("/web/character?error=Error+processing+file");
          }
        }

        // Check if we have any valid files
        if (processedFiles.length === 0) {
          logger.error("Audio", "No valid files found in request");
          return reply.redirect("/web/character?error=No+valid+files+uploaded");
        }

        // Get the base URL for the helper API
        const helperApiBase =
          (await retrieveConfigValue("voiceHelper.endpoint")) ||
          "http://localhost:3500";

        // Construct the JSON endpoint URL - now using the new create-json endpoint
        const helperApiEndpoint = `${helperApiBase}/voice/create-json`;

        // Log that we're sending files to the helper API
        logger.log(
          "Audio",
          `Sending ${processedFiles.length} files to voice helper API at ${helperApiEndpoint}`
        );

        // Send to helper API using JSON
        try {
          const axios = (await import("axios")).default;

          // Create the JSON payload
          const jsonPayload = {
            files: processedFiles,
          };

          // Send the request with JSON payload
          const response = await axios.post(
            `${helperApiEndpoint}?userID=${user.user_id}&characterName=${encodeURIComponent(user.bot_name || "character")}`,
            jsonPayload,
            {
              headers: {
                "Content-Type": "application/json",
              },
              timeout: 60000, // 60 second timeout
              maxContentLength: Infinity,
              maxBodyLength: Infinity,
            }
          );

          // Check response
          if (
            response.data &&
            response.data.success &&
            response.data.filename
          ) {
            // Update user's speaker_file with the returned filename
            await updateUserParameter(
              user.user_id,
              "speaker_file",
              response.data.filename
            );

            logger.log(
              "Audio",
              `Successfully processed voice files for user ${user.user_id}, saved as ${response.data.filename}`
            );

            // Redirect with success message
            return reply.redirect(
              "/web/character?success=Voice+files+uploaded+successfully"
            );
          } else {
            logger.error(
              "Audio",
              `Helper API error: ${JSON.stringify(response.data)}`
            );
            return reply.redirect(
              "/web/character?error=Failed+to+process+voice+files"
            );
          }
        } catch (apiError) {
          logger.error(
            "Audio",
            `Helper API request failed: ${apiError.message}`
          );

          let errorMessage = "Upload+failed";
          if (
            apiError.code === "ECONNREFUSED" ||
            apiError.code === "ECONNABORTED"
          ) {
            errorMessage = "Voice+processing+service+unavailable";
          } else if (apiError.response && apiError.response.status) {
            errorMessage = `Server+error+${apiError.response.status}`;
          }

          return reply.redirect(`/web/character?error=${errorMessage}`);
        }
      } catch (error) {
        logger.error("Audio", `Error in voice upload route: ${error.message}`);
        return reply.redirect("/web/character?error=Internal+server+error");
      }
    }
  );

  // Logout route
  fastify.get("/auth/logout", async (request, reply) => {
    reply.clearCookie("enspira_session");
    return reply.redirect("/web/auth/login");
  });

  fastify.post(
    "/character/features",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;

        // Extract values from form data
        const funFacts = getFieldValue(request.body.funFacts) === "true";
        const funFactsInterval = parseInt(
          getFieldValue(request.body.funFactsInterval),
          10
        );
        const ttsEnabled = getFieldValue(request.body.tts_enabled) === "true";
        const ttsEqPref = getFieldValue(request.body.ttsEqPref);
        const ttsUpsamplePref =
          getFieldValue(request.body.ttsUpsamplePref) === "true";

        // Validate funFactsInterval
        const interval = Math.max(5, Math.min(240, funFactsInterval || 30));

        // Update user parameters
        await updateUserParameter(user.user_id, "funFacts", funFacts);
        await updateUserParameter(user.user_id, "funFactsInterval", interval);
        await updateUserParameter(user.user_id, "tts_enabled", ttsEnabled);

        // Only update TTS-related settings if TTS is enabled
        if (ttsEnabled) {
          await updateUserParameter(user.user_id, "ttsEqPref", ttsEqPref);
          await updateUserParameter(
            user.user_id,
            "ttsUpsamplePref",
            ttsUpsamplePref
          );
        }

        reply.send({
          success: true,
          message: "Character features updated successfully",
        });
      } catch (error) {
        logger.error(
          "Web",
          `Error updating character features: ${error.message}`
        );
        reply.code(500).send({
          success: false,
          error: "An error occurred while updating character features",
        });
      }
    }
  );

  fastify.get(
    "/auth/twitch/connect",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const { type } = request.query;
        const user = request.user;

        if (!type || (type !== "bot" && type !== "streamer")) {
          return reply.code(400).send({ error: "Invalid account type" });
        }

        // Generate auth token and store it temporarily
        const authToken = crypto.randomBytes(32).toString("hex");

        global.pendingTwitchAuths = global.pendingTwitchAuths || new Map();
        global.pendingTwitchAuths.set(authToken, {
          userId: user.user_id,
          createdAt: Date.now(),
          authType: type,
        });

        // Get the scopes based on auth type
        const scopeType = type;
        let scopeValue;

        try {
          // Get the scopes from config
          const configScopes = await retrieveConfigValue(
            `twitch.scopes.${scopeType}`
          );

          // Handle different possible formats
          if (Array.isArray(configScopes)) {
            scopeValue = configScopes.join(" ");
          } else if (typeof configScopes === "string") {
            scopeValue = configScopes;
          } else if (configScopes === null || configScopes === undefined) {
            if (scopeType === "bot") {
              scopeValue = "chat:read chat:edit user:read:email";
            } else {
              scopeValue =
                "channel:read:broadcast channel:read:subscriptions channel:read:hype_train channel:read:follows";
            }
            logger.log(
              "Auth",
              `No twitch.scopes.${scopeType} found in config, using defaults`
            );
          } else {
            scopeValue = String(configScopes);
            logger.log(
              "Auth",
              `Unexpected type for twitch.scopes.${scopeType}: ${typeof configScopes}. Converting to string.`
            );
          }
        } catch (error) {
          logger.error(
            "Auth",
            `Error getting Twitch scopes: ${error.message}. Using defaults.`
          );
          if (scopeType === "bot") {
            scopeValue = "chat:read chat:edit user:read:email";
          } else {
            scopeValue =
              "channel:read:broadcast channel:read:subscriptions channel:read:hype_train channel:read:follows";
          }
        }

        // Create the Twitch OAuth URL
        const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
        authUrl.searchParams.set(
          "client_id",
          await retrieveConfigValue("twitch.clientId")
        );
        authUrl.searchParams.set(
          "redirect_uri",
          await retrieveConfigValue("twitch.redirectUri")
        );
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", scopeValue);
        authUrl.searchParams.set("state", authToken);

        // Force login prompt if connecting a bot account
        if (type === "bot") {
          authUrl.searchParams.set("force_verify", "true");
        }

        return reply.redirect(authUrl.toString());
      } catch (error) {
        logger.error("Auth", `Error in Twitch connect: ${error.message}`);
        return reply.code(500).send({ error: "An error occurred" });
      }
    }
  );

  // 2. Authentication endpoint that verifies credentials
  fastify.post("/auth/twitch/authenticate", async (request, reply) => {
    try {
      // 1. Validate request body
      if (!request.body || typeof request.body !== "object") {
        return reply.code(400).send({ error: "Invalid request format" });
      }

      const { user_id, password, auth_type } = request.body;

      // 2. Check for required fields
      if (!user_id || !password) {
        return reply.code(400).send({ error: "Missing required fields" });
      }

      // Log the auth_type to debug
      logger.log(
        "Auth",
        `Authenticating user: ${user_id} for ${auth_type || "streamer"} account`
      );

      // 4. Get user details
      const user = await returnAuthObject(user_id);

      if (!user) {
        return reply.code(401).send({ error: "User not found" });
      }

      // 5. Check if password hash and salt exist
      if (!user.webPasswordHash || !user.webPasswordSalt) {
        logger.log("Auth", `User ${user_id} has no password set`);
        return reply.code(401).send({
          error: "No password set for this account",
          setupRequired: true,
        });
      }

      // 6. Validate parameters for isPasswordCorrect
      const iterations = user.webPasswordIterations || 20480;

      logger.log(
        "Auth",
        `Verifying password with hash=${user.webPasswordHash ? "exists" : "missing"}, salt=${user.webPasswordSalt ? "exists" : "missing"}`
      );

      // 7. Verify password with explicit parameter validation
      const passwordCorrect = await isPasswordCorrect(
        user.webPasswordHash,
        user.webPasswordSalt,
        iterations,
        password
      );

      if (!passwordCorrect) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      // Generate auth token and store it temporarily
      const authToken = crypto.randomBytes(32).toString("hex");

      global.pendingTwitchAuths = global.pendingTwitchAuths || new Map();
      global.pendingTwitchAuths.set(authToken, {
        userId: user_id,
        createdAt: Date.now(),
        authType: auth_type || "streamer", // Default to streamer if not specified
      });

      // Get the scopes based on auth type (bot or streamer)
      const scopeType = auth_type === "bot" ? "bot" : "streamer";
      let scopeValue;

      try {
        // Get the scopes from config
        const configScopes = await retrieveConfigValue(
          `twitch.scopes.${scopeType}`
        );

        // Handle different possible formats
        if (Array.isArray(configScopes)) {
          // If it's already an array, just join it
          scopeValue = configScopes.join(" ");
        } else if (typeof configScopes === "string") {
          // If it's a single string, use it directly
          scopeValue = configScopes;
        } else if (configScopes === null || configScopes === undefined) {
          // If not configured, use default scopes based on type
          if (scopeType === "bot") {
            scopeValue = "chat:read chat:edit user:read:email";
          } else {
            scopeValue =
              "channel:read:broadcast channel:read:subscriptions channel:read:hype_train channel:read:follows";
          }
          logger.log(
            "Auth",
            `No twitch.scopes.${scopeType} found in config, using defaults`
          );
        } else {
          // Unexpected type, convert to string
          scopeValue = String(configScopes);
          logger.log(
            "Auth",
            `Unexpected type for twitch.scopes.${scopeType}: ${typeof configScopes}. Converting to string.`
          );
        }
      } catch (error) {
        // Fallback to default scopes if there's an error
        logger.error(
          "Auth",
          `Error getting Twitch scopes: ${error.message}. Using defaults.`
        );
        if (scopeType === "bot") {
          scopeValue = "chat:read chat:edit user:read:email";
        } else {
          scopeValue =
            "channel:read:broadcast channel:read:subscriptions channel:read:hype_train channel:read:follows";
        }
      }

      // Now use scopeValue in the URL
      const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
      authUrl.searchParams.set(
        "client_id",
        await retrieveConfigValue("twitch.clientId")
      );
      authUrl.searchParams.set(
        "redirect_uri",
        await retrieveConfigValue("twitch.redirectUri")
      );
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", scopeValue);
      authUrl.searchParams.set("state", authToken);
      if (auth_type === "bot") {
        authUrl.searchParams.set("force_verify", "true");
      }
      return reply.redirect(authUrl.toString());
    } catch (error) {
      logger.error(
        "Auth",
        `Error during Twitch authentication: ${error.message}`
      );
      return reply
        .code(500)
        .send({ error: "Authentication error", details: error.message });
    }
  });

  // 3. Callback from Twitch OAuth
  fastify.get("/auth/twitch/callback", async (request, reply) => {
    const { code, state } = request.query;

    // Verify state token exists in our pending auths
    if (!global.pendingTwitchAuths || !global.pendingTwitchAuths.has(state)) {
      return reply.code(400).send("Invalid or expired authorization request");
    }

    // Get user ID from the stored mapping
    const { userId, createdAt, authType } =
      global.pendingTwitchAuths.get(state);

    // Check if the token has expired (e.g., after 10 minutes)
    if (Date.now() - createdAt > 10 * 60 * 1000) {
      global.pendingTwitchAuths.delete(state);
      return reply.code(400).send("Authorization request expired");
    }

    try {
      const axios = (await import("axios")).default;
      // Exchange code for access token
      const tokenResponse = await axios.post(
        "https://id.twitch.tv/oauth2/token",
        {
          client_id: await retrieveConfigValue("twitch.clientId"),
          client_secret: await retrieveConfigValue("twitch.clientSecret"),
          code,
          grant_type: "authorization_code",
          redirect_uri: await retrieveConfigValue("twitch.redirectUri"),
        }
      );

      const { access_token, refresh_token, expires_in } = tokenResponse.data;

      // Get user info from Twitch
      const userResponse = await axios.get(
        "https://api.twitch.tv/helix/users",
        {
          headers: {
            "Client-ID": await retrieveConfigValue("twitch.clientId"),
            Authorization: `Bearer ${access_token}`,
          },
        }
      );

      const twitchUserInfo = userResponse.data.data[0];

      // Store tokens in user record - use the appropriate field based on auth type
      const tokenPath =
        authType === "bot" ? "twitch_tokens.bot" : "twitch_tokens.streamer";

      await updateUserParameter(userId, tokenPath, {
        access_token,
        refresh_token,
        expires_at: Date.now() + expires_in * 1000,
        twitch_user_id: twitchUserInfo.id,
        twitch_login: twitchUserInfo.login,
        twitch_display_name: twitchUserInfo.display_name,
      });

      // Clean up the pending auth
      global.pendingTwitchAuths.delete(state);

      // Redirect back to the management page
      return reply.redirect("/web/dashboard");
    } catch (error) {
      logger.log(
        "Auth",
        `Error during Twitch token exchange: ${error.message}`
      );
      return reply.code(500).send("Failed to complete Twitch authorization");
    }
  });

  function getFieldValue(field) {
    if (!field) return "";

    // If the field is a Part object from @fastify/multipart
    if (field.value !== undefined) {
      return field.value;
    }

    // If the field is already a string
    if (typeof field === "string") {
      return field;
    }

    // If the field is a readable stream (file upload)
    if (field.pipe && typeof field.pipe === "function") {
      // For this implementation, we're not handling file uploads
      // If needed, use stream handling here
      return "";
    }

    // Return empty string for any other case
    return "";
  }

  // Character personality update endpoint
  fastify.post(
    "/character/personality",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;

        // Extract values safely from multipart form data
        const botName = getFieldValue(request.body.bot_name);
        const personality = getFieldValue(request.body.personality);

        // Update bot name in user record
        await updateUserParameter(user.user_id, "bot_name", botName);

        // Save personality to file
        const success = await saveTextContent(
          user.user_id,
          "character_personality",
          personality
        );

        if (success) {
          reply.send({
            success: true,
            message: "Personality updated successfully",
          });
        } else {
          reply
            .code(500)
            .send({ success: false, error: "Failed to save personality" });
        }
      } catch (error) {
        logger.error("Web", `Error updating personality: ${error.message}`);
        reply.code(500).send({
          success: false,
          error: "An error occurred while updating personality",
        });
      }
    }
  );

  // Character description update endpoint
  fastify.post(
    "/character/description",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;

        // Extract values safely from multipart form data
        const description = getFieldValue(request.body.description);
        const botTwitch = getFieldValue(request.body.bot_twitch);

        // Save description to file
        const success = await saveTextContent(
          user.user_id,
          "character_card",
          description
        );

        // Update bot_twitch if provided
        if (botTwitch) {
          await updateUserParameter(user.user_id, "bot_twitch", botTwitch);
        }

        if (success) {
          reply.send({
            success: true,
            message: "Description updated successfully",
          });
        } else {
          reply
            .code(500)
            .send({ success: false, error: "Failed to save description" });
        }
      } catch (error) {
        logger.error("Web", `Error updating description: ${error.message}`);
        reply.code(500).send({
          success: false,
          error: "An error occurred while updating description",
        });
      }
    }
  );

  // Character examples update endpoint
  fastify.post(
    "/character/examples",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;

        // Extract value safely from multipart form data
        const examples = getFieldValue(request.body.examples);

        // Save examples to file
        const success = await saveTextContent(
          user.user_id,
          "examples",
          examples
        );

        if (success) {
          reply.send({
            success: true,
            message: "Examples updated successfully",
          });
        } else {
          reply
            .code(500)
            .send({ success: false, error: "Failed to save examples" });
        }
      } catch (error) {
        logger.error("Web", `Error updating examples: ${error.message}`);
        reply.code(500).send({
          success: false,
          error: "An error occurred while updating examples",
        });
      }
    }
  );

  // World info update endpoint
  fastify.post(
    "/world/info",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;

        // Extract values safely from multipart form data
        const worldInfo = getFieldValue(request.body.world_info);
        const weatherEnabled = getFieldValue(request.body.weather_enabled);

        // Update weather flag in user record
        await updateUserParameter(
          user.user_id,
          "weather",
          weatherEnabled === "true"
        );

        // Save world info to file
        const success = await saveTextContent(
          user.user_id,
          "world_lore",
          worldInfo
        );

        if (success) {
          reply.send({
            success: true,
            message: "World information updated successfully",
          });
        } else {
          reply.code(500).send({
            success: false,
            error: "Failed to save world information",
          });
        }
      } catch (error) {
        logger.error("Web", `Error updating world info: ${error.message}`);
        reply.code(500).send({
          success: false,
          error: "An error occurred while updating world information",
        });
      }
    }
  );

  // Player info update endpoint
  fastify.post(
    "/world/player",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;

        // Extract values safely from multipart form data
        const playerInfo = getFieldValue(request.body.player_info);
        const commandsList = getFieldValue(request.body.commands_list);

        // Update commands list in user record if provided
        if (commandsList) {
          const commandsArray = commandsList
            .split("\n")
            .map((cmd) => cmd.trim())
            .filter((cmd) => cmd.length > 0);
          await updateUserParameter(
            user.user_id,
            "commands_list",
            commandsArray
          );
        }

        // Save player info to file
        const success = await saveTextContent(
          user.user_id,
          "player_info",
          playerInfo
        );

        if (success) {
          reply.send({
            success: true,
            message: "Player information updated successfully",
          });
        } else {
          reply.code(500).send({
            success: false,
            error: "Failed to save player information",
          });
        }
      } catch (error) {
        logger.error("Web", `Error updating player info: ${error.message}`);
        reply.code(500).send({
          success: false,
          error: "An error occurred while updating player information",
        });
      }
    }
  );

  // Scenario update endpoint
  fastify.post(
    "/world/scenario",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;

        // Extract values safely from multipart form data
        const scenario = getFieldValue(request.body.scenario);
        const auxBots = getFieldValue(request.body.aux_bots);

        // Update aux bots list in user record if provided
        if (auxBots) {
          const auxBotsArray = auxBots
            .split("\n")
            .map((bot) => bot.trim())
            .filter((bot) => bot.length > 0);
          await updateUserParameter(user.user_id, "aux_bots", auxBotsArray);
        }

        // Save scenario to file
        const success = await saveTextContent(
          user.user_id,
          "scenario",
          scenario
        );

        if (success) {
          reply.send({
            success: true,
            message: "Scenario updated successfully",
          });
        } else {
          reply
            .code(500)
            .send({ success: false, error: "Failed to save scenario" });
        }
      } catch (error) {
        logger.error("Web", `Error updating scenario: ${error.message}`);
        reply.code(500).send({
          success: false,
          error: "An error occurred while updating scenario",
        });
      }
    }
  );

  fastify.post(
    "/alternate-spellings",
    {
      preHandler: fastify.authenticate,
      schema: {
        body: {
          type: "object",
          properties: {
            spelling: {
              oneOf: [
                { type: "string" },
                {
                  type: "object",
                  properties: {
                    from: { type: "string" },
                    to: { type: "string" },
                  },
                  required: ["from", "to"],
                },
              ],
            },
          },
          required: ["spelling"],
        },
      },
    },
    async (request, reply) => {
      try {
        const userId = request.user.user_id;
        const { spelling } = request.body;

        // Import the function from mongodb-client
        const { addAlternateSpelling } = await import("../mongodb-client.js");

        const success = await addAlternateSpelling(userId, spelling);

        if (success) {
          return reply.send({
            success: true,
            message: "Alternate spelling added successfully",
            data: { spelling },
          });
        } else {
          return reply.code(400).send({
            success: false,
            error: "Failed to add alternate spelling",
          });
        }
      } catch (error) {
        logger.error(
          "API",
          `Error adding alternate spelling: ${error.message}`
        );
        return reply.code(500).send({
          success: false,
          error: "Internal server error",
        });
      }
    }
  );

  fastify.delete(
    "/alternate-spellings",
    {
      preHandler: fastify.authenticate,
      schema: {
        body: {
          type: "object",
          properties: {
            spelling: {
              oneOf: [
                { type: "string" },
                {
                  type: "object",
                  properties: {
                    from: { type: "string" },
                    to: { type: "string" },
                  },
                  required: ["from", "to"],
                },
              ],
            },
          },
          required: ["spelling"],
        },
      },
    },
    async (request, reply) => {
      try {
        const userId = request.user.user_id;
        const { spelling } = request.body;

        // Import the function from mongodb-client
        const { removeAlternateSpelling } = await import(
          "../mongodb-client.js"
        );

        const success = await removeAlternateSpelling(userId, spelling);

        if (success) {
          return reply.send({
            success: true,
            message: "Alternate spelling removed successfully",
            data: { spelling },
          });
        } else {
          return reply.code(400).send({
            success: false,
            error: "Failed to remove alternate spelling",
          });
        }
      } catch (error) {
        logger.error(
          "API",
          `Error removing alternate spelling: ${error.message}`
        );
        return reply.code(500).send({
          success: false,
          error: "Internal server error",
        });
      }
    }
  );

  // Test alternate spelling replacement
  fastify.post(
    "/alternate-spellings/test",
    {
      preHandler: fastify.authenticate,
      schema: {
        body: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
        },
      },
    },
    async (request, reply) => {
      try {
        const userId = request.user.user_id;
        const { text } = request.body;
        const userObj = await returnAuthObject(userId);

        if (!userObj) {
          return reply.code(404).send({
            success: false,
            error: "User not found",
          });
        }

        // Apply alternate spelling logic
        let processedText = text;
        const alternateSpellings = userObj.alternateSpell || [];

        function escapeRegExp(string) {
          return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }

        const replacements = [];

        for (const alternateEntry of alternateSpellings) {
          if (typeof alternateEntry === "string") {
            const regex = new RegExp(
              `\\b${escapeRegExp(alternateEntry)}\\b`,
              "gi"
            );
            const matches = text.match(regex);
            if (matches) {
              processedText = processedText.replace(regex, userObj.bot_name);
              replacements.push({
                from: alternateEntry,
                to: userObj.bot_name,
                occurrences: matches.length,
              });
            }
          } else if (
            typeof alternateEntry === "object" &&
            alternateEntry.from &&
            alternateEntry.to
          ) {
            const regex = new RegExp(
              `\\b${escapeRegExp(alternateEntry.from)}\\b`,
              "gi"
            );
            const matches = text.match(regex);
            if (matches) {
              processedText = processedText.replace(regex, alternateEntry.to);
              replacements.push({
                from: alternateEntry.from,
                to: alternateEntry.to,
                occurrences: matches.length,
              });
            }
          }
        }

        return reply.send({
          success: true,
          data: {
            original_text: text,
            processed_text: processedText,
            replacements: replacements,
            bot_name: userObj.bot_name,
            alternate_spellings_used: alternateSpellings,
          },
        });
      } catch (error) {
        logger.error(
          "API",
          `Error testing alternate spellings: ${error.message}`
        );
        return reply.code(500).send({
          success: false,
          error: "Internal server error",
        });
      }
    }
  );

  fastify.get(
    "/alternate-spellings",
    {
      preHandler: fastify.authenticate,
    },
    async (request, reply) => {
      try {
        const userId = request.user.user_id;
        const userObj = await returnAuthObject(userId);

        if (!userObj) {
          return reply.code(404).send({
            success: false,
            error: "User not found",
          });
        }

        return reply.send({
          success: true,
          data: {
            bot_name: userObj.bot_name,
            alternate_spellings: userObj.alternateSpell || [],
            count: (userObj.alternateSpell || []).length,
          },
        });
      } catch (error) {
        logger.error(
          "API",
          `Error fetching alternate spellings: ${error.message}`
        );
        return reply.code(500).send({
          success: false,
          error: "Internal server error",
        });
      }
    }
  );

  // Bot configuration update endpoint
  fastify.post(
    "/world/bot-config",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;

        // Extract values safely from multipart form data
        const commandsList = getFieldValue(request.body.commands_list);
        const auxBots = getFieldValue(request.body.aux_bots);

        // Update commands list in user record
        const commandsArray = commandsList
          .split("\n")
          .map((cmd) => cmd.trim())
          .filter((cmd) => cmd.length > 0);

        await updateUserParameter(user.user_id, "commands_list", commandsArray);

        // Update aux bots list in user record
        const auxBotsArray = auxBots
          .split("\n")
          .map((bot) => bot.trim())
          .filter((bot) => bot.length > 0);

        await updateUserParameter(user.user_id, "aux_bots", auxBotsArray);

        reply.send({
          success: true,
          message: "Bot configuration updated successfully",
        });
      } catch (error) {
        logger.error(
          "Web",
          `Error updating bot configuration: ${error.message}`
        );
        reply.code(500).send({
          success: false,
          error: "An error occurred while updating bot configuration",
        });
      }
    }
  );
  // Preferences settings update endpoint
  fastify.post(
    "/settings/preferences",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;

        // Extract values from form data
        const storeAllChat =
          getFieldValue(request.body.store_all_chat) === "true";
        const ttsEnabled = getFieldValue(request.body.tts_enabled) === "true";
        const ttsEqPref = getFieldValue(request.body.ttsEqPref);
        const ttsUpsamplePref =
          getFieldValue(request.body.ttsUpsamplePref) === "true";

        // Update user parameters
        await updateUserParameter(user.user_id, "store_all_chat", storeAllChat);
        await updateUserParameter(user.user_id, "tts_enabled", ttsEnabled);
        await updateUserParameter(user.user_id, "ttsEqPref", ttsEqPref);
        await updateUserParameter(
          user.user_id,
          "ttsUpsamplePref",
          ttsUpsamplePref
        );

        return reply.send({
          success: true,
          message: "Preferences updated successfully",
        });
      } catch (error) {
        logger.error("Web", `Error updating preferences: ${error.message}`);
        return reply.code(500).send({
          success: false,
          error: "An error occurred while updating preferences",
        });
      }
    }
  );
  fastify.post(
    "/gallery/:characterId/use",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = request;
      const { characterId } = request.params;

      try {
        const preset = await loadPreset(characterId);
        if (!preset) {
          return reply
            .code(404)
            .send({ success: false, error: "Character preset not found" });
        }

        logger.log(
          "Web",
          `Applying character preset: ${preset.name} (${characterId}) for user ${user.user_id}`
        );

        // Extract the internal format for saving to user files
        const personalityContent =
          preset.personality.internalFmt || preset.personality || "";
        const descriptionContent =
          preset.char_description.internalFmt || preset.char_description || "";

        // Apply the preset data to the user
        const nameUpdate = await updateUserParameter(
          user.user_id,
          "bot_name",
          preset.name
        );

        // Save personality and description to files
        const personalitySave = await saveTextContent(
          user.user_id,
          "character_personality",
          personalityContent
        );
        const descriptionSave = await saveTextContent(
          user.user_id,
          "character_card",
          descriptionContent
        );

        // Make sure bot_twitch is set if present in the preset
        if (preset.bot_twitch) {
          await updateUserParameter(
            user.user_id,
            "bot_twitch",
            preset.bot_twitch
          );
        }

        if (nameUpdate && personalitySave && descriptionSave) {
          logger.log(
            "Web",
            `Successfully applied preset '${characterId}' for user ${user.user_id}`
          );

          // Respond with success and a redirect URL for the frontend handler
          return reply.send({
            success: true,
            message: `Character preset "${preset.name}" applied successfully!`,
            redirect: "/web/character",
          });
        } else {
          logger.error(
            "Web",
            `Failed to fully apply preset '${characterId}' for user ${user.user_id}`
          );
          return reply.code(500).send({
            success: false,
            error: "Failed to save all character data",
          });
        }
      } catch (error) {
        logger.error(
          "Web",
          `Error applying preset '${characterId}' for user ${user.user_id}: ${error.message}`
        );
        return reply.code(500).send({
          success: false,
          error: "An error occurred while applying the preset",
        });
      }
    }
  );
}

/**
 * Lightweight WAV file parser that doesn't require audio output devices
 * @param {Buffer} buffer - The WAV file buffer to analyze
 * @returns {Object} - Validation result with audio properties
 */
async function validateWavBuffer(buffer) {
  try {
    // Log the buffer size for debugging
    logger.log("Audio", `Analyzing WAV buffer of size: ${buffer.length} bytes`);

    // Check if the buffer is valid and has enough bytes for a WAV header
    if (!buffer || buffer.length < 44) {
      return {
        valid: false,
        reason: "Invalid WAV file: too small or corrupted",
      };
    }

    // Check WAV header magic bytes (RIFF....WAVE)
    const isRiff = buffer.slice(0, 4).toString() === "RIFF";
    const isWave = buffer.slice(8, 12).toString() === "WAVE";

    if (!isRiff || !isWave) {
      logger.error(
        "Audio",
        `Invalid WAV header: RIFF=${isRiff}, WAVE=${isWave}`
      );
      return {
        valid: false,
        reason: "Invalid WAV file: incorrect format",
      };
    }

    // Find the 'fmt ' chunk
    let offset = 12; // Start after "WAVE"
    let fmtChunkFound = false;

    // Parse all chunks until we find 'fmt '
    while (offset < buffer.length - 8) {
      const chunkId = buffer.slice(offset, offset + 4).toString();
      const chunkSize = buffer.readUInt32LE(offset + 4);

      if (chunkId === "fmt ") {
        fmtChunkFound = true;
        break;
      }

      offset += 8 + chunkSize;
    }

    if (!fmtChunkFound) {
      logger.error("Audio", "WAV file missing 'fmt ' chunk");
      return {
        valid: false,
        reason: "Invalid WAV file: missing format information",
      };
    }

    // Now parse the format chunk
    offset += 8; // Skip chunk ID and size

    // Audio format (PCM = 1)
    const audioFormat = buffer.readUInt16LE(offset);

    // Number of channels
    const numChannels = buffer.readUInt16LE(offset + 2);

    // Sample rate
    const sampleRate = buffer.readUInt32LE(offset + 4);

    // Bytes per second
    const byteRate = buffer.readUInt32LE(offset + 8);

    // Bits per sample
    const bitsPerSample = buffer.readUInt16LE(offset + 14);

    // Find data chunk to calculate duration
    let dataSize = 0;
    offset = 12; // Reset to start after "WAVE"

    while (offset < buffer.length - 8) {
      const chunkId = buffer.slice(offset, offset + 4).toString();
      const chunkSize = buffer.readUInt32LE(offset + 4);

      if (chunkId === "data") {
        dataSize = chunkSize;
        break;
      }

      offset += 8 + chunkSize;
    }

    // Calculate duration
    const bytesPerSample = bitsPerSample / 8;
    const totalSamples = dataSize / (bytesPerSample * numChannels);
    const duration = totalSamples / sampleRate;

    // Log the results
    logger.log(
      "Audio",
      `WAV analysis: format=${audioFormat}, channels=${numChannels}, sampleRate=${sampleRate}Hz, bitsPerSample=${bitsPerSample}, duration=${duration.toFixed(2)}s`
    );

    // Validate requirements
    if (numChannels !== 1) {
      return {
        valid: false,
        reason: `Audio must be mono (found ${numChannels} channels)`,
      };
    }

    // Accept common sample rates: 22050Hz, 44100Hz, 48000Hz
    const acceptableSampleRates = [22050, 44100, 48000];
    const closestRate = acceptableSampleRates.reduce((prev, curr) =>
      Math.abs(curr - sampleRate) < Math.abs(prev - sampleRate) ? curr : prev
    );

    // Allow more variance (within 10% of target rate)
    if (Math.abs(sampleRate - closestRate) / closestRate > 0.1) {
      logger.warn(
        "Audio",
        `Unusual sample rate detected: ${sampleRate}Hz, closest standard rate: ${closestRate}Hz`
      );
      // We'll still accept it and let the voice API handle resampling
    }

    if (duration > 20) {
      return {
        valid: false,
        reason: `Duration exceeds 20 seconds (${duration.toFixed(1)}s)`,
      };
    }

    // Return all the parsed information
    return {
      valid: true,
      sampleRate,
      numChannels,
      bitsPerSample,
      duration,
      format: audioFormat === 1 ? "PCM" : "Non-PCM",
      closestStandardRate: closestRate,
    };
  } catch (error) {
    logger.error("Audio", `Error analyzing WAV file: ${error.message}`);
    return {
      valid: false,
      reason: `Failed to analyze WAV file: ${error.message}`,
    };
  }
}

/**
 * Saves text content to a file
 * @param {string} userId - The user ID
 * @param {string} fileName - The file name
 * @param {string} content - The content to save
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
export async function saveTextContent(userId, fileName, content) {
  try {
    const filePath = path.join(
      process.cwd(),
      "world_info",
      userId,
      `${fileName}.txt`
    );

    // Create directory if it doesn't exist
    await fs.ensureDir(path.join(process.cwd(), "world_info", userId));

    // Write content to file
    await fs.writeFile(filePath, content);
    return true;
  } catch (error) {
    logger.error(
      "Web",
      `Error saving ${fileName} for user ${userId}: ${error.message}`
    );
    return false;
  }
}

export async function hashPassword(password) {
  return new Promise((resolve, reject) => {
    try {
      const salt = crypto.randomBytes(128).toString("base64");
      const iterations = 20480;
      const keylen = 64;
      const digest = "sha512";

      crypto.pbkdf2(
        password,
        salt,
        iterations,
        keylen,
        digest,
        (err, derivedKey) => {
          if (err) {
            reject(err);
            return;
          }

          resolve({
            salt: salt,
            hash: derivedKey.toString("hex"),
            iterations: iterations,
            digest: digest,
          });
        }
      );
    } catch (error) {
      reject(error);
    }
  });
}

export async function isPasswordCorrect(
  savedHash,
  savedSalt,
  savedIterations,
  passwordAttempt
) {
  // Validate parameters
  if (!savedHash || !savedSalt || !passwordAttempt) {
    throw new Error("Missing required parameters for password verification");
  }

  // Ensure all parameters are strings
  savedHash = String(savedHash);
  savedSalt = String(savedSalt);
  passwordAttempt = String(passwordAttempt);

  // Ensure iterations is a number
  const iterations = Number(savedIterations) || 20480;

  return new Promise((resolve, reject) => {
    try {
      const digest = "sha512";
      const keylen = 64;

      crypto.pbkdf2(
        passwordAttempt,
        savedSalt,
        iterations,
        keylen,
        digest,
        (err, derivedKey) => {
          if (err) {
            reject(err);
            return;
          }

          const hash = derivedKey.toString("hex");
          resolve(savedHash === hash);
        }
      );
    } catch (error) {
      reject(error);
    }
  });
}

async function configureResponseHandling(fastify) {
  if (fastify.hasPlugin("fastify-compress")) {
    logger.log(
      "API",
      "Compression plugin already registered, updating configuration"
    );
  }

  // Configure response timeouts if server is available
  if (fastify.server) {
    // Use safer timeout values
    if (typeof fastify.server.keepAliveTimeout === "number") {
      fastify.server.keepAliveTimeout = 120000; // 2 minutes
    }
    if (typeof fastify.server.headersTimeout === "number") {
      fastify.server.headersTimeout = 65000; // Just above default 60s
    }
  }

  // Add hook to handle large responses - this should work regardless of server setup
  fastify.addHook("onRequest", (request, reply, done) => {
    // Set default headers for all responses
    reply.header("Content-Type", "application/json; charset=utf-8");
    done();
  });

  // Add response monitoring middleware
  fastify.addHook("onSend", (request, reply, payload, done) => {
    // For debugging, log payload size
    if (payload) {
      const size =
        typeof payload === "json"
          ? payload.length
          : JSON.stringify(payload).length;
      logger.log(
        "API",
        `Response payload size: ${size} bytes for ${request.url}`
      );

      // Check for suspiciously small payloads
      if (
        size < 5 &&
        request.method !== "HEAD" &&
        request.method !== "OPTIONS"
      ) {
        logger.log(
          "API",
          `WARNING: Very small response detected for ${request.url}: ${payload}`
        );
      }
    }

    // Make sure content type is set
    if (!reply.getHeader("content-type")) {
      reply.header("Content-Type", "application/json; charset=utf-8");
    }

    done(null, payload);
  });

  // Add a simple response helper method to the reply object
  fastify.decorateReply("sendSafe", function (data) {
    // If the data is already a string, use it directly
    if (typeof data === "string") {
      return this.type("text/plain; charset=utf-8").send(data);
    }

    try {
      // Try to stringify the data safely
      const safeJSON = JSON.stringify(data);
      return this.type("application/json; charset=utf-8").send(safeJSON);
    } catch (error) {
      logger.log("API", `Error stringifying response: ${error.message}`);
      // Send a fallback response
      return this.code(500).send(
        JSON.stringify({
          error: "Error generating response",
          message: "Failed to serialize response data",
        })
      );
    }
  });

  logger.log("API", "Response handling configuration completed");
}

/**
 * Load all character presets from the presets directory
 * @returns {Promise<Array>} Array of character preset objects
 */
export async function loadAllPresets() {
  try {
    const presetsDir = path.join(process.cwd(), "presets");

    // Make sure the directory exists
    await fs.ensureDir(presetsDir);

    const files = await fs.readdir(presetsDir);

    // Only process JSON files
    const jsonFiles = files.filter((file) => file.endsWith(".json"));

    // If no presets found, return empty array
    if (jsonFiles.length === 0) {
      logger.log("Web", "No character presets found in presets directory");
      return [];
    }

    // Load each preset file
    const presets = await Promise.all(
      jsonFiles.map(async (file) => {
        try {
          const filePath = path.join(presetsDir, file);
          const data = await fs.readFile(filePath, "utf8");
          const preset = JSON.parse(data);

          // Add the filename (without extension) as an ID
          preset.id = path.basename(file, ".json");

          // Handle basic preset fields
          preset.name = preset.name || "Unnamed Character";
          preset.author = preset.author || "Unknown Author";
          preset.summary = preset.summary || "No description provided.";

          // Handle nested personality structure
          if (
            typeof preset.personality === "object" &&
            preset.personality !== null
          ) {
            // Already using new format
            preset.personality.internalFmt =
              preset.personality.internalFmt || "";
            preset.personality.publicFmt = preset.personality.publicFmt || "";
          } else if (typeof preset.personality === "string") {
            // Convert old format to new
            const personalityText = preset.personality;
            preset.personality = {
              internalFmt: personalityText,
              publicFmt: personalityText,
            };
          } else {
            // Initialize with empty values
            preset.personality = {
              internalFmt: "",
              publicFmt: "",
            };
          }

          // Handle nested character description structure
          if (
            typeof preset.char_description === "object" &&
            preset.char_description !== null
          ) {
            // Already using new format
            preset.char_description.internalFmt =
              preset.char_description.internalFmt || "";
            preset.char_description.publicFmt =
              preset.char_description.publicFmt || "";
          } else if (typeof preset.char_description === "string") {
            // Convert old format to new
            const descriptionText = preset.char_description;
            preset.char_description = {
              internalFmt: descriptionText,
              publicFmt: descriptionText,
            };
          } else {
            // Initialize with empty values
            preset.char_description = {
              internalFmt: "",
              publicFmt: "",
            };
          }

          // Default image if not present
          if (!preset.image) {
            preset.image = "/api/placeholder/200/200";
          }

          return preset;
        } catch (err) {
          logger.error("Web", `Error loading preset ${file}: ${err.message}`);
          return null;
        }
      })
    );

    // Filter out any null results from failed loads
    return presets.filter((preset) => preset !== null);
  } catch (error) {
    logger.error("Web", `Error loading presets: ${error.message}`);
    // Return empty array instead of throwing, to show empty gallery
    return [];
  }
}

/**
 * Load a specific character preset by name
 * @param {string} characterId - ID of the character (filename without .json)
 * @returns {Promise<Object|null>} Character preset object or null if not found
 */
export async function loadPreset(characterId) {
  try {
    const filePath = path.join(process.cwd(), "presets", `${characterId}.json`);

    // Check if file exists
    const exists = await fs.pathExists(filePath);
    if (!exists) {
      logger.warn(
        "Web",
        `Character preset file not found: ${characterId}.json`
      );
      return null;
    }

    const data = await fs.readFile(filePath, "utf8");
    const preset = JSON.parse(data);

    // Add the characterId as an ID
    preset.id = characterId;

    // Handle basic preset fields
    preset.name = preset.name || "Unnamed Character";
    preset.author = preset.author || "Unknown Author";
    preset.summary = preset.summary || "No description provided.";

    // Handle nested personality structure
    if (typeof preset.personality === "object" && preset.personality !== null) {
      // Already using new format
      preset.personality.internalFmt = preset.personality.internalFmt || "";
      preset.personality.publicFmt = preset.personality.publicFmt || "";
    } else if (typeof preset.personality === "string") {
      // Convert old format to new
      const personalityText = preset.personality;
      preset.personality = {
        internalFmt: personalityText,
        publicFmt: personalityText,
      };
    } else {
      // Initialize with empty values
      preset.personality = {
        internalFmt: "",
        publicFmt: "",
      };
    }

    // Handle nested character description structure
    if (
      typeof preset.char_description === "object" &&
      preset.char_description !== null
    ) {
      // Already using new format
      preset.char_description.internalFmt =
        preset.char_description.internalFmt || "";
      preset.char_description.publicFmt =
        preset.char_description.publicFmt || "";
    } else if (typeof preset.char_description === "string") {
      // Convert old format to new
      const descriptionText = preset.char_description;
      preset.char_description = {
        internalFmt: descriptionText,
        publicFmt: descriptionText,
      };
    } else {
      // Initialize with empty values
      preset.char_description = {
        internalFmt: "",
        publicFmt: "",
      };
    }

    // Default image if not present
    if (!preset.image) {
      preset.image = "/api/placeholder/200/200";
    }

    return preset;
  } catch (error) {
    if (error.code === "ENOENT") {
      // File not found
      return null;
    }
    logger.error(
      "Web",
      `Error loading preset ${characterId}: ${error.message}`
    );
    return null;
  }
}

export default routes;
