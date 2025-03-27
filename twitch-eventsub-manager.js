import crypto from 'crypto';
import axios from 'axios';
import { returnAPIKeys, returnAuthObject, updateUserParameter, ensureParameterPath } from './api-helper.js';
import { retrieveConfigValue } from './config-helper.js';
import { logger } from './create-global-logger.js';

// EventSub subscription definitions with accurate condition requirements
const SUBSCRIPTION_TYPES = [
    // Version 1 endpoints - Standard events
    {
        type: 'channel.update',
        version: '1',
        condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
        requiredScopes: ['channel:read:stream_key'],
        tokenType: 'streamer'
    },
    {
        type: 'channel.subscribe',
        version: '1',
        condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
        requiredScopes: ['channel:read:subscriptions'],
        tokenType: 'streamer'
    },
    {
        type: 'channel.subscription.gift',
        version: '1',
        condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
        requiredScopes: ['channel:read:subscriptions'],
        tokenType: 'streamer'
    },
    {
        type: 'channel.subscription.message',
        version: '1',
        condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
        requiredScopes: ['channel:read:subscriptions'],
        tokenType: 'streamer'
    },
    {
        type: 'channel.cheer',
        version: '1',
        condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
        requiredScopes: ['bits:read'],
        tokenType: 'streamer'
    },
    {
        type: 'channel.raid',
        version: '1',
        condition: (broadcasterId) => ({ to_broadcaster_user_id: broadcasterId }),
        requiredScopes: [],
        tokenType: 'app'
    },
    {
        type: 'channel.channel_points_custom_reward_redemption.add',
        version: '1',
        condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
        requiredScopes: ['channel:read:redemptions'],
        tokenType: 'streamer'
    },
    {
        type: 'channel.charity_campaign.donate',
        version: '1',
        condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
        requiredScopes: ['channel:read:charity'],
        tokenType: 'streamer'
    },
    {
        type: 'channel.charity_campaign.progress',
        version: '1',
        condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
        requiredScopes: ['channel:read:charity'],
        tokenType: 'streamer'
    },
    {
        type: 'channel.hype_train.begin',
        version: '1',
        condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
        requiredScopes: ['channel:read:hype_train'],
        tokenType: 'streamer'
    },
    {
        type: 'channel.hype_train.progress',
        version: '1',
        condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
        requiredScopes: ['channel:read:hype_train'],
        tokenType: 'streamer'
    },
    {
        type: 'channel.hype_train.end',
        version: '1',
        condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
        requiredScopes: ['channel:read:hype_train'],
        tokenType: 'streamer'
    },
    {
        type: 'stream.online',
        version: '1',
        condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
        requiredScopes: [],
        tokenType: 'app'
    },
    {
        type: 'stream.offline',
        version: '1',
        condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId }),
        requiredScopes: [],
        tokenType: 'app'
    },

    // Version 2 endpoints
    {
        type: 'channel.follow',
        version: '2',
        condition: (broadcasterId) => ({
            broadcaster_user_id: broadcasterId,
            moderator_user_id: broadcasterId // Using broadcaster as moderator for simplicity
        }),
        requiredScopes: ['moderator:read:followers'],
        tokenType: 'streamer'
    },
    {
        type: 'channel.update',
        version: '2',
        condition: (broadcasterId) => ({
            broadcaster_user_id: broadcasterId,
            moderator_user_id: broadcasterId
        }),
        requiredScopes: ['channel:read:stream_key'],
        tokenType: 'streamer'
    },
    
    // Beta endpoints - Only include if broadcaster has appropriate permissions
    {
        type: 'channel.guest_star_session.begin',
        version: 'beta',
        condition: (broadcasterId) => ({
            broadcaster_user_id: broadcasterId,
            moderator_user_id: broadcasterId
        }),
        requiredScopes: ['moderator:read:guest_star', 'moderator:manage:guest_star'],
        tokenType: 'streamer',
        optional: true
    },
    {
        type: 'channel.guest_star_guest.update',
        version: 'beta',
        condition: (broadcasterId) => ({
            broadcaster_user_id: broadcasterId,
            moderator_user_id: broadcasterId
        }),
        requiredScopes: ['moderator:read:guest_star'],
        tokenType: 'streamer',
        optional: true
    }
];


/**
 * Get an app access token for Twitch API calls that require it
 * @returns {Promise<string>} The app access token
 */
