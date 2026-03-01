/**
 * MongoDB database operations with Mongoose
 * Handles user data, chat messages, caching, and migrations
 * @module core/database
 */

import mongoose, { Schema, Model, Document, Types } from 'mongoose';
import fs from 'fs-extra';
import crypto from 'crypto';
import { retrieveConfigValue } from './config.js';
import { logger } from './logger.js';
import type {
  User,
  AlternateSpell,
  UserCacheEntry,
  DatabaseHealthResult,
  CachingOptions,
  StoreChatMessageInput,
  StoreChatMessageResult,
  FormattedChatMessage,
  RelevantContextOptions,
  ChatMessageMetadata,
} from '../types/user.types.js';

// ============================================
// Type Definitions
// ============================================

/** Mongoose document for User */
export interface UserDocument extends Omit<User, '_id'>, Document {
  _id: Types.ObjectId;
}

/** Mongoose document for ChatMessage */
export interface ChatMessageDocument extends Document {
  _id: Types.ObjectId;
  user_id: string;
  username: string;
  message: string;
  message_id: string;
  timestamp: Date;
  ai_response?: string;
  embedding_id?: string;
  is_important: boolean;
  metadata?: ChatMessageMetadata;
  createdAt: Date;
  updatedAt: Date;
}

/** Function type for vector storage (imported dynamically) */
type StoreInMilvusFn = (
  userId: string,
  summaryString: string,
  messageData: StoreChatMessageInput
) => Promise<string | null>;

/** Function type for finding relevant chats (imported dynamically) */
type FindRelevantChatsFn = (
  message: string,
  username: string,
  userId: string,
  limit: number
) => Promise<FormattedChatMessage[]>;

// ============================================
// Module State
// ============================================

/** User data cache with TTL */
const userCache = new Map<string, UserCacheEntry>();

/** Dirty flags for pending writes */
const dirtyFlags = new Map<string, boolean>();

/** Connection state */
let connectionEstablished = false;

/** Connection retry count */
let connectionRetries = 0;

/** Maximum connection retries */
const MAX_RETRIES = 5;

/** Cache cleanup interval handle */
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

// ============================================
// Mongoose Schemas
// ============================================

const userSchema = new Schema<UserDocument>(
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
    user_name: String,
    display_name: String,

    // Twitch integration
    twitch_name: String,
    bot_name: String,
    bot_twitch: String,

    // Alternate spellings for vocal interaction
    alternateSpell: {
      type: [Schema.Types.Mixed],
      default: [],
      validate: {
        validator: function (arr: unknown[]): boolean {
          return arr.every(
            (item) =>
              typeof item === 'string' ||
              (typeof item === 'object' &&
                item !== null &&
                'from' in item &&
                'to' in item)
          );
        },
        message: 'alternateSpell items must be strings or objects with from/to properties',
      },
    },

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
        subscriptions: [Schema.Types.Mixed],
        scopes: [String],
      },
      bot: {
        access_token: String,
        refresh_token: String,
        expires_at: Number,
        twitch_user_id: String,
        twitch_login: String,
        twitch_display_name: String,
        scopes: [String],
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
    commands_list: [Schema.Types.Mixed],
    aux_bots: [Schema.Types.Mixed],

    // TTS settings
    tts_enabled: { type: Boolean, default: false },
    ttsEqPref: { type: String, default: 'clarity' },
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
    current_game: Schema.Types.Mixed,
    current_viewers: { type: Number, default: 0 },
    current_followers: { type: Number, default: 0 },
    stream_status: Schema.Types.Mixed,

    // Feature flags
    global_strikes: { type: Boolean, default: false },
    global_bans: { type: Boolean, default: false },
    allow_beta_features: { type: Boolean, default: false },
    is_local: { type: Boolean, default: false },
    max_chats: { type: Number, default: 25 },
  },
  {
    strict: false,
    timestamps: true,
    minimize: false,
  }
);

const chatMessageSchema = new Schema<ChatMessageDocument>(
  {
    user_id: { type: String, required: true, index: true },
    username: { type: String, required: true },
    message: { type: String, required: true },
    message_id: { type: String, required: true, unique: true },
    timestamp: { type: Date, default: Date.now, index: true },
    ai_response: String,
    embedding_id: String,
    is_important: { type: Boolean, default: false },
    metadata: Schema.Types.Mixed,
  },
  {
    strict: false,
    timestamps: true,
  }
);

