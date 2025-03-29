// mongodb-client.js - New module for MongoDB operations
import mongoose from "mongoose";
import fs from "fs-extra";
import { retrieveConfigValue } from "./config-helper.js";
import { logger } from "./create-global-logger.js";

// Cache with TTL
const userCache = new Map();
const dirtyFlags = new Map();
let connectionEstablished = false;
let connectionRetries = 0;
const MAX_RETRIES = 5;

// Define user schema with essential fields
const userSchema = new mongoose.Schema(
  {
    // Required unique identifier
    user_id: { type: String, required: true, unique: true, index: true },

    // Authentication fields
    api_token: { type: String, index: true },
    webPasswordHash: String,
    webPasswordSalt: String,
    webPasswordIterations: { type: Number, default: 20480 },

    // User information
    email: String,
    user_name: String, // Used for system references
    display_name: String,

    // Twitch integration
    twitch_name: String,
    bot_name: String,
    bot_twitch: String,

    // Token and integration data
    twitch_tokens: {
      streamer: {
        access_token: String,
        refresh_token: String,
        expires_at: Number,
        twitch_user_id: String,
        twitch_login: String,
        twitch_display_name: String,
        webhook_secret: String,
        subscriptions: Array,
        scopes: Array,
      },
      bot: {
        access_token: String,
        refresh_token: String,
        expires_at: Number,
        twitch_user_id: String,
        twitch_login: String,
        twitch_display_name: String,
        scopes: Array,
      },
    },

    // User preferences
    socials: {
      twitter: String,
      tiktok: String,
      youtube: String,
      instagram: String,
      twitch: String,
      kick: String,
    },

    // Stream and chat settings
    weather: { type: Boolean, default: false },
    store_all_chat: { type: Boolean, default: true },
    commands_list: { type: Array, default: [] },
    aux_bots: { type: Array, default: [] },

    // TTS settings
    tts_enabled: { type: Boolean, default: false },
    ttsEqPref: { type: String, default: "clarity" },
    ttsUpsamplePref: { type: Boolean, default: false },
    speaker_file: String,
    fishTTSVoice: String,

    // Fun facts settings
    funFacts: { type: Boolean, default: false },
    funFactsInterval: { type: Number, default: 30 },

    // Tracking fields
    lastIp: String,
    latitude: String,
    longitude: String,
    timeZone: String,

    // Stream status tracking
    current_game: Object,
    current_viewers: { type: Number, default: 0 },
    current_followers: { type: Number, default: 0 },
    stream_status: mongoose.Schema.Types.Mixed,

    // Feature flags
    global_strikes: { type: Boolean, default: false },
    global_bans: { type: Boolean, default: false },
    allow_beta_features: { type: Boolean, default: false },
    is_local: { type: Boolean, default: false },
    max_chats: { type: Number, default: 25 },
  },
  {
    strict: false, // Allow additional fields beyond schema
    timestamps: true, // Add createdAt and updatedAt automatically
    minimize: false, // Store empty objects
  }
);

// Create indexes for performance
userSchema.index({ "twitch_tokens.streamer.twitch_user_id": 1 });
userSchema.index({ "twitch_tokens.bot.twitch_user_id": 1 });
userSchema.index({ user_id: 1 });

const User = mongoose.model("User", userSchema, "user_data");

// Connect to MongoDB

export async function connectToMongoDB() {
  try {
    if (connectionEstablished) return true;

    const mongoUri = await retrieveConfigValue("mongoDb.endpoint");
    const mongoUser = await retrieveConfigValue("mongoDb.user");
    const mongoPass = await retrieveConfigValue("mongoDb.password");
    const mongoDb =
      (await retrieveConfigValue("mongoDb.database")) || "enspira";

    // Build connection string with authentication if credentials exist
    let connectionString = mongoUri;
    if (mongoUser && mongoPass) {
      // Transform URI to include auth if not already formatted that way
      if (mongoUri.indexOf("@") === -1) {
        // Assuming mongoUri is in format: mongodb://host:port
        const uriParts = mongoUri.split("//");
        connectionString = `${uriParts[0]}//${mongoUser}:${encodeURIComponent(mongoPass)}@${uriParts[1]}`;
      }
    }

    // Add database name if not in the connection string
    if (connectionString.split("/").length <= 3) {
      connectionString = `${connectionString}/${mongoDb}`;
    }

    await mongoose.connect(connectionString, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
    });

    connectionEstablished = true;
    logger.log("MongoDB", `Connected to MongoDB at ${mongoUri} successfully`);

    // Run migration if needed
    await migrateFromFileIfNeeded();

    // Set up cache cleanup interval
    setInterval(cleanupCache, 60000); // Check every minute

    return true;
  } catch (error) {
    logger.error("MongoDB", `Failed to connect to MongoDB: ${error.message}`);
    return false;
  }
}