export async function getAppAccessToken() {
    try {
        // Check for cached token first
        if (global.twitchAppToken && global.twitchAppTokenExpiry && Date.now() < global.twitchAppTokenExpiry) {
            return global.twitchAppToken;
        }

        logger.log("Twitch", "Getting new app access token");

        const clientId = await retrieveConfigValue("twitch.clientId");
        const clientSecret = await retrieveConfigValue("twitch.clientSecret");

        if (!clientId || !clientSecret) {
            throw new Error("Missing Twitch client ID or secret in configuration");
        }

        const axios = (await import('axios')).default;
        const response = await axios.post(
            'https://id.twitch.tv/oauth2/token',
            new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'client_credentials'
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const { access_token, expires_in } = response.data;

        // Cache the token with a safety margin
        global.twitchAppToken = access_token;
        global.twitchAppTokenExpiry = Date.now() + (expires_in * 900); // 90% of expiry time

        logger.log("Twitch", "Successfully obtained app access token");
        return access_token;
    } catch (error) {
        logger.error("Twitch", `Failed to get app access token: ${error.message}`);
        throw error;
    }
}

/**
 * Main function to register EventSub for all users
 * @returns {Promise<{success: number, failures: number}>}
 */
export async function registerAllUsersEventSub() {
    try {
        logger.log("Twitch", "Starting automatic EventSub registration for all users");

        // Get all users from auth system
        const users = await returnAPIKeys();
        let successCount = 0;
        let failureCount = 0;

        // Process each user sequentially to avoid rate limits
        for (const user of users) {
            try {
                // Skip users without any Twitch tokens
                if (!user.twitch_tokens) {
                    logger.log("Twitch", `Skipping EventSub for ${user.user_id}: No Twitch integration`);
                    continue;
                }

                // We need the streamer account for EventSub
                if (!user.twitch_tokens.streamer || !user.twitch_tokens.streamer.access_token) {
                    logger.log("Twitch", `Skipping EventSub for ${user.user_id}: No streamer account connected`);
                    continue;
                }

                // Check if we need to refresh the token
                const validToken = await ensureValidToken(user.user_id, 'streamer');
                if (!validToken) {
                    logger.log("Twitch", `Skipping EventSub for ${user.user_id}: Token refresh failed`);
                    failureCount++;
                    continue;
                }

                // Get Twitch user ID if we don't have it yet
                if (!user.twitch_tokens.streamer.twitch_user_id) {
                    const twitchUserId = await fetchTwitchUserId(user.user_id, 'streamer');
                    if (!twitchUserId) {
                        logger.log("Twitch", `Skipping EventSub for ${user.user_id}: Couldn't get Twitch user ID`);
                        failureCount++;
                        continue;
                    }
                }

                // Register all subscription types
                const results = await registerUserSubscriptions(user.user_id);

                if (results.success) {
                    successCount++;
                    logger.log("Twitch", `Successfully registered EventSub for ${user.user_id}`);
                } else {
                    failureCount++;
                    logger.log("Twitch", `Failed to register EventSub for ${user.user_id}: ${results.error}`);
                }
            } catch (userError) {
                failureCount++;
                logger.error("Twitch", `Error processing user ${user.user_id}: ${userError.message}`);
            }

            // Add a small delay between users to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        logger.log("Twitch", `EventSub registration complete. Success: ${successCount}, Failures: ${failureCount}`);
        return { success: successCount, failures: failureCount };
    } catch (error) {
        logger.error("Twitch", `Error in registerAllUsersEventSub: ${error.message}`);
        throw error;
    }
}

/**
 * Register all subscription types for a single user
 * @param {string} userId - The user ID
 * @returns {Promise<{success: boolean, created: string[], skipped: string[], error: string|null}>}
 */
export async function registerUserSubscriptions(userId) {
    try {
        const user = await returnAuthObject(userId);

        // Check if streamer account is connected
        if (!user.twitch_tokens || !user.twitch_tokens.streamer || !user.twitch_tokens.streamer.access_token) {
            return {
                success: false,
                created: [],
                skipped: [],
                error: "No streamer account connected"
            };
        }

        // Check if we have the Twitch user ID
        if (!user.twitch_tokens.streamer.twitch_user_id) {
            logger.log("Twitch", `No Twitch user ID found for user ${userId}, fetching it now`);

            try {
                const twitchUserId = await fetchTwitchUserId(userId, 'streamer');
                if (!twitchUserId) {
                    logger.error("Twitch", `Failed to fetch Twitch user ID for ${userId}`);
                    return {
                        success: false,
                        created: [],
                        skipped: [],
                        error: "Failed to fetch Twitch user ID"
                    };
                }

                // Should be saved by fetchTwitchUserId, but double-check
                if (!user.twitch_tokens.streamer.twitch_user_id) {
                    await updateUserParameter(userId, "twitch_tokens.streamer.twitch_user_id", twitchUserId);
                }
            } catch (err) {
                logger.error("Twitch", `Error fetching Twitch user ID: ${err.message}`);
                return {
                    success: false,
                    created: [],
                    skipped: [],
                    error: `Error fetching Twitch user ID: ${err.message}`
                };
            }
        }

        // Make sure the webhook_secret path exists
        await ensureParameterPath(userId, "twitch_tokens.streamer.subscriptions");

        // Generate webhook secret if it doesn't exist
        if (!user.twitch_tokens.streamer.webhook_secret) {
            const newSecret = crypto.randomBytes(32).toString('hex');
            await updateUserParameter(userId, "twitch_tokens.streamer.webhook_secret", newSecret);
            logger.log("Twitch", `Generated new webhook secret for user ${userId}`);
        }

        // Refresh the user object to make sure we have the latest data
        const updatedUser = await returnAuthObject(userId);

        // Verify we have the broadcaster_user_id
        if (!updatedUser.twitch_tokens.streamer.twitch_user_id) {
            logger.error("Twitch", `No Twitch user ID found for user ${userId} after refresh`);
            return {
                success: false,
                created: [],
                skipped: [],
                error: "Missing Twitch user ID"
            };
        }

        // Check if the bot account is connected for subscriptions that need it
        const hasBotAccount = updatedUser.twitch_tokens?.bot?.access_token ? true : false;

        // Track existing subscriptions to avoid duplicates
        const existingSubscriptions = new Map();
        if (updatedUser.twitch_tokens.streamer.subscriptions) {
            updatedUser.twitch_tokens.streamer.subscriptions.forEach(sub => {
                // Create key from type and version
                const key = `${sub.type}:${sub.version || '1'}`;
                existingSubscriptions.set(key, sub);
            });
        }

        const results = {
            success: true,
            created: [],
            skipped: [],
            errors: [],
            error: null
        };

        const broadcasterId = updatedUser.twitch_tokens.streamer.twitch_user_id;

        // Check which scopes the user has
        const streamerScopes = await getUserScopes(userId, 'streamer');
        const botScopes = hasBotAccount ? await getUserScopes(userId, 'bot') : [];

        // Process each subscription type
        for (const subscriptionConfig of SUBSCRIPTION_TYPES) {
            try {
                // Create key for checking existing subscriptions
                const subKey = `${subscriptionConfig.type}:${subscriptionConfig.version}`;

                // Skip if we already have this subscription
                if (existingSubscriptions.has(subKey)) {
                    results.skipped.push(`${subscriptionConfig.type} (v${subscriptionConfig.version})`);
                    continue;
                }

                // Skip optional subscriptions if conditions aren't met (like beta features)
                if (subscriptionConfig.optional) {
                    // Skip beta features if not explicitly allowed
                    if (subscriptionConfig.version === 'beta' && !user.allow_beta_features) {
                        results.skipped.push(`${subscriptionConfig.type} (v${subscriptionConfig.version}) - beta feature not enabled`);
                        continue;
                    }
                }

                // Verify the user has the required scopes
                if (subscriptionConfig.requiredScopes.length > 0) {
                    const accountType = subscriptionConfig.tokenType;
                    const userScopes = accountType === 'bot' ? botScopes : streamerScopes;
                    
                    // Skip if using bot token but no bot account is connected
                    if (accountType === 'bot' && !hasBotAccount) {
                        results.skipped.push(`${subscriptionConfig.type} (v${subscriptionConfig.version}) - requires bot account`);
                        continue;
                    }
                    
                    // Check if user has all required scopes
                    const missingScopes = subscriptionConfig.requiredScopes.filter(
                        scope => !userScopes.includes(scope)
                    );
                    
                    if (missingScopes.length > 0) {
                        logger.log("Twitch", `Skipping ${subscriptionConfig.type} - missing scopes: ${missingScopes.join(', ')}`);
                        results.skipped.push(`${subscriptionConfig.type} (v${subscriptionConfig.version}) - missing scopes`);
                        continue;
                    }
                }

                // Create the subscription
                const subResult = await createSubscription(
                    userId,
                    subscriptionConfig,
                    broadcasterId
                );

                if (subResult.success) {
                    results.created.push(`${subscriptionConfig.type} (v${subscriptionConfig.version})`);
                } else {
                    // Track errors but continue with other subscriptions
                    results.errors.push(`${subscriptionConfig.type} (v${subscriptionConfig.version}): ${subResult.error}`);
                    logger.error("Twitch", `Failed to create subscription for ${subscriptionConfig.type} (v${subscriptionConfig.version}): ${subResult.error}`);
                }

                // Add a small delay between requests to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                // Handle individual subscription errors
                results.errors.push(`${subscriptionConfig.type} (v${subscriptionConfig.version}): ${error.message}`);
                logger.error("Twitch", `Error creating subscription for ${subscriptionConfig.type} (v${subscriptionConfig.version}): ${error.message}`);
            }
        }

        // Overall success is true if we created at least one subscription without errors
        // or if we skipped all because they already exist
        results.success = results.created.length > 0 ||
            (results.skipped.length === SUBSCRIPTION_TYPES.length);

        // Add summary of errors if any occurred
        if (results.errors.length > 0) {
            results.error = `Some subscriptions failed: ${results.errors.length} errors`;
            logger.warn("Twitch", `Completed EventSub registration for ${userId} with ${results.errors.length} errors`);
        } else {
            logger.log("Twitch", `Successfully registered all EventSub subscriptions for ${userId}`);
        }

        return results;
    } catch (error) {
        logger.error("Twitch", `Error in registerUserSubscriptions: ${error.message}`);
        return {
            success: false,
            created: [],
            skipped: [],
            error: error.message
        };
    }
}

/**
 * Get the scopes associated with a user's token
 * @param {string} userId - The user ID
 * @param {string} tokenType - The token type (bot or streamer)
 * @returns {Promise<string[]>} - Array of scopes
 */
async function getUserScopes(userId, tokenType) {
    try {
        const user = await returnAuthObject(userId);
        
        // Check if token exists
        if (!user.twitch_tokens?.[tokenType]?.access_token) {
            return [];
        }
        
        // If we already have cached scopes, return them
        if (user.twitch_tokens[tokenType].scopes) {
            return user.twitch_tokens[tokenType].scopes;
        }
        
        // Otherwise validate the token to get scopes
        const axios = (await import('axios')).default;
        const response = await axios.get('https://id.twitch.tv/oauth2/validate', {
            headers: {
                'Authorization': `OAuth ${user.twitch_tokens[tokenType].access_token}`
            }
        });
        
        if (response.data && response.data.scopes) {
            // Cache the scopes
            await updateUserParameter(userId, `twitch_tokens.${tokenType}.scopes`, response.data.scopes);
            return response.data.scopes;
        }
        
        return [];
    } catch (error) {
        logger.error("Twitch", `Error getting user scopes: ${error.message}`);
        return [];
    }
}

/**
 * Create a single EventSub subscription
 * @param {string} userId - The user ID
 * @param {object} subscriptionConfig - The subscription configuration
 * @param {string} broadcasterId - The Twitch broadcaster ID
 * @returns {Promise<{success: boolean, id?: string, error?: string}>}
 */
async function createSubscription(userId, subscriptionConfig, broadcasterId) {
    try {
        const user = await returnAuthObject(userId);

        if (!user.twitch_tokens || !user.twitch_tokens.streamer) {
            return { success: false, error: "No streamer account connected" };
        }

        // Double-check webhook secret exists
        if (!user.twitch_tokens.streamer.webhook_secret) {
            // Try to create it one more time
            const newSecret = crypto.randomBytes(32).toString('hex');
            await updateUserParameter(userId, "twitch_tokens.streamer.webhook_secret", newSecret);
            // Refresh user
            const refreshedUser = await returnAuthObject(userId);
            if (!refreshedUser.twitch_tokens.streamer.webhook_secret) {
                return { success: false, error: "Could not create webhook secret" };
            }
        }

        // Validate broadcaster_user_id
        if (!broadcasterId) {
            logger.error("Twitch", `Missing broadcaster_user_id for user ${userId}`);
            return { success: false, error: "Missing broadcaster_user_id" };
        }

        // Choose the appropriate token based on subscription config
        const tokenType = subscriptionConfig.tokenType || 'app';
        let accessToken;
        
        if (tokenType === 'app') {
            // Use app access token
            accessToken = await getAppAccessToken();
        } else if (tokenType === 'bot' && user.twitch_tokens.bot?.access_token) {
            // Use bot token if available and required
            accessToken = user.twitch_tokens.bot.access_token;
        } else {
            // Default to streamer token
            accessToken = user.twitch_tokens.streamer.access_token;
        }

        // Generate the condition based on subscription type and version
        const condition = subscriptionConfig.condition(broadcasterId);

        logger.log("Twitch", `Creating ${subscriptionConfig.type} (v${subscriptionConfig.version}) subscription with condition: ${JSON.stringify(condition)} using ${tokenType} token`);

        const callbackUrl = `${await retrieveConfigValue("server.endpoints.external")}/api/v1/twitch/eventsub/${userId}`;

        const subscriptionBody = {
            type: subscriptionConfig.type,
            version: subscriptionConfig.version,
            condition: condition,
            transport: {
                method: 'webhook',
                callback: callbackUrl,
                secret: user.twitch_tokens.streamer.webhook_secret
            }
        };

        // Import axios if needed
        const axios = (await import('axios')).default;

        const response = await axios.post(
            'https://api.twitch.tv/helix/eventsub/subscriptions',
            subscriptionBody,
            {
                headers: {
                    'Client-ID': await retrieveConfigValue("twitch.clientId"),
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // Make sure subscriptions array exists
        if (!user.twitch_tokens.streamer.subscriptions) {
            await ensureParameterPath(userId, "twitch_tokens.streamer");
            await updateUserParameter(userId, "twitch_tokens.streamer.subscriptions", []);
        }

        // Save subscription ID
        const subscriptionId = response.data.data[0].id;

        // Get the current subscriptions array
        const currentUser = await returnAuthObject(userId);
        const subscriptions = currentUser.twitch_tokens.streamer.subscriptions || [];

        // Add new subscription and update
        subscriptions.push({
            id: subscriptionId,
            type: subscriptionConfig.type,
            version: subscriptionConfig.version,
            created_at: new Date().toISOString()
        });

        await updateUserParameter(userId, "twitch_tokens.streamer.subscriptions", subscriptions);

        return {
            success: true,
            id: subscriptionId,
            version: subscriptionConfig.version
        };
    } catch (error) {
        logger.error("Twitch", `Error creating subscription ${subscriptionConfig.type}: ${error.message}`);

        if (error.response) {
            const status = error.response.status;
            const data = error.response.data;

            logger.error("Twitch", `Response status: ${status}, data: ${JSON.stringify(data)}`);

            // Handle specific error cases
            if (status === 400) {
                if (data.message) {
                    return { success: false, error: `Bad request: ${data.message}` };
                }
                if (data.error === "Bad Request" && data.message && data.message.includes("condition.broadcaster_user_id")) {
                    return { success: false, error: "Invalid broadcaster ID" };
                }
            } else if (status === 401) {
                logger.log("Twitch", `Token unauthorized, trying to get a new app token`);
                global.twitchAppToken = null;
                global.twitchAppTokenExpiry = null;
                return { success: false, error: "Unauthorized. Token refresh needed." };
            } else if (status === 403) {
                return { success: false, error: "Insufficient permissions. Check Twitch API credentials." };
            } else if (status === 429) {
                return { success: false, error: "Rate limited by Twitch. Try again later." };
            }
        }

        return { success: false, error: error.message };
    }
}

/**
 * Ensure token is valid and refresh if needed
 * @param {string} userId - The user ID
 * @param {string} tokenType - Either 'bot' or 'streamer'
 * @returns {Promise<boolean>}
 */
async function ensureValidToken(userId, tokenType) {
    try {
        const user = await returnAuthObject(userId);

        if (!user.twitch_tokens || !user.twitch_tokens[tokenType] || !user.twitch_tokens[tokenType].refresh_token) {
            return false;
        }

        // Check if token is expired or expiring soon
        const now = Date.now();
        const tokenExpiry = user.twitch_tokens[tokenType].expires_at || 0;

        if (now >= tokenExpiry - (5 * 60 * 1000)) {
            // Token is expired or expiring in next 5 minutes, refresh it
            return await refreshToken(userId, tokenType);
        }

        return true;
    } catch (error) {
        logger.error("Twitch", `Error checking token for ${userId}: ${error.message}`);
        return false;
    }
}

/**
 * Refresh an expired token
 * @param {string} userId - The user ID
 * @param {string} tokenType - Either 'bot' or 'streamer'
 * @returns {Promise<boolean>}
 */
async function refreshToken(userId, tokenType) {
    try {
        const user = await returnAuthObject(userId);

        const response = await axios.post(
            'https://id.twitch.tv/oauth2/token',
            new URLSearchParams({
                client_id: await retrieveConfigValue("twitch.clientId"),
                client_secret: await retrieveConfigValue("twitch.clientSecret"),
                grant_type: 'refresh_token',
                refresh_token: user.twitch_tokens[tokenType].refresh_token
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const { access_token, refresh_token, expires_in } = response.data;

        // Update token data
        await updateUserParameter(userId, `twitch_tokens.${tokenType}.access_token`, access_token);
        await updateUserParameter(userId, `twitch_tokens.${tokenType}.refresh_token`, refresh_token);
        await updateUserParameter(userId, `twitch_tokens.${tokenType}.expires_at`, Date.now() + (expires_in * 1000));
        
        // Clear cached scopes as they might change with the new token
        await updateUserParameter(userId, `twitch_tokens.${tokenType}.scopes`, null);

        return true;
    } catch (error) {
        logger.error("Twitch", `Error refreshing token for ${userId}: ${error.message}`);
        return false;
    }
}

/**
 * Get Twitch user ID for a user
 * @param {string} userId - The user ID
 * @param {string} tokenType - Either 'bot' or 'streamer'
 * @returns {Promise<string|null>}
 */
async function fetchTwitchUserId(userId, tokenType) {
    try {
        const user = await returnAuthObject(userId);

        // If we already have the ID, return it
        if (user.twitch_tokens?.[tokenType]?.twitch_user_id) {
            logger.log("Twitch", `Using existing Twitch user ID for ${userId} (${tokenType}): ${user.twitch_tokens[tokenType].twitch_user_id}`);
            return user.twitch_tokens[tokenType].twitch_user_id;
        }

        // Check if we have an access token
        if (!user.twitch_tokens?.[tokenType]?.access_token) {
            logger.error("Twitch", `No access token available for ${userId} (${tokenType})`);
            return null;
        }

        // Determine which username to use
        let twitchUsername;
        if (tokenType === 'bot') {
            if (user.bot_twitch) {
                // Remove @ if present
                twitchUsername = user.bot_twitch.replace(/^@/, '');
            } else {
                logger.error("Twitch", `No bot_twitch username set for user ${userId}`);

                // Try to get user info without a login parameter (gets the authenticated user)
                logger.log("Twitch", `Attempting to get authenticated user info for ${userId} (${tokenType})`);
                const axios = (await import('axios')).default;

                const response = await axios.get(
                    `https://api.twitch.tv/helix/users`,
                    {
                        headers: {
                            'Client-ID': await retrieveConfigValue("twitch.clientId"),
                            'Authorization': `Bearer ${user.twitch_tokens[tokenType].access_token}`
                        }
                    }
                );

                if (response.data.data && response.data.data.length > 0) {
                    const twitchUserId = response.data.data[0].id;
                    const twitchLogin = response.data.data[0].login;
                    const twitchDisplayName = response.data.data[0].display_name;

                    // Save all the Twitch user info
                    await ensureParameterPath(userId, `twitch_tokens.${tokenType}`);
                    await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_user_id`, twitchUserId);
                    await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_login`, twitchLogin);
                    await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_display_name`, twitchDisplayName);

                    logger.log("Twitch", `Retrieved and saved Twitch user ID for ${userId} (${tokenType}): ${twitchUserId}`);
                    return twitchUserId;
                }

                logger.error("Twitch", `Failed to get user info without login parameter for ${userId} (${tokenType})`);
                return null;
            }
        } else { // tokenType === 'streamer'
            if (user.twitch_name) {
                twitchUsername = user.twitch_name;
            } else {
                logger.error("Twitch", `No twitch_name username set for user ${userId}`);

                // Try to get user info without a login parameter (gets the authenticated user)
                logger.log("Twitch", `Attempting to get authenticated user info for ${userId} (${tokenType})`);
                const axios = (await import('axios')).default;

                const response = await axios.get(
                    `https://api.twitch.tv/helix/users`,
                    {
                        headers: {
                            'Client-ID': await retrieveConfigValue("twitch.clientId"),
                            'Authorization': `Bearer ${user.twitch_tokens[tokenType].access_token}`
                        }
                    }
                );

                if (response.data.data && response.data.data.length > 0) {
                    const twitchUserId = response.data.data[0].id;
                    const twitchLogin = response.data.data[0].login;
                    const twitchDisplayName = response.data.data[0].display_name;

                    // Save all the Twitch user info
                    await ensureParameterPath(userId, `twitch_tokens.${tokenType}`);
                    await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_user_id`, twitchUserId);
                    await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_login`, twitchLogin);
                    await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_display_name`, twitchDisplayName);

                    logger.log("Twitch", `Retrieved and saved Twitch user ID for ${userId} (${tokenType}): ${twitchUserId}`);
                    return twitchUserId;
                }

                logger.error("Twitch", `Failed to get user info without login parameter for ${userId} (${tokenType})`);
                return null;
            }
        }

        logger.log("Twitch", `Looking up Twitch user ID for ${twitchUsername} (${userId}, ${tokenType})`);

        // Import axios if needed
        const axios = (await import('axios')).default;

        const response = await axios.get(
            `https://api.twitch.tv/helix/users?login=${twitchUsername}`,
            {
                headers: {
                    'Client-ID': await retrieveConfigValue("twitch.clientId"),
                    'Authorization': `Bearer ${user.twitch_tokens[tokenType].access_token}`
                }
            }
        );

        if (response.data.data && response.data.data.length > 0) {
            const twitchUserId = response.data.data[0].id;
            const twitchLogin = response.data.data[0].login;
            const twitchDisplayName = response.data.data[0].display_name;

            // Save all the Twitch user info
            await ensureParameterPath(userId, `twitch_tokens.${tokenType}`);
            await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_user_id`, twitchUserId);
            await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_login`, twitchLogin);
            await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_display_name`, twitchDisplayName);

            logger.log("Twitch", `Retrieved and saved Twitch user ID for ${userId} (${tokenType}): ${twitchUserId}`);
            return twitchUserId;
        } else {
            logger.error("Twitch", `No user found for username ${twitchUsername} (${userId}, ${tokenType})`);
            return null;
        }
    } catch (error) {
        logger.error("Twitch", `Error fetching Twitch user ID for ${userId} (${tokenType}): ${error.message}`);

        // Log response error details if available
        if (error.response) {
            logger.error("Twitch", `Response status: ${error.response.status}, data: ${JSON.stringify(error.response.data)}`);

            // Handle token issues
            if (error.response.status === 401) {
                logger.log("Twitch", `Attempting to refresh token for ${userId} (${tokenType})`);
                const refreshed = await refreshToken(userId, tokenType);
                if (refreshed) {
                    logger.log("Twitch", `Token refreshed, retrying user ID lookup`);

                    // Get fresh user object with new token
                    const refreshedUser = await returnAuthObject(userId);

                    // Try the request again with the fresh token
                    try {
                        const axios = (await import('axios')).default;
                        const retryResponse = await axios.get(
                            `https://api.twitch.tv/helix/users`,
                            {
                                headers: {
                                    'Client-ID': await retrieveConfigValue("twitch.clientId"),
                                    'Authorization': `Bearer ${refreshedUser.twitch_tokens[tokenType].access_token}`
                                }
                            }
                        );

                        if (retryResponse.data.data && retryResponse.data.data.length > 0) {
                            const twitchUserId = retryResponse.data.data[0].id;
                            const twitchLogin = retryResponse.data.data[0].login;
                            const twitchDisplayName = retryResponse.data.data[0].display_name;

                            // Save all the Twitch user info
                            await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_user_id`, twitchUserId);
                            await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_login`, twitchLogin);
                            await updateUserParameter(userId, `twitch_tokens.${tokenType}.twitch_display_name`, twitchDisplayName);

                            logger.log("Twitch", `Successfully retrieved Twitch user ID after token refresh: ${twitchUserId}`);
                            return twitchUserId;
                        }
                    } catch (retryError) {
                        logger.error("Twitch", `Failed retry attempt after token refresh: ${retryError.message}`);
                    }
                }
            }
        }

        return null;
    }
}

/**
 * Process an EventSub notification and map it to our internal format
 * @param {string} eventType - The EventSub event type
 * @param {object} eventData - The event data from Twitch
 * @param {string} userId - The user ID
 * @param {string} eventVersion - The version of the event
 * @returns {Promise<object>} - The processed event
 */
export async function processEventSubNotification(eventType, eventData, userId, eventVersion = '1') {
    try {
        // Import your existing event handling system
        const { respondToEvent } = await import('./ai-logic.js');

        // Map EventSub event format to your existing format, passing the version
        const mappedEvent = mapEventSubToInternalFormat(eventType, eventData, eventVersion);

        // Process the event
        logger.log("Twitch", `Processing ${eventType} (v${eventVersion}) event for user ${userId}`);

        // Call your existing AI response system
        const response = await respondToEvent(mappedEvent, userId);

        // Return the response
        return response;
    } catch (error) {
        logger.error("Twitch", `Error processing notification: ${error.message}`);
        throw error;
    }
}

/**
 * Convert EventSub format to our internal format used by the AI
 * @param {string} eventType - The EventSub event type
 * @param {object} eventData - The event data from Twitch
 * @param {string} version - The version of the event
 * @returns {object} - The mapped event in our internal format
 */
function mapEventSubToInternalFormat(eventType, eventData, version = '1') {
    // Create base event object
    let mappedEvent = { eventType: null, eventData: {} };

    // Map based on event type and version
    switch (eventType) {
        case 'channel.update':
            mappedEvent.eventType = 'game_change';
            mappedEvent.eventData = {
                game: eventData.category_name || '',
                title: eventData.title || ''
            };
            break;

        case 'channel.follow':
            mappedEvent.eventType = 'follow';

            // Handle different versions
            if (version === '2') {
                // v2 format has different fields
                mappedEvent.eventData = {
                    username: eventData.user_name || '',
                    userId: eventData.user_id || '',
                    followed_at: eventData.followed_at || new Date().toISOString()
                };
            } else {
                // v1 format (legacy)
                mappedEvent.eventData = {
                    username: eventData.user_name || '',
                    userId: eventData.user_id || '',
                    followed_at: eventData.followed_at || new Date().toISOString()
                };
            }
            break;

        case 'channel.subscribe':
            mappedEvent.eventType = 'sub';
            mappedEvent.eventData = {
                subType: 'sub',
                user: eventData.user_name || '',
                subTier: mapTier(eventData.tier || '1000'),
                isGift: eventData.is_gift || false
            };
            break;

        case 'channel.subscription.gift':
            mappedEvent.eventType = 'sub';
            mappedEvent.eventData = {
                subType: 'gift_sub',
                user: eventData.is_anonymous ? 'Anonymous' : (eventData.user_name || ''),
                anonymous: eventData.is_anonymous || false,
                subTier: mapTier(eventData.tier || '1000'),
                recipientUserName: eventData.recipient_user_name || 'a viewer'
            };
            break;

        case 'channel.subscription.message':
            mappedEvent.eventType = 'sub';
            mappedEvent.eventData = {
                subType: 'resub',
                user: eventData.user_name || '',
                subTier: mapTier(eventData.tier || '1000'),
                streak: eventData.streak_months || 1,
                tenure: eventData.cumulative_months || 1,
                sharedChat: eventData.message ? eventData.message.text : ''
            };
            break;

        case 'channel.cheer':
            mappedEvent.eventType = 'dono';
            mappedEvent.eventData = {
                donoType: 'bits',
                donoFrom: eventData.is_anonymous ? 'Anonymous' : (eventData.user_name || ''),
                donoAmt: eventData.bits || 0,
                donoMessage: eventData.message || ''
            };
            break;

        case 'channel.hype_train.begin':
            mappedEvent.eventType = 'hype_start';
            mappedEvent.eventData = {
                level: eventData.level || 1,
                total: eventData.total || 0,
                startedAt: eventData.started_at || new Date().toISOString(),
                expiresAt: eventData.expires_at || '',
                percent: eventData.goal ? (eventData.progress / eventData.goal) : 0,
                topBitsUser: getTopContributor(eventData, 'BITS')?.user_name || 'Unknown',
                topBitsAmt: getTopContributor(eventData, 'BITS')?.total || 0,
                topSubUser: getTopContributor(eventData, 'SUBSCRIPTION')?.user_name || 'Unknown',
                topSubTotal: getTopContributor(eventData, 'SUBSCRIPTION')?.total || 0
            };
            break;

        case 'channel.hype_train.progress':
            mappedEvent.eventType = 'hype_update';
            mappedEvent.eventData = {
                level: eventData.level || 1,
                total: eventData.total || 0,
                startedAt: eventData.started_at || new Date().toISOString(),
                expiresAt: eventData.expires_at || '',
                percent: eventData.goal ? (eventData.progress / eventData.goal) : 0,
                contributors: eventData.total_users || 0,
                isGolden: false, // EventSub doesn't have this info
                topBitsUser: getTopContributor(eventData, 'BITS')?.user_name || 'Unknown',
                topBitsAmt: getTopContributor(eventData, 'BITS')?.total || 0,
                topSubUser: getTopContributor(eventData, 'SUBSCRIPTION')?.user_name || 'Unknown',
                topSubTotal: getTopContributor(eventData, 'SUBSCRIPTION')?.total || 0
            };
            break;

        case 'channel.hype_train.end':
            mappedEvent.eventType = 'hype_end';
            mappedEvent.eventData = {
                level: eventData.level || 1,
                total: eventData.total || 0,
                startedAt: eventData.started_at || new Date().toISOString(),
                percent: eventData.goal ? (eventData.progress / eventData.goal) : 0,
                contributors: eventData.total_users || 0,
                isGolden: false, // EventSub doesn't have this info
                topBitsUser: getTopContributor(eventData, 'BITS')?.user_name || 'Unknown',
                topBitsAmt: getTopContributor(eventData, 'BITS')?.total || 0,
                topSubUser: getTopContributor(eventData, 'SUBSCRIPTION')?.user_name || 'Unknown',
                topSubTotal: getTopContributor(eventData, 'SUBSCRIPTION')?.total || 0
            };
            break;

        case 'stream.online':
            mappedEvent.eventType = 'stream_online';
            mappedEvent.eventData = {
                startTime: eventData.started_at || new Date().toISOString(),
                type: eventData.type || 'live' // 'live' or 'playlist' or 'watch_party' or 'premiere' or 'rerun'
            };
            break;

        case 'stream.offline':
            mappedEvent.eventType = 'stream_offline';
            mappedEvent.eventData = {
                endTime: new Date().toISOString() // EventSub doesn't provide this, so use current time
            };
            break;

        default:
            // Direct passthrough for unmapped types
            mappedEvent.eventType = eventType.replace('channel.', '').replace('stream.', '');
            mappedEvent.eventData = JSON.parse(JSON.stringify(eventData)); // Create a safe copy
    }

    return mappedEvent;
}

/**
 * Helper function to get top contributor from hype train events
 * @param {object} eventData - The hype train event data
 * @param {string} type - The contribution type to look for
 * @returns {object|null} - The top contributor or null
 */
function getTopContributor(eventData, type) {
    if (!eventData || !eventData.top_contributions || !Array.isArray(eventData.top_contributions)) {
        return null;
    }

    return eventData.top_contributions.find(
        contributor => contributor.type === type
    );
}

/**
 * Helper for tier mapping
 * @param {string} tier - The Twitch tier string
 * @returns {string} - Our internal tier format
 */
function mapTier(tier) {
    switch (tier) {
        case '1000': return 'tier 1';
        case '2000': return 'tier 2';
        case '3000': return 'tier 3';
        default: return 'prime';
    }
}