// routes/web.js
import fs from "fs-extra";
import path from "path";
import { returnAuthObject, updateUserParameter } from "../api-helper.js";
import { logger } from "../create-global-logger.js";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { getChatCount } from "../mongodb-client.js";
import {
  loadPreset,
  loadAllPresets,
  hashPassword,
  isPasswordCorrect,
} from "./v1.js";

// Get the directory name properly in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Loads text content from a file if it exists, or returns an empty string
 * @param {string} userId - The user ID
 * @param {string} fileName - The file name
 * @returns {Promise<string>} - The file content or empty string
 */
async function loadTextContent(userId, fileName) {
  try {
    const filePath = path.join(
      process.cwd(),
      "world_info",
      userId,
      `${fileName}.txt`
    );

    // Create directory if it doesn't exist
    await fs.ensureDir(path.join(process.cwd(), "world_info", userId));

    // Check if file exists
    const exists = await fs.pathExists(filePath);
    if (!exists) {
      return "";
    }

    // Read file content
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    logger.error(
      "Web",
      `Error loading ${fileName} for user ${userId}: ${error.message}`
    );
    return "";
  }
}

// Import verifySessionToken function from existing auth code
import { verifySessionToken } from "./v1.js";

/**
 * Authentication middleware for web routes
 * @param {object} request - The request object
 * @param {object} reply - The reply object
 * @returns {Promise<void>}
 */
async function requireAuth(request, reply) {
  // Check if cookies object exists and if the enspira_session cookie is set
  const sessionToken = request.cookies?.enspira_session;

  if (!sessionToken) {
    logger.log("Auth", "No session token found, redirecting to login");
    return reply.redirect("/web/auth/login"); // Updated path
  }

  try {
    // Verify and decode the session token
    const decoded = verifySessionToken(sessionToken);

    if (!decoded || !decoded.userId) {
      // Invalid token
      reply.clearCookie("enspira_session");
      return reply.redirect("/web/auth/login"); // Updated path
    }

    // Get user from database
    const user = await returnAuthObject(decoded.userId);

    if (!user) {
      // User doesn't exist
      reply.clearCookie("enspira_session");
      return reply.redirect("/web/auth/login"); // Updated path
    }

    // Add user to request for use in route handlers
    request.user = user;

    // Continue to route handler
    return;
  } catch (error) {
    logger.error("Auth", `Session validation error: ${error.message}`);
    reply.clearCookie("enspira_session");
    return reply.redirect("/web/auth/login"); // Updated path
  }
}

// Helper function to extract form field values
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
    return "";
  }

  // Return empty string for any other case
  return "";
}