// Create indexes for performance
chatMessageSchema.index({ user_id: 1, timestamp: -1 });
chatMessageSchema.index({ username: 1, user_id: 1 });
chatMessageSchema.index({ message: 'text', ai_response: 'text' });

// Additional compound indexes (user_id already indexed via field definition)
userSchema.index({ 'twitch_tokens.streamer.twitch_user_id': 1 });
userSchema.index({ 'twitch_tokens.bot.twitch_user_id': 1 });

// ============================================
// Mongoose Models
// ============================================

const UserModel: Model<UserDocument> = mongoose.model<UserDocument>('User', userSchema, 'user_data');
const ChatMessageModel: Model<ChatMessageDocument> = mongoose.model<ChatMessageDocument>(
  'ChatMessage',
  chatMessageSchema,
  'chat_messages'
);

// ============================================
// Migration Functions
// ============================================

/**
 * Migrates alternateSpell field to existing users
 */
async function migrateAlternateSpellField(): Promise<boolean> {
  try {
    logger.log('MongoDB', 'Starting migration for alternateSpell field...');

    const result = await UserModel.updateMany(
      { alternateSpell: { $exists: false } },
      { $set: { alternateSpell: [] } }
    );

    logger.log('MongoDB', `Updated ${result.modifiedCount} users with alternateSpell field`);

    // For users with bot_name "Layla", add common alternate spellings
    const laylaUsers = await UserModel.find({ bot_name: 'Layla' });
    for (const user of laylaUsers) {
      if (!user.alternateSpell || user.alternateSpell.length === 0) {
        await UserModel.updateOne(
          { user_id: user.user_id },
          {
            $set: {
              alternateSpell: ['Leila', 'Lila', 'Laila', 'Leyla'],
            },
          }
        );
        logger.log('MongoDB', `Added default alternate spellings for Layla user: ${user.user_id}`);
      }
    }

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('MongoDB', `Error during alternateSpell migration: ${message}`);
    return false;
  }
}

/**
 * Migrates user data from file if the database is empty
 */
async function migrateFromFileIfNeeded(): Promise<void> {
  try {
    const count = await UserModel.countDocuments({});
    if (count === 0) {
      logger.log('MongoDB', 'Collection is empty, migrating from file...');

      const authFilePath = await retrieveConfigValue<string>('server.authFilePath');
      if (authFilePath && fs.existsSync(authFilePath)) {
        const fileData = (await fs.readJSON(authFilePath)) as User[];

        if (Array.isArray(fileData) && fileData.length > 0) {
          const transformedData = fileData.map((user) => {
            const transformedUser = { ...user };

            // Add alternateSpell field if it doesn't exist
            if (!transformedUser.alternateSpell) {
              transformedUser.alternateSpell = [];

              if (transformedUser.bot_name === 'Layla') {
                transformedUser.alternateSpell = ['Leila', 'Lila', 'Laila', 'Leyla'];
              }
            }

            // Fix stream_status if needed
            if (transformedUser.stream_status && typeof transformedUser.stream_status !== 'object') {
              transformedUser.stream_status = {
                is_live: false,
              };
            }

            return transformedUser;
          });

          await UserModel.insertMany(transformedData);
          logger.log('MongoDB', `Migrated ${transformedData.length} users from file to MongoDB`);

          // Create backup
          const backupPath = `${authFilePath}.bak.${Date.now()}`;
          await fs.copy(authFilePath, backupPath);
          logger.log('MongoDB', `Created backup of original auth file at ${backupPath}`);
        }
      }
    } else {
      await migrateAlternateSpellField();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('MongoDB', `Migration error: ${message}`);
  }
}

// ============================================
// Connection Management
// ============================================

/**
 * Connects to MongoDB with retry logic
 */
export async function connectToMongoDB(): Promise<boolean> {
  try {
    if (connectionEstablished) return true;

    const mongoUri = await retrieveConfigValue<string>('mongoDb.endpoint');
    const mongoUser = await retrieveConfigValue<string>('mongoDb.user');
    const mongoPass = await retrieveConfigValue<string>('mongoDb.password');
    const mongoDb = (await retrieveConfigValue<string>('mongoDb.database')) ?? 'enspira';

    if (!mongoUri) {
      logger.error('MongoDB', 'No MongoDB endpoint configured');
      return false;
    }

    // Build connection string with authentication
    let connectionString = mongoUri;
    if (mongoUser && mongoPass) {
      if (!mongoUri.includes('@')) {
        const uriParts = mongoUri.split('//');
        connectionString = `${uriParts[0]}//${mongoUser}:${encodeURIComponent(mongoPass)}@${uriParts[1]}`;
      }
    }

    // Add database name if not in the connection string
    if (connectionString.split('/').length <= 3) {
      connectionString = `${connectionString}/${mongoDb}`;
    }

    await mongoose.connect(connectionString, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
    });

    connectionEstablished = true;
    connectionRetries = 0;
    logger.log('MongoDB', `Connected to MongoDB at ${mongoUri} successfully`);

    // Run migration if needed
    await migrateFromFileIfNeeded();

    // Set up cache cleanup interval
    if (cleanupIntervalId) {
      clearInterval(cleanupIntervalId);
    }
    cleanupIntervalId = setInterval(() => void cleanupCache(), 60000);

    // Set up connection event handlers
    mongoose.connection.on('disconnected', handleDisconnect);
    mongoose.connection.on('error', handleConnectionError);

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('MongoDB', `Failed to connect to MongoDB: ${message}`);

    if (connectionRetries < MAX_RETRIES) {
      connectionRetries++;
      logger.log('MongoDB', `Retrying connection (${connectionRetries}/${MAX_RETRIES})...`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return connectToMongoDB();
    }

    return false;
  }
}

/**
 * Handles MongoDB disconnection events
 */
function handleDisconnect(): void {
  if (connectionEstablished) {
    connectionEstablished = false;
    logger.error('MongoDB', 'Disconnected from database. Attempting to reconnect...');

    setTimeout(() => {
      void connectToMongoDB().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('MongoDB', `Reconnection failed: ${message}`);
      });
    }, 5000);
  }
}

