// routes/web.js
import fs from 'fs-extra';
import path from 'path';
import { returnAuthObject, updateUserParameter } from '../api-helper.js';
import { logger } from '../create-global-logger.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { returnRecentChats } from '../ai-logic.js';
import { loadPreset, loadAllPresets, saveTextContent } from './v1.js';

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
        const filePath = path.join(process.cwd(), 'world_info', userId, `${fileName}.txt`);

        // Create directory if it doesn't exist
        await fs.ensureDir(path.join(process.cwd(), 'world_info', userId));

        // Check if file exists
        const exists = await fs.pathExists(filePath);
        if (!exists) {
            return '';
        }

        // Read file content
        return await fs.readFile(filePath, 'utf8');
    } catch (error) {
        logger.error("Web", `Error loading ${fileName} for user ${userId}: ${error.message}`);
        return '';
    }
}

// Import verifySessionToken function from existing auth code
import { verifySessionToken } from './v1.js'

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
      return reply.redirect('/web/auth/login');  // Updated path
    }
  
    try {
      // Verify and decode the session token
      const decoded = verifySessionToken(sessionToken);
  
      if (!decoded || !decoded.userId) {
        // Invalid token
        reply.clearCookie('enspira_session');
        return reply.redirect('/web/auth/login');  // Updated path
      }
  
      // Get user from database
      const user = await returnAuthObject(decoded.userId);
  
      if (!user) {
        // User doesn't exist
        reply.clearCookie('enspira_session');
        return reply.redirect('/web/auth/login');  // Updated path
      }
  
      // Add user to request for use in route handlers
      request.user = user;
  
      // Continue to route handler
      return;
    } catch (error) {
      logger.error("Auth", `Session validation error: ${error.message}`);
      reply.clearCookie('enspira_session');
      return reply.redirect('/web/auth/login');  // Updated path
    }
  }

// Helper function to extract form field values
function getFieldValue(field) {
    if (!field) return '';

    // If the field is a Part object from @fastify/multipart
    if (field.value !== undefined) {
        return field.value;
    }

    // If the field is already a string
    if (typeof field === 'string') {
        return field;
    }

    // If the field is a readable stream (file upload)
    if (field.pipe && typeof field.pipe === 'function') {
        // For this implementation, we're not handling file uploads
        return '';
    }

    // Return empty string for any other case
    return '';
}

