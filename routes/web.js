// routes/web.js
import fs from 'fs-extra';
import path from 'path';
import { returnAuthObject, updateUserParameter } from '../api-helper.js';
import { logger } from '../create-global-logger.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { returnRecentChats } from '../ai-logic.js';
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

    // Handle basic variable substitution
    const variableRegex = /\{\{([^}]+)\}\}/g;
    rendered = rendered.replace(variableRegex, (match, variable) => {
        // Check if this is a simple assignment (like {{pageTitle = "Dashboard"}})
        if (variable.includes('=')) {
            const [varName, varValue] = variable.split('=').map(s => s.trim());
            data[varName] = varValue.replace(/"/g, ''); // Remove quotes if present
            return ''; // Remove the assignment from output
        }

        // Skip if this is part of a conditional - we'll handle those separately
        if (variable.startsWith('#if') || variable.startsWith('/if') ||
            variable.startsWith('#else') || variable.startsWith('else')) {
            return match;
        }

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

    // Handle conditional blocks - be sure this captures the right patterns
    const conditionalRegex = /\{\{#if ([^}]+)\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g;
    rendered = rendered.replace(conditionalRegex, (match, condition, ifTrue, ifFalse) => {
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

    // Handle simple conditionals without else
    const simpleConditionalRegex = /\{\{#if ([^}]+)\}\}([\s\S]*?)\{\{\/if\}\}/g;
    rendered = rendered.replace(simpleConditionalRegex, (match, condition, ifTrue) => {
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

        return value ? ifTrue : '';
    });

    // Handle unless conditionals (inverse of if)
    const unlessConditionalRegex = /\{\{#unless ([^}]+)\}\}([\s\S]*?)\{\{\/unless\}\}/g;
    rendered = rendered.replace(unlessConditionalRegex, (match, condition, ifFalse) => {
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

        return value ? '' : ifFalse;
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
        // Read the layout template
        const layoutPath = path.join(process.cwd(), 'pages', 'layout.html');
        let layoutTemplate = await fs.readFile(layoutPath, 'utf8');

        // Render the content first
        const renderedContent = renderTemplate(content, data);

        // Add the content to the data object
        data.mainContent = renderedContent;

        // Render the layout with the content
        return renderTemplate(layoutTemplate, data);
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

/**
 * Saves text content to a file
 * @param {string} userId - The user ID
 * @param {string} fileName - The file name
 * @param {string} content - The content to save
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
async function saveTextContent(userId, fileName, content) {
    try {
        const filePath = path.join(process.cwd(), 'world_info', userId, `${fileName}.txt`);

        // Create directory if it doesn't exist
        await fs.ensureDir(path.join(process.cwd(), 'world_info', userId));

        // Write content to file
        await fs.writeFile(filePath, content);
        return true;
    } catch (error) {
        logger.error("Web", `Error saving ${fileName} for user ${userId}: ${error.message}`);
        return false;
    }
}

// Import verifySessionToken function from existing auth code
// This assumes the function is exported elsewhere
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
        return reply.redirect('/web/auth/login');  // Updated path to match your new route structure
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
            const streamerName = streamerConnected ? user.twitch_tokens.streamer.twitch_display_name : '';
            const botName = botConnected ? user.twitch_tokens.bot.twitch_display_name : '';

            // Simple stats - just set to 0 for now
            let chatCount = 0;
            try {
                const recentChats = await returnRecentChats(user.user_id, false, true);
                chatCount = recentChats?.length || 0;
            } catch (error) {
                logger.error("Web", `Error fetching chat stats: ${error.message}`);
            }

            // Then create the stats object with actual data
            const stats = {
                chatMessages: chatCount,
            };

            // Check if online (mocked for now - could implement real status check later)
            const isOnline = false;

            // Simplified data object with only what we need
            const templateData = {
                user: {
                    display_name: user.display_name || user.user_name,
                },
                streamerConnected,
                botConnected,
                streamerName,
                botName,
                stats,
                isOnline
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

            // Render the page
            const renderedPage = await renderPage(worldTemplate, {
                user,
                character: user,
                worldInfo,
                playerInfo,
                scenario,
                commandsList,
                auxBots
            });

            reply.type('text/html').send(renderedPage);
        } catch (error) {
            logger.error("Web", `Error serving world editor: ${error.message}`);
            reply.code(500).send('Error loading world editor');
        }
    });

    // Character personality update endpoint
    fastify.post('/api/v1/character/personality', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;
            const { bot_name, personality } = request.body;

            // Update bot name in user record
            await updateUserParameter(user.user_id, 'bot_name', bot_name);

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
    fastify.post('/api/v1/character/description', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;
            const { description } = request.body;
    
            // Save description to file
            const success = await saveTextContent(user.user_id, 'character_card', description);
    
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
    fastify.post('/api/v1/character/examples', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;
            const { examples } = request.body;

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
    fastify.post('/api/v1/world/info', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;
            const { world_info, weather_enabled } = request.body;

            // Update weather flag in user record
            await updateUserParameter(user.user_id, 'weather', weather_enabled === 'true');

            // Save world info to file
            const success = await saveTextContent(user.user_id, 'world_lore', world_info);

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
    fastify.post('/api/v1/world/player', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;
            const { player_info } = request.body;

            // Save player info to file
            const success = await saveTextContent(user.user_id, 'player_info', player_info);

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
    fastify.post('/api/v1/world/scenario', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;
            const { scenario } = request.body;

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

    fastify.post('/api/v1/world/bot-config', { preHandler: requireAuth }, async (request, reply) => {
        try {
            const user = request.user;
            const { commands_list, aux_bots } = request.body;

            // Update commands list in user record
            const commandsArray = commands_list.split('\n')
                .map(cmd => cmd.trim())
                .filter(cmd => cmd.length > 0);

            await updateUserParameter(user.user_id, 'commands_list', commandsArray);

            // Update aux bots list in user record
            const auxBotsArray = aux_bots.split('\n')
                .map(bot => bot.trim())
                .filter(bot => bot.length > 0);

            await updateUserParameter(user.user_id, 'aux_bots', auxBotsArray);

            reply.send({ success: true, message: 'Bot configuration updated successfully' });
        } catch (error) {
            logger.error("Web", `Error updating bot configuration: ${error.message}`);
            reply.code(500).send({ success: false, error: 'An error occurred while updating bot configuration' });
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

    fastify.get('/auth/logout', async (request, reply) => {
        reply.clearCookie('enspira_session');
        return reply.redirect('/web/auth/login');  // Updated path
    });

    // Redirect root to dashboard
    fastify.get('/', (request, reply) => {
        reply.redirect('/web/dashboard');
    });

    logger.log("Web", "Web routes registered successfully");
}

export default webRoutes;