/**
 * Handles MongoDB connection errors
 */
function handleConnectionError(err: Error): void {
  logger.error('MongoDB', `MongoDB connection error: ${err.message}`);

  if (connectionEstablished) {
    connectionEstablished = false;
  }
}

/**
 * Disconnects from MongoDB gracefully
 */
export async function disconnect(): Promise<boolean> {
  try {
    await flushAllChanges();

    if (cleanupIntervalId) {
      clearInterval(cleanupIntervalId);
      cleanupIntervalId = null;
    }

    await mongoose.disconnect();
    connectionEstablished = false;
    logger.log('MongoDB', 'Disconnected from MongoDB');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('MongoDB', `Error disconnecting from MongoDB: ${message}`);
    return false;
  }
}

// ============================================
// Caching Layer
// ============================================

/**
 * Generic caching wrapper for database operations
 */
async function withCaching(
  key: string,
  fetchFn: () => Promise<User | null>,
  options: CachingOptions = {}
): Promise<User | null> {
  const { ttl = 60000, forceFresh = false } = options;

  // Check cache first unless forceFresh
  if (!forceFresh && userCache.has(key)) {
    const cachedData = userCache.get(key)!;
    if (Date.now() < cachedData.expiry) {
      return cachedData.data;
    }
    userCache.delete(key);
  }

  // Ensure connection
  if (!connectionEstablished) {
    const connected = await connectToMongoDB();
    if (!connected) {
      logger.error('MongoDB', 'Cannot fetch data: Database not connected');
      return null;
    }
  }

  try {
    const data = await fetchFn();

    if (data) {
      userCache.set(key, {
        data,
        expiry: Date.now() + ttl,
        lastModified: Date.now(),
      });
    }

    return data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('MongoDB', `Error fetching data for ${key}: ${message}`);
    return null;
  }
}

/**
 * Cleans up expired cache entries and flushes dirty data
 */
async function cleanupCache(): Promise<void> {
  const now = Date.now();
  const promises: Promise<void>[] = [];

  for (const [userId, cacheEntry] of userCache.entries()) {
    if (now >= cacheEntry.expiry) {
      if (dirtyFlags.get(userId)) {
        promises.push(
          UserModel.replaceOne({ user_id: userId }, cacheEntry.data, { upsert: true })
            .then(() => {
              logger.log('MongoDB', `Flushed changes for user ${userId} before cache expiry`);
              dirtyFlags.delete(userId);
            })
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              logger.error('MongoDB', `Error flushing changes for user ${userId}: ${message}`);
            })
        );
      }

      userCache.delete(userId);
    }
  }

  if (promises.length > 0) {
    await Promise.allSettled(promises);
  }
}

