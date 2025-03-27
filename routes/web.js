// routes/web.js
import fs from 'fs-extra';
import path from 'path';
import { returnAuthObject, updateUserParameter } from '../api-helper.js';
import { logger } from '../create-global-logger.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { returnRecentChats } from '../ai-logic.js';
import { loadPreset, loadAllPresets } from './v1.js';
// Get the directory name properly in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Renders a template with provided data
 * @param {string} templateContent - The template content
 * @param {object} data - Data to inject into the template
 * @returns {string} - The rendered HTML
 */
function renderTemplate(templateContent, data) {
    // Simple template rendering with handlebars-like syntax
    let rendered = templateContent;

    // Handle each templating feature in the correct order to prevent interference

    // 1. Handle simple assignments first (like {{pageTitle = "Dashboard"}})
    const assignmentRegex = /\{\{([^}]+?)\s*=\s*(['"]?)([^'"]+)\2\}\}/g;
    rendered = rendered.replace(assignmentRegex, (match, varName, quote, varValue) => {
        data[varName.trim()] = varValue.trim();
        return ''; // Remove the assignment from output
    });

    // 2. Handle #each loops
    const eachRegex = /\{\{#each ([^}]+)\}\}([\s\S]*?)\{\{\/each\}\}/g;
    rendered = rendered.replace(eachRegex, (match, arrayPath, template) => {
        // Get the array to iterate over
        const path = arrayPath.trim().split('.');
        let array = data;
        
        for (const key of path) {
            if (array === undefined || array === null) return '';
            array = array[key];
        }
        
        if (!Array.isArray(array)) return '';
        
        // Build result by applying the template to each item
        return array.map(item => {
            // Create a temporary data object with 'this' pointing to the current item
            const itemData = { 
                ...data,
                this: item,
                // Also add the item properties directly to the root for easier access
                // This supports {{name}} instead of requiring {{this.name}}
                ...item 
            };
            
            // Apply the template to the current item
            let itemTemplate = template;
            
            // Replace item properties
            const itemRegex = /\{\{([^}]+)\}\}/g;
            itemTemplate = itemTemplate.replace(itemRegex, (m, variable) => {
                // Skip if this is a conditional or other special case
                if (variable.startsWith('#') || variable.startsWith('/')) {
                    return m;
                }
                
                // Support both {{this.propName}} and {{propName}}
                const varPath = variable.trim().split('.');
                let value;
                
                if (varPath[0] === 'this') {
                    // Handle {{this.property}}
                    value = item;
                    for (let i = 1; i < varPath.length; i++) {
                        if (value === undefined || value === null) return '';
                        value = value[varPath[i]];
                    }
                } else {
                    // Handle {{property}} directly
                    // First try to get it from the item
                    value = item[varPath[0]];
                    
                    // If not found in item, try the parent data object
                    if (value === undefined || value === null) {
                        value = data;
                        for (const part of varPath) {
                            if (value === undefined || value === null) return '';
                            value = value[part];
                        }
                    }
                }
                
                return value !== undefined && value !== null ? value : '';
            });
            
            return itemTemplate;
        }).join('');
    });

    // 3. Handle if/else conditionals
    const conditionalRegex = /\{\{#if ([^}]+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g;
    rendered = rendered.replace(conditionalRegex, (match, condition, ifTrue, ifFalse = '') => {
        // Evaluate the condition from data object
        const path = condition.trim().split('.');
        let value = data;

        for (const key of path) {
            if (value === undefined || value === null) {
                value = false;
                break;
            }
            value = value[key];
        }

        return value ? ifTrue : ifFalse;
    });

    // 4. Handle unless conditionals (inverse of if)
    const unlessRegex = /\{\{#unless ([^}]+)\}\}([\s\S]*?)\{\{\/unless\}\}/g;
    rendered = rendered.replace(unlessRegex, (match, condition, content) => {
        // Evaluate the condition from data object
        const path = condition.trim().split('.');
        let value = data;

        for (const key of path) {
            if (value === undefined || value === null) {
                value = false;
                break;
            }
            value = value[key];
        }

        return value ? '' : content;
    });

    // 5. Finally, handle basic variable substitution
    const variableRegex = /\{\{([^}#\/]+?)\}\}/g;
    rendered = rendered.replace(variableRegex, (match, variable) => {
        // Handle nested properties using a path string (e.g., "user.name")
        const path = variable.trim().split('.');
        let value = data;

        for (const key of path) {
            if (value === undefined || value === null) return '';
            value = value[key];
        }

        // Return empty string for undefined/null values
        return value !== undefined && value !== null ? value : '';
    });

    return rendered;
}

/**
 * Renders a page using the layout template and provided content
 * @param {string} content - Content to inject into the layout
 * @param {object} data - Data to use for template rendering
 * @returns {Promise<string>} - The fully rendered HTML page
 */
async function renderPage(content, data) {
    try {
        // Ensure data has default values for expected template variables
        const defaultData = {
            // Default empty values for template variables
            extraScripts: '',
            extraStyles: '',
            dashboardActive: '',
            characterActive: '',
            worldActive: '',
            galleryActive: '',
            twitchActive: '',
            pageTitle: 'Enspira'
        };

        // Merge default data with provided data, ensuring defaults don't override provided values
        const mergedData = { ...defaultData, ...data };

        // Read the layout template
        const layoutPath = path.join(process.cwd(), 'pages', 'layout.html');
        let layoutTemplate = await fs.readFile(layoutPath, 'utf8');

        // Render the content first with merged data
        const renderedContent = renderTemplate(content, mergedData);

        // Add the content to the data object
        mergedData.mainContent = renderedContent;

        // Render the layout with the content and merged data
        return renderTemplate(layoutTemplate, mergedData);
    } catch (error) {
        logger.error("Web", `Error rendering page: ${error.message}`);
        throw error;
    }
}

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
    logger.log("Auth", `Request cookies: ${JSON.stringify(request.cookies || {})}`);

    const sessionToken = request.cookies?.enspira_session;

    if (!sessionToken) {
        logger.log("Auth", "No session token found, redirecting to login");
        return reply.redirect('/web/auth/login');
    }

    try {
        // Verify and decode the session token
        const decoded = verifySessionToken(sessionToken);

        if (!decoded || !decoded.userId) {
            // Invalid token
            reply.clearCookie('enspira_session');
            return reply.redirect('/web/auth/login');
        }

        // Get user from database
        const user = await returnAuthObject(decoded.userId);

        if (!user) {
            // User doesn't exist
            reply.clearCookie('enspira_session');
            return reply.redirect('/web/auth/login');
        }

        // Add user to request for use in route handlers
        request.user = user;

        // Continue to route handler
        return;
    } catch (error) {
        logger.error("Auth", `Session validation error: ${error.message}`);
        reply.clearCookie('enspira_session');
        return reply.redirect('/web/auth/login');
    }
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
    
            // Get Twitch connection status - be more defensive with optional chaining
            const streamerConnected = !!user?.twitch_tokens?.streamer?.access_token;
            const botConnected = !!user?.twitch_tokens?.bot?.access_token;
    
            // Get streamer and bot names - only if connected
            const streamerName = streamerConnected ? (user.twitch_tokens.streamer.twitch_display_name || 'Unknown') : '';
            const botName = botConnected ? (user.twitch_tokens.bot.twitch_display_name || 'Unknown') : '';
    
            // Simple stats - just set to 0 for now
            let chatCount = 0;
            try {
                const recentChats = await returnRecentChats(user.user_id, false, true);
                chatCount = recentChats?.length || 0;
            } catch (error) {
                logger.error("Web", `Error fetching chat stats: ${error.message}`);
            }
    
            // Create the stats object with actual data
            const stats = {
                chatMessages: chatCount,
            };
    
            // Get stream status data - make sure we set a default structure
            let streamStatus = {
                online: false
            };
    
            let followerCount = user.current_followers || 0;
            let lastGame = null;
    
            if (user.twitch_tokens?.streamer?.twitch_user_id) {
                try {
                    // Import and use the fetchStreamInfo function
                    const { fetchStreamInfo } = await import('../twitch-eventsub-manager.js');
                    const streamInfo = await fetchStreamInfo(user.user_id);
    
                    if (streamInfo && streamInfo.success && streamInfo.isLive) {
                        // Stream is online, format the data for display
                        streamStatus = {
                            online: true,
                            title: streamInfo.data.title || user.stream_status?.title || 'Untitled Stream',
                            game: streamInfo.data.gameName || user.current_game?.game || 'Unknown Game',
                            viewers: streamInfo.data.viewerCount || user.current_viewers || 0,
                            duration: streamInfo.data.duration || 'Just started',
                            thumbnail: streamInfo.data.thumbnailUrl || null
                        };
                    } else {
                        // Stream is offline, ensure the status object is properly set
                        streamStatus = {
                            online: false
                        };
    
                        // Get last game played if available
                        if (user.current_game && user.current_game.game) {
                            lastGame = user.current_game.game;
                        }
                    }
    
                    // Get follower count
                    followerCount = user.current_followers || 0;
                } catch (error) {
                    logger.error("Web", `Error fetching stream info: ${error.message}`);
                    // Ensure we have a valid streamStatus object even if there's an error
                    streamStatus = { online: false };
                }
            }
    
            // Log the streamStatus for debugging
            logger.log("Web", `Stream status for dashboard: ${JSON.stringify(streamStatus)}`);
    
            // Simplified data object with only what we need
            const templateData = {
                user: {
                    display_name: user.display_name || user.user_name,
                },
                dashboardActive: 'active',
                streamerConnected,
                botConnected,
                streamerName,
                botName,
                stats,
                streamStatus,
                followerCount,
                lastGame
            };
    
            // Read dashboard template
            const dashboardTemplate = await fs.readFile(path.join(process.cwd(), 'pages', 'dashboard.html'), 'utf8');
    
            // Render the page with only the necessary data
            const renderedPage = await renderPage(dashboardTemplate, templateData);
    
            reply.type('text/html').send(renderedPage);
        } catch (error) {
            logger.error("Web", `Error serving dashboard: ${error.message}`);
            reply.code(500).send('Error loading dashboard');
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

            // Read character editor template
            const characterPath = path.join(process.cwd(), 'pages', 'character.html');
            let characterTemplate;

            try {
                await fs.access(characterPath);
                characterTemplate = await fs.readFile(characterPath, 'utf8');
            } catch (error) {
                logger.warn("Web", `Character template not found at ${characterPath}, using fallback`);
                characterTemplate = `<h1>Character Editor</h1>
                            <p>Template files are being set up.</p>`;
            }

            // Render the page
            const renderedPage = await renderPage(characterTemplate, {
                characterActive: 'active',
                user,
                character: user,
                characterPersonality,
                characterDescription,
                characterExamples
            });

            reply.type('text/html').send(renderedPage);
        } catch (error) {
            logger.error("Web", `Error serving character editor: ${error.message}`);
            reply.code(500).send('Error loading character editor');
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

            // Read the character details template
            const detailsTemplatePath = path.join(process.cwd(), 'pages', 'character-details.html');
            const detailsTemplate = await fs.readFile(detailsTemplatePath, 'utf8');

            // Render the page with character data
            const renderedPage = await renderPage(detailsTemplate, {
                galleryActive: 'active',
                character: characterData,
                user
            });

            reply.type('text/html').send(renderedPage);
        } catch (error) {
            logger.error("Web", `Error serving character details: ${error.message}`);
            reply.code(500).send('Error loading character details');
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

            // Read world editor template
            const worldPath = path.join(process.cwd(), 'pages', 'world.html');
            let worldTemplate;

            try {
                await fs.access(worldPath);
                worldTemplate = await fs.readFile(worldPath, 'utf8');
            } catch (error) {
                logger.warn("Web", `World template not found at ${worldPath}, using fallback`);
                worldTemplate = `<h1>World Editor</h1>
                          <p>Template files are being set up.</p>`;
            }

            // Render the page with explicitly set extraScripts variable
            const renderedPage = await renderPage(worldTemplate, {
                worldActive: 'active',
                user,
                character: user,
                worldInfo,
                playerInfo,
                scenario,
                commandsList,
                auxBots,
                extraScripts: '' // Explicitly set this to prevent template errors
            });

            reply.type('text/html').send(renderedPage);
        } catch (error) {
            logger.error("Web", `Error serving world editor: ${error.message}`);
            reply.code(500).send('Error loading world editor');
        }
    });

    fastify.get('/help', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const helpPath = path.join(process.cwd(), 'pages', 'help.html');

            let helpTemplate;

            try {
                await fs.access(helpPath);
                helpTemplate = await fs.readFile(helpPath, 'utf8');
            } catch (error) {
                logger.warn("Web", `Help template not found at ${helpPath}, using fallback`);
                helpTemplate = `<h1>Help Section</h1>
                          <p>Template files are being set up.</p>`;
            }

            // Render the page with explicitly set extraScripts variable
            const renderedPage = await renderPage(helpTemplate, {});

            reply.type('text/html').send(renderedPage);
        } catch (error) {
            logger.error("Web", `Error serving help page: ${error.message}`);
            reply.code(500).send(`Error loading help page. Error: ${error.message}`);
        }
    });

    // Authentication routes
    fastify.get('/auth/login', async (request, reply) => {
        const loginForm = `<!doctype html>
    <html>
      <head>
        <title>Enspira - Login</title>
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
    });

    fastify.get('/auth/logout', async (request, reply) => {
        reply.clearCookie('enspira_session');
        return reply.redirect('/web/auth/login');
    });

    // Redirect root to dashboard
    fastify.get('/', (request, reply) => {
        reply.redirect('/web/dashboard');
    });
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

            // Read gallery template file
            const galleryPath = path.join(process.cwd(), 'pages', 'gallery.html');
            const galleryTemplate = await fs.readFile(galleryPath, 'utf8');

            // Render the page with presets data
            const renderedPage = await renderPage(galleryTemplate, {
                galleryActive: 'active',
                presets,
                user
            });

            reply.type('text/html').send(renderedPage);
        } catch (error) {
            logger.error("Web", `Error serving gallery: ${error.message}`);
            reply.code(500).send('Error loading character gallery');
        }
    });

    // Route handler for using a character preset
    fastify.post('/gallery/:character/use', { preHandler: requireAuth }, async (req, res) => {
        try {
            const characterName = req.params.character;
            const characterData = await loadPreset(characterName);

            if (!characterData) {
                return res.status(404).json({ error: 'Character not found' });
            }

            // Here you would save the character data to the user's profile or session
            // This depends on how your user data is stored

            // For example, if using sessions:
            req.session.selectedCharacter = characterData;

            res.redirect('/dashboard'); // Redirect to the main dashboard with the character selected
        } catch (error) {
            console.error('Error using character preset:', error);
            res.status(500).send('Error applying character preset');
        }
    });
    logger.log("Web", "Web routes registered successfully");
}



export default webRoutes;