// Setup the web routes
async function webRoutes(fastify, options) {
    // Register the form body parser to ensure form submissions work
    await fastify.register(import('@fastify/formbody'));

    // Ensure the pages directory exists
    await fs.ensureDir(path.join(process.cwd(), 'pages'));

    // Dashboard route
    fastify.get('/dashboard', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;

            // Ensure we have proper defaults for all values the template uses
            const streamerConnected = !!user?.twitch_tokens?.streamer?.access_token;
            const botConnected = !!user?.twitch_tokens?.bot?.access_token;
            const streamerName = streamerConnected ? (user.twitch_tokens.streamer.twitch_display_name || 'Unknown') : '';
            const botName = botConnected ? (user.twitch_tokens.bot.twitch_display_name || 'Unknown') : '';

            // Set default stats
            const stats = {
                chatMessages: 0
            };

            // Try to get actual chat count
            try {
                const recentChats = await returnRecentChats(user.user_id, false, true);
                stats.chatMessages = recentChats?.length || 0;
            } catch (error) {
                logger.error("Web", `Error fetching chat stats: ${error.message}`);
            }

            // Always initialize streamStatus with default values for all properties
            let streamStatus = {
                online: false,
                title: '',
                game: '',
                viewers: 0,
                duration: '',
                thumbnail: null
            };

            let followerCount = user.current_followers || 0;
            let lastGame = user.current_game?.game || 'None';

            if (user.twitch_tokens?.streamer?.twitch_user_id) {
                try {
                    const { fetchStreamInfo } = await import('../twitch-eventsub-manager.js');
                    const streamInfo = await fetchStreamInfo(user.user_id);

                    if (streamInfo && streamInfo.success && streamInfo.isLive) {
                        // Update streamStatus with actual values
                        streamStatus = {
                            online: true,
                            title: streamInfo.data.title || 'Untitled Stream',
                            game: streamInfo.data.gameName || 'Unknown Game',
                            viewers: streamInfo.data.viewerCount || 0,
                            duration: streamInfo.data.duration || 'Just started',
                            thumbnail: streamInfo.data.thumbnailUrl || null
                        };
                    }

                    followerCount = user.current_followers || 0;
                } catch (error) {
                    logger.error("Web", `Error fetching stream info: ${error.message}`);
                }
            }

            // Log complete data being sent to template
            logger.log("Web", `Rendering dashboard with streamStatus: ${JSON.stringify(streamStatus)}`);

            return reply.view('dashboard.njk', {
                pageTitle: 'Dashboard',
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
                lastGame
            });
        } catch (error) {
            logger.error("Web", `Error serving dashboard: ${error.message}`);
            return reply.code(500).send('Error loading dashboard');
        }
    });

    // Character editor route
    fastify.get('/character', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;

            // Load character data from files
            const characterPersonality = await loadTextContent(user.user_id, 'character_personality');
            const characterDescription = await loadTextContent(user.user_id, 'character_card');
            const characterExamples = await loadTextContent(user.user_id, 'examples');

            return reply.view('character.njk', {
                pageTitle: 'Character Editor',
                characterActive: true,
                user,
                character: user,
                characterPersonality,
                characterDescription,
                characterExamples
            });
        } catch (error) {
            logger.error("Web", `Error serving character editor: ${error.message}`);
            return reply.code(500).send('Error loading character editor');
        }
    });

    // World editor route
    fastify.get('/world', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;

            // Load world data from files
            const worldInfo = await loadTextContent(user.user_id, 'world_lore');
            const playerInfo = await loadTextContent(user.user_id, 'player_info');
            const scenario = await loadTextContent(user.user_id, 'scenario');

            // Format commands list and aux bots for textarea
            const commandsList = user.commands_list ? user.commands_list.join('\n') : '';
            const auxBots = user.aux_bots ? user.aux_bots.join('\n') : '';

            return reply.view('world.njk', {
                pageTitle: 'World Editor',
                worldActive: true,
                user,
                character: user,
                worldInfo,
                playerInfo,
                scenario,
                commandsList,
                auxBots
            });
        } catch (error) {
            logger.error("Web", `Error serving world editor: ${error.message}`);
            return reply.code(500).send('Error loading world editor');
        }
    });

    // Help page route
    fastify.get('/help', { preHandler: requireAuth }, async (request, reply) => {
        try {
            return reply.view('help.njk', {
                pageTitle: 'Help & Documentation',
                helpActive: true
            });
        } catch (error) {
            logger.error("Web", `Error serving help page: ${error.message}`);
            return reply.code(500).send(`Error loading help page: ${error.message}`);
        }
    });

    // Gallery route
    fastify.get('/gallery', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;

            // Load all character presets
            const presets = await loadAllPresets();

            // Add placeholder images for presets that don't have one
            presets.forEach(preset => {
                if (!preset.image) {
                    preset.image = '/api/placeholder/200/200';
                }
            });

            return reply.view('gallery.njk', {
                pageTitle: 'Character Gallery',
                galleryActive: true,
                presets,
                user
            });
        } catch (error) {
            logger.error("Web", `Error serving gallery: ${error.message}`);
            return reply.code(500).send('Error loading character gallery');
        }
    });

    fastify.get('/gallery/:characterId', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;
            const { characterId } = request.params;

            // Load the character preset data
            const characterData = await loadPreset(characterId);

            if (!characterData) {
                logger.warn("Web", `Character preset '${characterId}' not found`);
                return reply.redirect('/web/gallery');
            }

            // Add placeholder image if missing
            if (!characterData.image) {
                characterData.image = '/api/placeholder/200/200';
            }

            return reply.view('character-details.njk', {
                pageTitle: characterData.name,
                galleryActive: true,
                character: characterData,
                user
            });
        } catch (error) {
            logger.error("Web", `Error serving character details: ${error.message}`);
            return reply.code(500).send('Error loading character details');
        }
    });

    // Authentication routes
    fastify.get('/auth/login', async (request, reply) => {
        return reply.view('login.njk', {
            pageTitle: 'Login',
            error: request.query.error || null
        });
    });

    fastify.get('/auth/logout', async (request, reply) => {
        reply.clearCookie('enspira_session');
        return reply.redirect('/web/auth/login');
    });

    // Redirect root to dashboard
    fastify.get('/', (request, reply) => {
        return reply.redirect('/web/dashboard');
    });

    // POST handlers for form submissions

    // Character personality update endpoint
    fastify.post('/character/personality', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;

            // Extract values safely from form data
            const botName = getFieldValue(request.body.bot_name);
            const personality = getFieldValue(request.body.personality);

            // Update bot name in user record
            await updateUserParameter(user.user_id, 'bot_name', botName);

            // Save personality to file
            const success = await saveTextContent(user.user_id, 'character_personality', personality);

            if (success) {
                reply.send({ success: true, message: 'Personality updated successfully' });
            } else {
                reply.code(500).send({ success: false, error: 'Failed to save personality' });
            }
        } catch (error) {
            logger.error("Web", `Error updating personality: ${error.message}`);
            reply.code(500).send({ success: false, error: 'An error occurred while updating personality' });
        }
    });

    // Character description update endpoint
    fastify.post('/character/description', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;

            // Extract values safely from form data
            const description = getFieldValue(request.body.description);
            const botTwitch = getFieldValue(request.body.bot_twitch);

            // Save description to file
            const success = await saveTextContent(user.user_id, 'character_card', description);

            // Update bot_twitch if provided
            if (botTwitch) {
                await updateUserParameter(user.user_id, 'bot_twitch', botTwitch);
            }

            if (success) {
                reply.send({ success: true, message: 'Description updated successfully' });
            } else {
                reply.code(500).send({ success: false, error: 'Failed to save description' });
            }
        } catch (error) {
            logger.error("Web", `Error updating description: ${error.message}`);
            reply.code(500).send({ success: false, error: 'An error occurred while updating description' });
        }
    });

    // Character examples update endpoint
    fastify.post('/character/examples', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;

            // Extract value safely from form data
            const examples = getFieldValue(request.body.examples);

            // Save examples to file
            const success = await saveTextContent(user.user_id, 'examples', examples);

            if (success) {
                reply.send({ success: true, message: 'Examples updated successfully' });
            } else {
                reply.code(500).send({ success: false, error: 'Failed to save examples' });
            }
        } catch (error) {
            logger.error("Web", `Error updating examples: ${error.message}`);
            reply.code(500).send({ success: false, error: 'An error occurred while updating examples' });
        }
    });

    // World info update endpoint
    fastify.post('/world/info', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;

            // Extract values safely from form data
            const worldInfo = getFieldValue(request.body.world_info);
            const weatherEnabled = getFieldValue(request.body.weather_enabled);

            // Update weather flag in user record
            await updateUserParameter(user.user_id, 'weather', weatherEnabled === 'true');

            // Save world info to file
            const success = await saveTextContent(user.user_id, 'world_lore', worldInfo);

            if (success) {
                reply.send({ success: true, message: 'World information updated successfully' });
            } else {
                reply.code(500).send({ success: false, error: 'Failed to save world information' });
            }
        } catch (error) {
            logger.error("Web", `Error updating world info: ${error.message}`);
            reply.code(500).send({ success: false, error: 'An error occurred while updating world information' });
        }
    });

    // Player info update endpoint
    fastify.post('/world/player', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;

            // Extract values safely from form data
            const playerInfo = getFieldValue(request.body.player_info);
            const commandsList = getFieldValue(request.body.commands_list);

            // Update commands list in user record if provided
            if (commandsList) {
                const commandsArray = commandsList.split('\n')
                    .map(cmd => cmd.trim())
                    .filter(cmd => cmd.length > 0);
                await updateUserParameter(user.user_id, 'commands_list', commandsArray);
            }

            // Save player info to file
            const success = await saveTextContent(user.user_id, 'player_info', playerInfo);

            if (success) {
                reply.send({ success: true, message: 'Player information updated successfully' });
            } else {
                reply.code(500).send({ success: false, error: 'Failed to save player information' });
            }
        } catch (error) {
            logger.error("Web", `Error updating player info: ${error.message}`);
            reply.code(500).send({ success: false, error: 'An error occurred while updating player information' });
        }
    });

    // Scenario update endpoint
    fastify.post('/world/scenario', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;

            // Extract values safely from form data
            const scenario = getFieldValue(request.body.scenario);
            const auxBots = getFieldValue(request.body.aux_bots);

            // Update aux bots list in user record if provided
            if (auxBots) {
                const auxBotsArray = auxBots.split('\n')
                    .map(bot => bot.trim())
                    .filter(bot => bot.length > 0);
                await updateUserParameter(user.user_id, 'aux_bots', auxBotsArray);
            }

            // Save scenario to file
            const success = await saveTextContent(user.user_id, 'scenario', scenario);

            if (success) {
                reply.send({ success: true, message: 'Scenario updated successfully' });
            } else {
                reply.code(500).send({ success: false, error: 'Failed to save scenario' });
            }
        } catch (error) {
            logger.error("Web", `Error updating scenario: ${error.message}`);
            reply.code(500).send({ success: false, error: 'An error occurred while updating scenario' });
        }
    });

    // Bot configuration update endpoint
    fastify.post('/world/bot-config', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;

            // Extract values safely from form data
            const commandsList = getFieldValue(request.body.commands_list);
            const auxBots = getFieldValue(request.body.aux_bots);

            // Update commands list in user record
            const commandsArray = commandsList.split('\n')
                .map(cmd => cmd.trim())
                .filter(cmd => cmd.length > 0);

            await updateUserParameter(user.user_id, 'commands_list', commandsArray);

            // Update aux bots list in user record
            const auxBotsArray = auxBots.split('\n')
                .map(bot => bot.trim())
                .filter(bot => bot.length > 0);

            await updateUserParameter(user.user_id, 'aux_bots', auxBotsArray);

            reply.send({ success: true, message: 'Bot configuration updated successfully' });
        } catch (error) {
            logger.error("Web", `Error updating bot configuration: ${error.message}`);
            reply.code(500).send({ success: false, error: 'An error occurred while updating bot configuration' });
        }
    });

    // Apply character preset
    fastify.post('/gallery/:characterId/use', { preHandler: requireAuth }, async (request, reply) => {
        const { user } = request;
        const { characterId } = request.params;

        try {
            const preset = await loadPreset(characterId);
            if (!preset) {
                return reply.code(404).send({ success: false, error: 'Character preset not found' });
            }

            logger.log("Web", `Applying character preset: ${preset.name} (${characterId}) for user ${user.user_id}`);

            // Extract the internal format for saving to user files
            const personalityContent = preset.personality.internalFmt || preset.personality || '';
            const descriptionContent = preset.char_description.internalFmt || preset.char_description || '';

            // Apply the preset data to the user
            const nameUpdate = await updateUserParameter(user.user_id, 'bot_name', preset.name);

            // Save personality and description to files
            const personalitySave = await saveTextContent(user.user_id, 'character_personality', personalityContent);
            const descriptionSave = await saveTextContent(user.user_id, 'character_card', descriptionContent);

            // Make sure bot_twitch is set if present in the preset
            if (preset.bot_twitch) {
                await updateUserParameter(user.user_id, 'bot_twitch', preset.bot_twitch);
            }

            if (nameUpdate && personalitySave && descriptionSave) {
                logger.log("Web", `Successfully applied preset '${characterId}' for user ${user.user_id}`);

                // Respond with success and a redirect URL for the frontend handler
                return reply.send({
                    success: true,
                    message: `Character preset "${preset.name}" applied successfully!`,
                    redirect: '/web/character'
                });
            } else {
                logger.error("Web", `Failed to fully apply preset '${characterId}' for user ${user.user_id}`);
                return reply.code(500).send({
                    success: false,
                    error: 'Failed to save all character data'
                });
            }
        } catch (error) {
            logger.error("Web", `Error applying preset '${characterId}' for user ${user.user_id}: ${error.message}`);
            return reply.code(500).send({
                success: false,
                error: 'An error occurred while applying the preset'
            });
        }
    });

    logger.log("Web", "Web routes registered successfully");
}

export default webRoutes;