/**
 * Flushes all pending changes to the database
 */
export async function flushAllChanges(): Promise<boolean> {
  if (!connectionEstablished) {
    logger.error('MongoDB', 'Cannot flush changes: Database not connected');
    return false;
  }

  const promises: Promise<void>[] = [];

  for (const [userId, cacheEntry] of userCache.entries()) {
    if (dirtyFlags.get(userId)) {
      promises.push(
        UserModel.replaceOne({ user_id: userId }, cacheEntry.data, { upsert: true })
          .then(() => {
            logger.log('MongoDB', `Flushed changes for user ${userId}`);
            dirtyFlags.delete(userId);
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('MongoDB', `Error flushing changes for user ${userId}: ${message}`);
          })
      );
    }
  }

  if (promises.length > 0) {
    try {
      await Promise.allSettled(promises);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('MongoDB', `Error during flush operations: ${message}`);
      return false;
    }
  }

  return true;
}

// ============================================
// User CRUD Operations
// ============================================

/**
 * Gets a user by their ID with caching
 */
export async function getUserById(userId: string): Promise<User | null> {
  try {
    return withCaching(userId, async () => {
      const user = await UserModel.findOne({ user_id: userId }).lean();
      if (!user) return null;
      // Convert Mongoose document to User type
      return {
        ...user,
        _id: user._id.toString(),
      } as unknown as User;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('MongoDB', `Error fetching user ${userId}: ${message}`);
    return null;
  }
}

/**
 * Gets all users from the database
 */
export async function getAllUsers(): Promise<User[]> {
  try {
    if (!connectionEstablished) {
      const connected = await connectToMongoDB();
      if (!connected) {
        logger.error('MongoDB', 'Cannot get all users: Database not connected');
        return [];
      }
    }

    const users = await UserModel.find({}).lean();
    return users.map((user) => ({
      ...user,
      _id: user._id.toString(),
    })) as unknown as User[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('MongoDB', `Error fetching all users: ${message}`);
    return [];
  }
}

/**
 * Creates a new user
 */
export async function createUser(userData: Partial<User>): Promise<User | null> {
  try {
    if (!connectionEstablished) {
      const connected = await connectToMongoDB();
      if (!connected) {
        logger.error('MongoDB', 'Cannot create user: Database not connected');
        return null;
      }
    }

    if (!userData.user_id) {
      logger.error('MongoDB', 'Cannot create user: Missing user_id field');
      return null;
    }

    const existingUser = await UserModel.findOne({ user_id: userData.user_id });
    if (existingUser) {
      logger.error('MongoDB', `User with ID ${userData.user_id} already exists`);
      return null;
    }

    const newUser = new UserModel(userData);
    const savedUser = await newUser.save();

    const doc = savedUser.toObject();
    const userObject = {
      ...doc,
      _id: doc._id.toString(),
    } as unknown as User;

    userCache.set(userData.user_id, {
      data: userObject,
      expiry: Date.now() + 60000,
      lastModified: Date.now(),
    });

    logger.log('MongoDB', `Created new user with ID ${userData.user_id}`);
    return userObject;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('MongoDB', `Error creating user: ${message}`);
    return null;
  }
}

/**
 * Updates user data at a specific path
 */
export async function updateUserData(
  userId: string,
  path: string,
  value: unknown
): Promise<boolean> {
  try {
    if (!connectionEstablished) {
      const connected = await connectToMongoDB();
      if (!connected) {
        logger.error('MongoDB', `Cannot update user ${userId}: Database not connected`);
        return false;
      }
    }

    let user = userCache.has(userId)
      ? userCache.get(userId)!.data
      : await getUserById(userId);

    if (!user) {
      logger.error('MongoDB', `Cannot update: User ${userId} not found`);
      return false;
    }

    // If path is empty, replace the entire object
    if (!path) {
      const result = await UserModel.replaceOne({ user_id: userId }, value as User);

      if (result.modifiedCount > 0 || result.upsertedCount > 0) {
        userCache.set(userId, {
          data: value as User,
          expiry: Date.now() + 60000,
          lastModified: Date.now(),
        });
        return true;
      }
      return false;
    }

    // Handle nested path updates
    const pathParts = path.split('.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let current: any = user;

    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i]!;
      if (current[part] === undefined) {
        current[part] = {};
      }
      current = current[part];
    }

    const lastPart = pathParts[pathParts.length - 1]!;
    current[lastPart] = value;

    // Mark as dirty and update cache
    dirtyFlags.set(userId, true);
    userCache.set(userId, {
      data: user,
      expiry: Date.now() + 60000,
      lastModified: Date.now(),
    });

    // Write through for immediate persistence
    await UserModel.updateOne({ user_id: userId }, { $set: { [path]: value } }, { upsert: true });

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('MongoDB', `Error updating user ${userId}: ${message}`);
    return false;
  }
}

/**
 * Ensures a path exists in the user object
 */
export async function ensureUserPath(userId: string, path: string): Promise<boolean> {
  try {
    if (!connectionEstablished) {
      const connected = await connectToMongoDB();
      if (!connected) {
        logger.error('MongoDB', `Cannot ensure path for user ${userId}: Database not connected`);
        return false;
      }
    }

    let user = userCache.has(userId)
      ? userCache.get(userId)!.data
      : await getUserById(userId);

    if (!user) {
      logger.error('MongoDB', `Cannot ensure path: User ${userId} not found`);
      return false;
    }

    const pathParts = path.split('.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let current: any = user;
    let updateNeeded = false;

    for (let i = 0; i < pathParts.length; i++) {
      const part = pathParts[i]!;
      if (!current[part]) {
        current[part] = {};
        updateNeeded = true;
      }
      current = current[part];
    }

    if (updateNeeded) {
      userCache.set(userId, {
        data: user,
        expiry: Date.now() + 60000,
        lastModified: Date.now(),
      });

      await UserModel.updateOne({ user_id: userId }, { $set: { [path]: {} } }, { upsert: true });
    }

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('MongoDB', `Error ensuring path for user ${userId}: ${message}`);
    return false;
  }
}

// ============================================
// Alternate Spelling Operations
// ============================================

/**
 * Adds an alternate spelling for a user
 */
export async function addAlternateSpelling(
  userId: string,
  alternateSpelling: AlternateSpell
): Promise<boolean> {
  try {
    if (!connectionEstablished) {
      const connected = await connectToMongoDB();
      if (!connected) {
        logger.error('MongoDB', 'Cannot add alternate spelling: Database not connected');
        return false;
      }
    }

    // Validate input
    if (
      typeof alternateSpelling !== 'string' &&
      !(
        typeof alternateSpelling === 'object' &&
        alternateSpelling !== null &&
        'from' in alternateSpelling &&
        'to' in alternateSpelling
      )
    ) {
      logger.error('MongoDB', 'Invalid alternateSpelling format');
      return false;
    }

    const result = await UserModel.updateOne(
      { user_id: userId },
      { $addToSet: { alternateSpell: alternateSpelling } }
    );

    if (result.modifiedCount > 0) {
      if (userCache.has(userId)) {
        const cachedUser = userCache.get(userId)!;
        if (!cachedUser.data.alternateSpell) {
          cachedUser.data.alternateSpell = [];
        }
        cachedUser.data.alternateSpell.push(alternateSpelling);
        userCache.set(userId, {
          ...cachedUser,
          lastModified: Date.now(),
        });
      }

      logger.log(
        'MongoDB',
        `Added alternate spelling "${JSON.stringify(alternateSpelling)}" for user ${userId}`
      );
      return true;
    }

    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('MongoDB', `Error adding alternate spelling: ${message}`);
    return false;
  }
}

/**
 * Removes an alternate spelling from a user
 */
export async function removeAlternateSpelling(
  userId: string,
  alternateSpelling: AlternateSpell
): Promise<boolean> {
  try {
    if (!connectionEstablished) {
      const connected = await connectToMongoDB();
      if (!connected) {
        logger.error('MongoDB', 'Cannot remove alternate spelling: Database not connected');
        return false;
      }
    }

    const result = await UserModel.updateOne(
      { user_id: userId },
      { $pull: { alternateSpell: alternateSpelling } }
    );

    if (result.modifiedCount > 0) {
      if (userCache.has(userId)) {
        const cachedUser = userCache.get(userId)!;
        if (cachedUser.data.alternateSpell) {
          cachedUser.data.alternateSpell = cachedUser.data.alternateSpell.filter(
            (item) => JSON.stringify(item) !== JSON.stringify(alternateSpelling)
          );
          userCache.set(userId, {
            ...cachedUser,
            lastModified: Date.now(),
          });
        }
      }

      logger.log(
        'MongoDB',
        `Removed alternate spelling "${JSON.stringify(alternateSpelling)}" for user ${userId}`
      );
      return true;
    }

    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('MongoDB', `Error removing alternate spelling: ${message}`);
    return false;
  }
}

// ============================================
// Chat Message Operations
// ============================================

/**
 * Stores a chat message with optional embedding
 */
export async function storeChatMessage(
  userId: string,
  messageData: StoreChatMessageInput,
  generateEmbedding = false
): Promise<StoreChatMessageResult> {
  try {
    if (!connectionEstablished) {
      const connected = await connectToMongoDB();
      if (!connected) {
        return { success: false, error: 'Database not connected' };
      }
    }

    const messageId = crypto.randomBytes(16).toString('hex');

    const isImportant =
      generateEmbedding || messageData.firstMessage || messageData.mentionsCharacter;

    const chatMessage = new ChatMessageModel({
      user_id: userId,
      username: messageData.username,
      message: messageData.message,
      message_id: messageId,
      timestamp: new Date(),
      ai_response: messageData.aiResponse ?? null,
      is_important: isImportant,
      metadata: {
        firstMessage: messageData.firstMessage ?? false,
        mentionsCharacter: messageData.mentionsCharacter ?? false,
        emoteCount: messageData.emoteCount ?? 0,
      },
    });

    await chatMessage.save();

    // Store in Milvus if important (requires ai-logic module)
    if (isImportant) {
      try {
        const formattedDate = new Date().toLocaleString();
        const summaryString = `On ${formattedDate}, ${messageData.username} said in ${userId}'s Twitch chat: "${messageData.message}". ${messageData.aiResponse ? `You responded by saying: ${messageData.aiResponse}` : ''}`;

        // Dynamic import to avoid circular dependency
        const ragContextModule = await import('./rag-context.js').catch(() => null) as
          | { addChatMessageAsVector?: (sumText: string, message: string, username: string, date: string, response: string, userId: string) => Promise<boolean> }
          | null;

        if (ragContextModule?.addChatMessageAsVector) {
          const addChatMessageAsVector = ragContextModule.addChatMessageAsVector;
          const success = await addChatMessageAsVector(
            summaryString,
            messageData.message || '',
            messageData.username || '',
            formattedDate,
            messageData.aiResponse || '',
            userId
          );
          const embeddingId = success ? `batch-${Date.now()}` : null;

          if (embeddingId) {
            await ChatMessageModel.updateOne(
              { message_id: messageId },
              { $set: { embedding_id: embeddingId } }
            );
          }
        }
      } catch (milvusError) {
        const message = milvusError instanceof Error ? milvusError.message : String(milvusError);
        logger.error('Milvus', `Error storing embedding: ${message}`);
      }
    }

    return { success: true, message_id: messageId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('MongoDB', `Error storing chat message: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Gets the count of chat messages for a user
 */
export async function getChatCount(userId: string): Promise<number> {
  try {
    if (!connectionEstablished) {
      const connected = await connectToMongoDB();
      if (!connected) {
        return 0;
      }
    }

    const numChats = await ChatMessageModel.countDocuments({ user_id: userId });
    logger.log('Mongo', `Getting ${numChats} for ${userId}`);
    return numChats;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('MongoDB', `Error counting chats: ${message}`);
    return 0;
  }
}

/**
 * Gets recent chat messages for a user
 */
export async function getRecentChats(
  userId: string,
  limit = 25,
  skip = 0
): Promise<FormattedChatMessage[]> {
  try {
    if (!connectionEstablished) {
      const connected = await connectToMongoDB();
      if (!connected) {
        return [];
      }
    }

    const messages = await ChatMessageModel.find({ user_id: userId })
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return messages.map((msg) => ({
      username: msg.username,
      raw_msg: msg.message,
      text_content: `${msg.username} sent the following message: ${msg.message}`,
      ai_message: msg.ai_response ?? '',
      time_stamp: new Date(msg.timestamp).getTime(),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('MongoDB', `Error fetching recent chats: ${message}`);
    return [];
  }
}

/**
 * Finds relevant chat context using hybrid search
 */
export async function findRelevantChatContext(
  userId: string,
  message: string,
  username: string,
  limit = 10,
  options: RelevantContextOptions = {}
): Promise<FormattedChatMessage[]> {
  const { useVectors = true, simpleTextSearch = true } = options;

  try {
    if (!connectionEstablished) {
      const connected = await connectToMongoDB();
      if (!connected) {
        return [];
      }
    }

    let relevantMessages: FormattedChatMessage[] = [];

    if (simpleTextSearch) {
      const textSearchResults = await ChatMessageModel.find(
        {
          user_id: userId,
          $text: { $search: message },
        },
        {
          score: { $meta: 'textScore' },
        }
      )
        .sort({ score: { $meta: 'textScore' } })
        .limit(limit)
        .lean();

      relevantMessages = textSearchResults.map((msg) => ({
        username: msg.username,
        raw_msg: msg.message,
        text_content: `${msg.username} sent the following message: ${msg.message}`,
        ai_message: msg.ai_response ?? '',
        time_stamp: new Date(msg.timestamp).getTime(),
      }));
    }

    // If we didn't find enough with text search and vectors are enabled, try Milvus
    if (useVectors && relevantMessages.length < Math.ceil(limit / 2)) {
      try {
        // Dynamic import to avoid circular dependency
        const ragContextModule = await import('./rag-context.js').catch(() => null) as
          | { findRelevantChats?: FindRelevantChatsFn }
          | null;

        if (!ragContextModule?.findRelevantChats) {
          return relevantMessages;
        }

        const findRelevantChats = ragContextModule.findRelevantChats as FindRelevantChatsFn;
        const milvusResults = await findRelevantChats(message, username, userId, limit);

        if (milvusResults && milvusResults.length > 0) {
          if (relevantMessages.length === 0) {
            return milvusResults;
          }

          // Merge results, prioritizing Milvus
          const messageMap = new Map<string, FormattedChatMessage>();

          for (const msg of milvusResults) {
            messageMap.set(msg.raw_msg, msg);
          }

          for (const msg of relevantMessages) {
            if (!messageMap.has(msg.raw_msg)) {
              messageMap.set(msg.raw_msg, msg);
            }
          }

          return Array.from(messageMap.values()).slice(0, limit);
        }
      } catch (milvusError) {
        const message = milvusError instanceof Error ? milvusError.message : String(milvusError);
        logger.error('Chat', `Milvus search error: ${message}`);
      }
    }

    return relevantMessages;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Chat', `Error finding relevant context: ${msg}`);
    return [];
  }
}

// ============================================
// Health & Status
// ============================================

/**
 * Checks database health and returns status information
 */
export async function checkDatabaseHealth(): Promise<DatabaseHealthResult> {
  try {
    if (!connectionEstablished) {
      const connected = await connectToMongoDB();
      if (!connected) {
        return { connected: false, error: 'Failed to connect to database' };
      }
    }

    // Run a simple query to test connection
    await UserModel.findOne({}).select('user_id').lean();

    return {
      connected: true,
      pendingWrites: dirtyFlags.size,
      cachedUsers: userCache.size,
      status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      connected: false,
      error: message,
      status: mongoose.connection.readyState,
    };
  }
}

/**
 * Returns whether the database is connected
 */
export function isConnected(): boolean {
  return connectionEstablished;
}

/**
 * Returns cache statistics
 */
export function getCacheStats(): { size: number; dirtyCount: number } {
  return {
    size: userCache.size,
    dirtyCount: dirtyFlags.size,
  };
}

// ============================================
// Process Signal Handlers
// ============================================

process.on('SIGTERM', async () => {
  logger.log('MongoDB', 'SIGTERM received, flushing changes and disconnecting');
  await flushAllChanges();
  await mongoose.disconnect();
});

process.on('SIGINT', async () => {
  logger.log('MongoDB', 'SIGINT received, flushing changes and disconnecting');
  await flushAllChanges();
  await mongoose.disconnect();
});

// ============================================
// Exports
// ============================================

export {
  UserModel,
  ChatMessageModel,
  userCache,
  dirtyFlags,
};

export default {
  connectToMongoDB,
  disconnect,
  getUserById,
  getAllUsers,
  createUser,
  updateUserData,
  ensureUserPath,
  addAlternateSpelling,
  removeAlternateSpelling,
  storeChatMessage,
  getChatCount,
  getRecentChats,
  findRelevantChatContext,
  checkDatabaseHealth,
  flushAllChanges,
  isConnected,
  getCacheStats,
};