function handleDisconnect() {
  if (connectionEstablished) {
    connectionEstablished = false;
    logger.error(
      "MongoDB",
      "Disconnected from database. Attempting to reconnect..."
    );

    // Attempt reconnection after a delay
    setTimeout(() => {
      connectToMongoDB().catch((err) => {
        logger.error("MongoDB", `Reconnection failed: ${err.message}`);
      });
    }, 5000);
  }
}

function handleConnectionError(err) {
  logger.error("MongoDB", `MongoDB connection error: ${err.message}`);

  if (connectionEstablished) {
    connectionEstablished = false;
    // Attempt reconnection will happen via the 'disconnected' event
  }
}

// Migrate data from auth_keys.json if collection is empty
async function migrateFromFileIfNeeded() {
    try {
      const count = await User.countDocuments({});
      if (count === 0) {
        logger.log("MongoDB", "Collection is empty, migrating from file...");
        
        const authFilePath = await retrieveConfigValue("server.authFilePath");
        if (fs.existsSync(authFilePath)) {
          const fileData = await fs.readJSON(authFilePath);
          
          if (Array.isArray(fileData) && fileData.length > 0) {
            // Transform the data before inserting
            const transformedData = fileData.map(user => {
              // Create a clean copy of the user object
              const transformedUser = { ...user };
              
              // Fix stream_status if it exists but isn't in the right format
              if (transformedUser.stream_status && typeof transformedUser.stream_status !== 'object') {
                transformedUser.stream_status = { 
                  online: false, 
                  updated_at: new Date().toISOString() 
                };
              } else if (transformedUser.stream_status) {
                // Ensure it has the expected structure
                transformedUser.stream_status = {
                  online: transformedUser.stream_status.online || false,
                  started_at: transformedUser.stream_status.started_at || null,
                  type: transformedUser.stream_status.type || null,
                  title: transformedUser.stream_status.title || null,
                  viewer_count: transformedUser.stream_status.viewer_count || 0,
                  updated_at: transformedUser.stream_status.updated_at || new Date().toISOString()
                };
              }
              
              return transformedUser;
            });
            
            // Insert transformed data
            await User.insertMany(transformedData, { validateBeforeSave: false });
            logger.log("MongoDB", `Migrated ${transformedData.length} users from file to MongoDB`);
            
            // Create backup of original file
            const backupPath = `${authFilePath}.bak.${Date.now()}`;
            await fs.copy(authFilePath, backupPath);
            logger.log("MongoDB", `Created backup of original auth file at ${backupPath}`);
          }
        }
      }
    } catch (error) {
      logger.error("MongoDB", `Migration error: ${error.message}`);
    }
  }

// Get user by ID with caching
export async function getUserById(userId) {
  try {
    // Check cache first
    if (userCache.has(userId)) {
      const cachedData = userCache.get(userId);
      if (Date.now() < cachedData.expiry) {
        return cachedData.data;
      }
      // Cache expired, remove it
      userCache.delete(userId);
    }

    if (!connectionEstablished) {
      // Try to connect if not already connected
      const connected = await connectToMongoDB();
      if (!connected) {
        logger.error(
          "MongoDB",
          `Cannot get user ${userId}: Database not connected`
        );
        return null;
      }
    }

    // Fetch from database
    const user = await User.findOne({ user_id: userId }).lean();

    if (user) {
      // Cache for 1 minute
      userCache.set(userId, {
        data: user,
        expiry: Date.now() + 60000,
        lastModified: Date.now(),
      });
      return user;
    }

    return null;
  } catch (error) {
    logger.error("MongoDB", `Error fetching user ${userId}: ${error.message}`);
    return null;
  }
}