// Setup the web routes
async function webRoutes(fastify, options) {
  // Register the form body parser to ensure form submissions work
  await fastify.register(import("@fastify/formbody"));

  // Ensure the pages directory exists
  await fs.ensureDir(path.join(process.cwd(), "pages"));
  fastify.get(
    "/settings",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;

        // List of common time zones
        const timeZones = [
          { value: "America/New_York", label: "Eastern Time (ET)" },
          { value: "America/Chicago", label: "Central Time (CT)" },
          { value: "America/Denver", label: "Mountain Time (MT)" },
          { value: "America/Los_Angeles", label: "Pacific Time (PT)" },
          { value: "America/Anchorage", label: "Alaska Time (AKT)" },
          { value: "Pacific/Honolulu", label: "Hawaii Time (HT)" },
          { value: "Europe/London", label: "Greenwich Mean Time (GMT)" },
          { value: "Europe/Paris", label: "Central European Time (CET)" },
          { value: "Europe/Helsinki", label: "Eastern European Time (EET)" },
          { value: "Asia/Tokyo", label: "Japan Standard Time (JST)" },
          { value: "Australia/Sydney", label: "Australian Eastern Time (AET)" },
        ];

        // Initialize socials object if it doesn't exist
        if (!user.socials) {
          user.socials = {};
        }

        // Render settings page
        return reply.view("settings.njk", {
          pageTitle: "User Settings",
          settingsActive: true,
          user,
          timeZones,
          success: request.query.success,
          error: request.query.error,
        });
      } catch (error) {
        logger.error("Web", `Error serving settings page: ${error.message}`);
        return reply.code(500).send("Error loading settings page");
      }
    }
  );

  // Profile settings update endpoint
  fastify.post(
    "/settings/profile",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;

        // Extract values from form data
        const displayName = getFieldValue(request.body.display_name);
        const userName = getFieldValue(request.body.user_name);
        const email = getFieldValue(request.body.email);
        const timeZone = getFieldValue(request.body.timeZone);

        // Update user parameters
        await updateUserParameter(user.user_id, "display_name", displayName);
        await updateUserParameter(user.user_id, "user_name", userName);

        if (email) {
          await updateUserParameter(user.user_id, "email", email);
        }

        if (timeZone) {
          await updateUserParameter(user.user_id, "timeZone", timeZone);
        }

        return reply.send({
          success: true,
          message: "Profile settings updated successfully",
        });
      } catch (error) {
        logger.error(
          "Web",
          `Error updating profile settings: ${error.message}`
        );
        return reply.code(500).send({
          success: false,
          error: "An error occurred while updating profile settings",
        });
      }
    }
  );

  // Social media settings update endpoint
  fastify.post(
    "/settings/socials",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;

        // Ensure socials object exists in user record
        if (!user.socials) {
          await updateUserParameter(user.user_id, "socials", {});
        }

        // Build the socials object
        const socials = {};

        // Process each social media platform
        const platforms = [
          "twitter",
          "tiktok",
          "youtube",
          "instagram",
          "twitch",
          "kick",
        ];

        for (const platform of platforms) {
          socials[platform] = getFieldValue(
            request.body[`socials[${platform}]`]
          );
        }

        // Update user parameter
        await updateUserParameter(user.user_id, "socials", socials);

        return reply.send({
          success: true,
          message: "Social media settings updated successfully",
        });
      } catch (error) {
        logger.error(
          "Web",
          `Error updating social media settings: ${error.message}`
        );
        return reply.code(500).send({
          success: false,
          error: "An error occurred while updating social media settings",
        });
      }
    }
  );
  // Password update endpoint
  fastify.post(
    "/settings/password",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;

        // Extract values from form data
        const currentPassword = getFieldValue(request.body.current_password);
        const newPassword = getFieldValue(request.body.new_password);
        const confirmPassword = getFieldValue(request.body.confirm_password);

        // Validate passwords
        if (newPassword !== confirmPassword) {
          return reply.code(400).send({
            success: false,
            error: "New passwords do not match",
          });
        }

        // Check if password is already set
        if (!user.webPasswordHash || !user.webPasswordSalt) {
          // No password set yet, just set the new one
          const passwordData = await hashPassword(newPassword);

          await updateUserParameter(
            user.user_id,
            "webPasswordHash",
            passwordData.hash
          );
          await updateUserParameter(
            user.user_id,
            "webPasswordSalt",
            passwordData.salt
          );
          await updateUserParameter(
            user.user_id,
            "webPasswordIterations",
            passwordData.iterations
          );

          return reply.send({
            success: true,
            message: "Password set successfully",
          });
        }

        // Verify current password
        const iterations = user.webPasswordIterations || 20480;
        const passwordCorrect = await isPasswordCorrect(
          user.webPasswordHash,
          user.webPasswordSalt,
          iterations,
          currentPassword
        );

        if (!passwordCorrect) {
          return reply.code(401).send({
            success: false,
            error: "Current password is incorrect",
          });
        }

        // Set new password
        const passwordData = await hashPassword(newPassword);

        await updateUserParameter(
          user.user_id,
          "webPasswordHash",
          passwordData.hash
        );
        await updateUserParameter(
          user.user_id,
          "webPasswordSalt",
          passwordData.salt
        );
        await updateUserParameter(
          user.user_id,
          "webPasswordIterations",
          passwordData.iterations
        );

        return reply.send({
          success: true,
          message: "Password updated successfully",
        });
      } catch (error) {
        logger.error("Web", `Error updating password: ${error.message}`);
        return reply.code(500).send({
          success: false,
          error: "An error occurred while updating password",
        });
      }
    }
  );
  // Dashboard route
  fastify.get(
    "/dashboard",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;

        // Ensure we have proper defaults for all values the template uses
        const streamerConnected = !!user?.twitch_tokens?.streamer?.access_token;
        const botConnected = !!user?.twitch_tokens?.bot?.access_token;
        const streamerName = streamerConnected
          ? user.twitch_tokens.streamer.twitch_display_name || "Unknown"
          : "";
        const botName = botConnected
          ? user.twitch_tokens.bot.twitch_display_name || "Unknown"
          : "";

        // Set default stats
        const stats = {
          chatMessages: 0,
        };

        // Try to get actual chat count
        try {
          const recentChats = await getChatCount(user.user_id);
          stats.chatMessages = recentChats || 0;
        } catch (error) {
          logger.error("Web", `Error fetching chat stats: ${error.message}`);
        }

        // Always initialize streamStatus with default values for all properties
        let streamStatus = {
          online: false,
          title: "",
          game: "",
          viewers: 0,
          duration: "",
          thumbnail: null,
        };

        let followerCount = user.current_followers || 0;
        let lastGame = user.current_game?.game || "None";

        if (user.twitch_tokens?.streamer?.twitch_user_id) {
          try {
            const { fetchStreamInfo } = await import(
              "../twitch-eventsub-manager.js"
            );
            const streamInfo = await fetchStreamInfo(user.user_id);

            if (streamInfo && streamInfo.success && streamInfo.isLive) {
              // Update streamStatus with actual values
              streamStatus = {
                online: true,
                title: streamInfo.data.title || "Untitled Stream",
                game: streamInfo.data.gameName || "Unknown Game",
                viewers: streamInfo.data.viewerCount || 0,
                duration: streamInfo.data.duration || "Just started",
                thumbnail: streamInfo.data.thumbnailUrl || null,
              };
            }

            followerCount = user.current_followers || 0;
          } catch (error) {
            logger.error("Web", `Error fetching stream info: ${error.message}`);
          }
        }

        // Log complete data being sent to template
        logger.log(
          "Web",
          `Rendering dashboard with streamStatus: ${JSON.stringify(streamStatus)}`
        );

        return reply.view("dashboard.njk", {
          pageTitle: "Dashboard",
          dashboardActive: true,
          user: {
            display_name: user.display_name || user.user_name,
          },
          streamerConnected,
          botConnected,
          streamerName,
          botName,
          stats,
          streamStatus,
          followerCount,
          lastGame,
        });
      } catch (error) {
        logger.error("Web", `Error serving dashboard: ${error.message}`);
        return reply.code(500).send("Error loading dashboard");
      }
    }
  );

  // Character editor route
  fastify.get(
    "/character",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;

        // Load character data from files
        const characterPersonality = await loadTextContent(
          user.user_id,
          "character_personality"
        );
        const characterDescription = await loadTextContent(
          user.user_id,
          "character_card"
        );
        const characterExamples = await loadTextContent(
          user.user_id,
          "examples"
        );

        return reply.view("character.njk", {
          pageTitle: "Character Editor",
          characterActive: true,
          user,
          character: user,
          characterPersonality,
          characterDescription,
          characterExamples,
        });
      } catch (error) {
        logger.error("Web", `Error serving character editor: ${error.message}`);
        return reply.code(500).send("Error loading character editor");
      }
    }
  );

  // World editor route
  fastify.get("/world", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const user = request.user;

      // Load world data from files
      const worldInfo = await loadTextContent(user.user_id, "world_lore");
      const playerInfo = await loadTextContent(user.user_id, "player_info");
      const scenario = await loadTextContent(user.user_id, "scenario");

      // Format commands list and aux bots for textarea
      const commandsList = user.commands_list
        ? user.commands_list.join("\n")
        : "";
      const auxBots = user.aux_bots ? user.aux_bots.join("\n") : "";

      return reply.view("world.njk", {
        pageTitle: "World Editor",
        worldActive: true,
        user,
        character: user,
        worldInfo,
        playerInfo,
        scenario,
        commandsList,
        auxBots,
      });
    } catch (error) {
      logger.error("Web", `Error serving world editor: ${error.message}`);
      return reply.code(500).send("Error loading world editor");
    }
  });

  // Help page route
  fastify.get("/help", { preHandler: requireAuth }, async (request, reply) => {
    try {
      return reply.view("help.njk", {
        pageTitle: "Help & Documentation",
        helpActive: true,
      });
    } catch (error) {
      logger.error("Web", `Error serving help page: ${error.message}`);
      return reply.code(500).send(`Error loading help page: ${error.message}`);
    }
  });

  // Gallery route
  fastify.get(
    "/gallery",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;

        // Load all character presets
        const presets = await loadAllPresets();

        // Add placeholder images for presets that don't have one
        presets.forEach((preset) => {
          if (!preset.image) {
            preset.image = "/api/placeholder/200/200";
          }
        });

        return reply.view("gallery.njk", {
          pageTitle: "Character Gallery",
          galleryActive: true,
          presets,
          user,
        });
      } catch (error) {
        logger.error("Web", `Error serving gallery: ${error.message}`);
        return reply.code(500).send("Error loading character gallery");
      }
    }
  );

  fastify.get(
    "/gallery/:characterId",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const user = request.user;
        const { characterId } = request.params;

        // Load the character preset data
        const characterData = await loadPreset(characterId);

        if (!characterData) {
          logger.warn("Web", `Character preset '${characterId}' not found`);
          return reply.redirect("/web/gallery");
        }

        // Add placeholder image if missing
        if (!characterData.image) {
          characterData.image = "/api/placeholder/200/200";
        }

        return reply.view("character-details.njk", {
          pageTitle: characterData.name,
          galleryActive: true,
          character: characterData,
          user,
        });
      } catch (error) {
        logger.error(
          "Web",
          `Error serving character details: ${error.message}`
        );
        return reply.code(500).send("Error loading character details");
      }
    }
  );

  // Authentication routes
  fastify.get("/auth/login", async (request, reply) => {
    return reply.view("login.njk", {
      pageTitle: "Login",
      error: request.query.error || null,
    });
  });

  fastify.get("/auth/logout", async (request, reply) => {
    reply.clearCookie("enspira_session");
    return reply.redirect("/web/auth/login");
  });

  // Redirect root to dashboard
  fastify.get("/", (request, reply) => {
    return reply.redirect("/web/dashboard");
  });
  
  logger.log("Web", "Web routes registered successfully");
}

export default webRoutes;