// Get all users
export async function getAllUsers() {
  try {
    if (!connectionEstablished) {
      // Try to connect if not already connected
      const connected = await connectToMongoDB();
      if (!connected) {
        logger.error("MongoDB", "Cannot get all users: Database not connected");
        return [];
      }
    }

    return await User.find({}).lean();
  } catch (error) {
    logger.error("MongoDB", `Error fetching all users: ${error.message}`);
    return [];
  }
}

// Update user data with path support
export async function updateUserData(userId, path, value) {
  try {
    if (!connectionEstablished) {
      // Try to connect if not already connected
      const connected = await connectToMongoDB();
      if (!connected) {
        logger.error(
          "MongoDB",
          `Cannot update user ${userId}: Database not connected`
        );
        return false;
      }
    }

    // Get the user from cache or DB
    let user = userCache.has(userId)
      ? userCache.get(userId).data
      : await getUserById(userId);

    if (!user) {
      logger.error("MongoDB", `Cannot update: User ${userId} not found`);
      return false;
    }

    // If path is empty, replace the entire object
    if (!path) {
      const result = await User.replaceOne({ user_id: userId }, value);

      if (result.modifiedCount > 0 || result.upsertedCount > 0) {
        // Update cache
        userCache.set(userId, {
          data: value,
          expiry: Date.now() + 60000,
          lastModified: Date.now(),
        });

        return true;
      }
      return false;
    }

    // Handle nested path updates
    const pathParts = path.split(".");
    let current = user;

    // Navigate to containing object
    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];

      if (current[part] === undefined) {
        current[part] = {};
      }

      current = current[part];
    }

    // Update the value
    const lastPart = pathParts[pathParts.length - 1];
    current[lastPart] = value;

    // Mark as dirty and update cache
    dirtyFlags.set(userId, true);
    userCache.set(userId, {
      data: user,
      expiry: Date.now() + 60000,
      lastModified: Date.now(),
    });

    // Write through for immediate persistence
    const updatePath = path ? { [`${path}`]: value } : user;
    await User.updateOne(
      { user_id: userId },
      { $set: updatePath },
      { upsert: true }
    );

    return true;
  } catch (error) {
    logger.error("MongoDB", `Error updating user ${userId}: ${error.message}`);
    return false;
  }
}

// Ensure path exists in user object
export async function ensureUserPath(userId, path) {
  try {
    if (!connectionEstablished) {
      // Try to connect if not already connected
      const connected = await connectToMongoDB();
      if (!connected) {
        logger.error(
          "MongoDB",
          `Cannot ensure path for user ${userId}: Database not connected`
        );
        return false;
      }
    }

    // Get the user
    let user = userCache.has(userId)
      ? userCache.get(userId).data
      : await getUserById(userId);

    if (!user) {
      logger.error("MongoDB", `Cannot ensure path: User ${userId} not found`);
      return false;
    }

    // Split the path into parts
    const pathParts = path.split(".");
    let current = user;
    let updateNeeded = false;

    // Create path objects as needed
    for (let i = 0; i < pathParts.length; i++) {
      const part = pathParts[i];

      if (!current[part]) {
        current[part] = {};
        updateNeeded = true;
      }

      current = current[part];
    }

    // Only update DB if we made changes
    if (updateNeeded) {
      // Update cache
      userCache.set(userId, {
        data: user,
        expiry: Date.now() + 60000,
        lastModified: Date.now(),
      });

      // Prepare update for database - we need to construct a $set operation for the path
      const setOperation = { $set: {} };
      setOperation.$set[path] = {};

      // Update database
      await User.updateOne({ user_id: userId }, setOperation, { upsert: true });
    }

    return true;
  } catch (error) {
    logger.error(
      "MongoDB",
      `Error ensuring path for user ${userId}: ${error.message}`
    );
    return false;
  }
}

// Clean up cache and flush changes
async function cleanupCache() {
  const now = Date.now();
  const promises = [];

  for (const [userId, cacheEntry] of userCache.entries()) {
    // Check if expired
    if (now >= cacheEntry.expiry) {
      // If dirty, save before removing
      if (dirtyFlags.get(userId)) {
        promises.push(
          User.replaceOne({ user_id: userId }, cacheEntry.data, {
            upsert: true,
          })
            .then(() => {
              logger.log(
                "MongoDB",
                `Flushed changes for user ${userId} before cache expiry`
              );
              dirtyFlags.delete(userId);
            })
            .catch((error) => {
              logger.error(
                "MongoDB",
                `Error flushing changes for user ${userId}: ${error.message}`
              );
            })
        );
      }

      // Remove from cache after promise is added
      userCache.delete(userId);
    }
  }

  // Wait for all save operations to complete
  if (promises.length > 0) {
    await Promise.allSettled(promises);
  }
}

export async function createUser(userData) {
  try {
    if (!connectionEstablished) {
      // Try to connect if not already connected
      const connected = await connectToMongoDB();
      if (!connected) {
        logger.error("MongoDB", "Cannot create user: Database not connected");
        return null;
      }
    }

    // Ensure user_id exists
    if (!userData.user_id) {
      logger.error("MongoDB", "Cannot create user: Missing user_id field");
      return null;
    }

    // Check if user already exists
    const existingUser = await User.findOne({ user_id: userData.user_id });
    if (existingUser) {
      logger.error(
        "MongoDB",
        `User with ID ${userData.user_id} already exists`
      );
      return null;
    }

    // Create new user
    const newUser = new User(userData);
    const savedUser = await newUser.save();

    // Add to cache
    userCache.set(userData.user_id, {
      data: savedUser.toObject(),
      expiry: Date.now() + 60000,
      lastModified: Date.now(),
    });

    logger.log("MongoDB", `Created new user with ID ${userData.user_id}`);
    return savedUser.toObject();
  } catch (error) {
    logger.error("MongoDB", `Error creating user: ${error.message}`);
    return null;
  }
}

// Flush all pending changes
export async function flushAllChanges() {
  if (!connectionEstablished) {
    logger.error("MongoDB", "Cannot flush changes: Database not connected");
    return false;
  }

  const promises = [];

  for (const [userId, cacheEntry] of userCache.entries()) {
    if (dirtyFlags.get(userId)) {
      promises.push(
        User.replaceOne({ user_id: userId }, cacheEntry.data, { upsert: true })
          .then(() => {
            logger.log("MongoDB", `Flushed changes for user ${userId}`);
            dirtyFlags.delete(userId);
          })
          .catch((error) => {
            logger.error(
              "MongoDB",
              `Error flushing changes for user ${userId}: ${error.message}`
            );
          })
      );
    }
  }

  // Wait for all save operations to complete
  if (promises.length > 0) {
    try {
      await Promise.allSettled(promises);
      return true;
    } catch (error) {
      logger.error(
        "MongoDB",
        `Error during flush operations: ${error.message}`
      );
      return false;
    }
  }

  return true;
}

export async function checkDatabaseHealth() {
  try {
    if (!connectionEstablished) {
      // Try connecting
      const connected = await connectToMongoDB();
      if (!connected) {
        return { connected: false, error: "Failed to connect to database" };
      }
    }

    // Run a simple query to test connection
    await User.findOne({}).select("user_id").lean();

    return {
      connected: true,
      pendingWrites: dirtyFlags.size,
      cachedUsers: userCache.size,
      status:
        mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    };
  } catch (error) {
    return {
      connected: false,
      error: error.message,
      status: mongoose.connection.readyState,
    };
  }
}

// Disconnect from MongoDB
export async function disconnect() {
  try {
    // Flush any pending changes
    await flushAllChanges();

    // Clear intervals
    clearInterval(cleanupCache);

    // Disconnect
    await mongoose.disconnect();
    connectionEstablished = false;
    logger.log("MongoDB", "Disconnected from MongoDB");
    return true;
  } catch (error) {
    logger.error(
      "MongoDB",
      `Error disconnecting from MongoDB: ${error.message}`
    );
    return false;
  }
}

process.on("SIGTERM", async () => {
  logger.log("MongoDB", "SIGTERM received, flushing changes and disconnecting");
  await flushAllChanges();
  await mongoose.disconnect();
});

process.on("SIGINT", async () => {
  logger.log("MongoDB", "SIGINT received, flushing changes and disconnecting");
  await flushAllChanges();
  await mongoose.disconnect();
});
