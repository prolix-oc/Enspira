import axios from "axios";
import fs from "fs-extra";
import path from "path";
import util from "util";
import * as child_process from "child_process";
import moment from "moment";
import fetch from "node-fetch";
import https from "https";
import {
  MilvusClient,
  DataType,
  MetricType,
  IndexType,
  ConsistencyLevelEnum,
  LoadState,
  buildSearchParams,
} from "@zilliz/milvus2-sdk-node";
import OpenAI from "openai";
import FormData from "form-data";
import {
  replyStripped,
  queryPrompt,
  contextPromptChat,
  eventPromptChat,
  rerankPrompt,
  fixTTSString,
  summaryPrompt,
  sendChatCompletionRequest
} from "./prompt-helper.js";
import { returnTwitchEvent } from "./twitch-helper.js";
import { resultsReranked, pullFromWeb } from "./data-helper.js";
import { returnAuthObject } from "./api-helper.js";
import { retrieveConfigValue } from "./config-helper.js";

const intelligenceSchema = async (userId) => {
  return {
    collection_name: `${await retrieveConfigValue("milvus.collections.intelligence")}_${userId}`,
    consistency_level: ConsistencyLevelEnum.Strong,
    schema: [
      {
        name: "embedding",
        data_type: DataType.BinaryVector,
        dim: 1024,
        is_primary_key: false,
      },
      {
        name: "relation",
        data_type: DataType.VarChar,
        max_length: 512,
        is_primary_key: true,
        auto_id: true,
      },
      {
        name: "text_content",
        data_type: DataType.VarChar,
        max_length: 8192,
        is_primary_key: false,
      },
    ],
    index_params: [
      {
        field_name: "embedding",
        index_name: "emb_doc_lookup",
        index_type: IndexType.BIN_IVF_FLAT,
        metric_type: MetricType.JACCARD,
        params: { nlist: 2048 },
      },
    ],
  };
};

const chatSchema = async (userId) => {
  return {
    collection_name: `${await retrieveConfigValue("milvus.collections.chat")}_${userId}`,
    consistency_level: ConsistencyLevelEnum.Strong,
    schema: [
      {
        name: "embedding",
        data_type: DataType.BinaryVector,
        dim: 1024,
        is_primary_key: false,
        auto_id: false,
      },
      {
        name: "username",
        data_type: DataType.VarChar,
        max_length: 256,
        is_primary_key: true,
        auto_id: false,
      },
      {
        name: "text_content",
        data_type: DataType.VarChar,
        max_length: 4096,
        is_primary_key: false,
        auto_id: false,
      },
      {
        name: "raw_msg",
        data_type: DataType.VarChar,
        max_length: 1024,
        is_primary_key: false,
        auto_id: false,
      },
      {
        name: "ai_message",
        data_type: DataType.VarChar,
        max_length: 1024,
        is_primary_key: false,
        auto_id: false,
      },
      {
        name: "time_stamp",
        data_type: DataType.VarChar,
        max_length: 256,
        is_primary_key: false,
        auto_id: false,
      },
    ],
    index_params: [
      {
        field_name: "embedding",
        index_name: "emb_chat_lookup",
        index_type: IndexType.BIN_IVF_FLAT,
        metric_type: MetricType.JACCARD,
        params: { nlist: 2048 },
      },
    ],
  };
};

const voiceSchema = async (userId) => {
  return {
    collection_name: `${await retrieveConfigValue("milvus.collections.voice")}_${userId}`,
    consistency_level: ConsistencyLevelEnum.Strong,
    schema: [
      {
        name: "embedding",
        data_type: DataType.BinaryVector,
        dim: 1024,
        is_primary_key: false,
        auto_id: false,
      },
      {
        name: "username",
        data_type: DataType.VarChar,
        max_length: 32,
        is_primary_key: false,
        auto_id: false,
      },
      {
        name: "user_message",
        data_type: DataType.VarChar,
        max_length: 256,
        is_primary_key: true,
        auto_id: false,
      },
      {
        name: "ai_resp",
        data_type: DataType.VarChar,
        max_length: 4096,
        is_primary_key: false,
        auto_id: false,
      },
      {
        name: "summary",
        data_type: DataType.VarChar,
        max_length: 4096,
        is_primary_key: false,
        auto_id: false,
      },
      {
        name: "date_time",
        data_type: DataType.VarChar,
        max_length: 1024,
        is_primary_key: false,
        auto_id: false,
      },
    ],
    index_params: [
      {
        field_name: "embedding",
        index_name: "emb_voice_lookup",
        index_type: IndexType.BIN_IVF_FLAT,
        metric_type: MetricType.JACCARD,
        params: { nlist: 2048 },
      },
    ],
  };
};

const userSchema = async (userId) => {
  return {
    collection_name: `${await retrieveConfigValue("milvus.collections.user")}_${userId}`,
    consistency_level: ConsistencyLevelEnum.Strong,
    schema: [
      {
        name: "embedding",
        data_type: DataType.BinaryVector,
        dim: 1024,
        is_primary_key: false,
        auto_id: false,
      },
      {
        name: "username",
        data_type: DataType.VarChar,
        max_length: 256,
        is_primary_key: true,
        auto_id: false,
      },
      {
        name: "gender",
        data_type: DataType.VarChar,
        max_length: 256,
        is_primary_key: false,
        auto_id: false,
      },
      {
        name: "age",
        data_type: DataType.Int64,
        is_primary_key: false,
        auto_id: false,
      },
      {
        name: "residence",
        data_type: DataType.VarChar,
        max_length: 256,
        is_primary_key: false,
        auto_id: false,
      },
    ],
    index_params: [
      {
        field_name: "embedding",
        index_name: "emb_user_lookup",
        index_type: IndexType.BIN_IVF_FLAT,
        metric_type: MetricType.JACCARD,
        params: { nlist: 2048 },
      },
    ],
  };
};

const now = moment();
const execute = util.promisify(child_process.exec);
const milvusDatabaseUrl = await retrieveConfigValue("milvus.endpoint")
const client = new MilvusClient({
  address: milvusDatabaseUrl,
});

/**
 * Returns the appropriate schema for a given collection and user ID.
 * @param {string} collection - The name of the collection.
 * @param {string} userId - The user ID.
 * @returns {object} - The schema for the specified collection.
 */
async function returnCollectionSchema(collection, userId) {
  switch (collection) {
    case "users":
      return userSchema(userId);
    case "intelligence":
      return intelligenceSchema(userId);
    case "twitch_chat":
      return chatSchema(userId);
    case "vocal":
      return voiceSchema(userId);
    default:
      logger.log("Milvus", `No schema defined for collection ${collection}`);
      return null; // Return null to indicate no schema found
  }
}

/**
 * Creates a collection in Milvus.
 * @param {string} collection - The name of the collection to create.
 * @param {string} userId - The user ID.
 * @returns {Promise<void>}
 */
/**
 * Creates a collection in Milvus if it doesn't exist.
 * @param {string} collection - The name of the collection to create.
 * @param {string} userId - The user ID.
 * @returns {Promise<void>}
 */
async function createCollection(collection, userId) {
  try {
    const schema = await returnCollectionSchema(collection, userId);
    if (!schema) {
      logger.log(
        "Milvus",
        `Error: No schema found for collection ${collection}.`,
      );
      return; // Exit if no schema is found
    }

    // Check if the collection already exists
    const exists = await client.hasCollection({
      collection_name: `${collection}_${userId}`,
    });

    if (!exists.value) {
      const response = await client.createCollection(schema);
      if (response.error_code === "Success") {
        logger.log(
          "Milvus",
          `Collection '${collection}_${userId}' created successfully.`,
        );
      } else {
        logger.log(
          "Milvus",
          `Failed to create collection '${collection}_${userId}'. Reason: ${response.reason}`,
        );
      }
    } else {
      logger.log(
        "Milvus",
        `Collection '${collection}_${userId}' already exists.`,
      );
    }
  } catch (error) {
    logger.log("Milvus", `Error in createCollection: ${error}`);
  }
}

/**
 * Retrieves the schema of a collection in Milvus.
 * @param {string} collection - The name of the collection.
 * @param {string} userId - The user ID.
 * @returns {Promise<object>} - The schema of the collection.
 */
async function getCollectionSchema(collection, userId) {
  try {
    const schemaResponse = await client.describeCollection({
      collection_name: `${collection}_${userId}`,
    });
    return schemaResponse.schema;
  } catch (error) {
    logger.log("Milvus", `Error fetching schema: ${error}`);
  }
}

/**
 * Loads a collection in Milvus if it's not already loaded.
 * @param {string} collectionName - The name of the collection.
 * @param {string} userId - The user ID.
 * @returns {Promise<boolean>} - True if the collection is loaded or already exists, false otherwise.
 */
async function loadCollectionIfNeeded(collectionName, userId) {
  try {
    const collectionStatus = await client.getLoadState({
      collection_name: `${collectionName}_${userId}`,
    });
    if (collectionStatus.state === LoadState.LoadStateNotExist) {
      logger.log(
        "Milvus",
        `Collection ${collectionName}_${userId} does not exist`,
      );
      return false;
    } else if (collectionStatus.state === LoadState.LoadStateNotLoad) {
      await client.loadCollection({
        collection_name: `${collectionName}_${userId}`,
      });
      logger.log(
        "Milvus",
        `Collection ${collectionName}_${userId} loaded successfully.`,
      );
      return true;
    } else {
      return true;
    }
  } catch (error) {
    logger.log("Milvus", `Error loading collection: ${error}`);
  }
}

/**
 * Generates embeddings for a given message using a specified model.
 * @param {string|string[]} message - The message or array of messages to embed.
 * @returns {Promise<number[]|number[][]>} - The generated embeddings.
 */
async function getMessageEmbedding(message) {
  const embeddingData = {
    input: Array.isArray(message) ? message : [message],
    model: await retrieveConfigValue("models.embedding.model"),
  };
  try {
    const response = await axios.post(
      `${await retrieveConfigValue("models.embedding.endpoint")}/embeddings`,
      embeddingData,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await retrieveConfigValue("models.embedding.apiKey")}`,
        },
      },
    );
    const embeddingResp = response.data.data;
    if (embeddingResp.length > 1) {
      return embeddingResp.map((item) => item.embedding);
    } else {
      return embeddingResp[0].embedding;
    }
  } catch (error) {
    logger.log("System", `Error generating embedding: ${error}`);
  }
}

/**
 * Searches documents in a Milvus collection.
 * @param {number[]} queryEmbedding - The query embedding.
 * @param {string} collectionName - The name of the collection.
 * @param {string} textParam - The output field for text content.
 * @param {number} limit - The maximum number of results to return.
 * @param {string} userId - The user ID.
 * @returns {Promise<object>} - The search response from Milvus.
 */
async function searchDocumentsInMilvus(
  queryEmbedding,
  collectionName,
  textParam,
  limit,
  userId,
) {
  if (!queryEmbedding || queryEmbedding.length === 0) {
    logger.log("Milvus", "Query embedding is empty.");
    return { results: [] };
  }

  try {
    const searchParams = {
      collection_name: `${collectionName}_${userId}`,
      data: queryEmbedding,
      topk: limit,
      metric_type: MetricType.JACCARD,
      output_fields: [textParam],
      vector_type: DataType.BinaryVector,
      search_params: buildSearchParams({
        nprobe: 64,
        limit: limit,
      }),
      consistency_level: ConsistencyLevelEnum.Strong,
    };

    const searchResponse = await client.search(searchParams);
    return searchResponse;
  } catch (error) {
    logger.log("Milvus", `Error searching in Milvus: ${error}`);
    throw error;
  }
}

/**
 * Finds relevant chats in a Milvus collection based on a message.
 * @param {string} message - The message to search for.
 * @param {string} user - The username.
 * @param {string} userId - The user ID.
 * @param {number} topK - The number of top results to return.
 * @returns {Promise<object[]|boolean>} - An array of relevant chat results or false if the collection doesn't exist.
 */
async function findRelevantChats(message, user, userId, topK = 10) {
  try {
    const created = await checkAndCreateCollection(
      await retrieveConfigValue("milvus.collections.chat"),
      userId,
    );
    if (!created) {
      return false;
    }

    const loadCollect = await loadCollectionIfNeeded(
      await retrieveConfigValue("milvus.collections.chat"),
      userId,
    );
    if (!loadCollect) {
      logger.log(
        "Milvus",
        `Failed to load collection: ${await retrieveConfigValue("milvus.collections.chat")}_${userId}. Exiting search.`,
      );
      return [];
    }

    const messageEmbedding = await getMessageEmbedding(message);
    const binaryEmbedding = Buffer.from(messageEmbedding);
    const collectionSchema = await getCollectionSchema(
      await retrieveConfigValue("milvus.collections.chat"),
      userId,
    );

    const embeddingField = collectionSchema.fields.find(
      (field) => field.name === "embedding",
    );
    const expectedDim = embeddingField?.type_params.find(
      (param) => param.key === "dim",
    )?.value;

    if (!expectedDim) {
      logger.log(
        "Milvus",
        "Could not retrieve the expected dimension for the embedding field.",
      );
      return [];
    }

    if (binaryEmbedding.length !== parseInt(expectedDim / 8)) {
      logger.log(
        "Milvus",
        `Dimension mismatch: expected ${expectedDim}, got ${messageEmbedding.length}.`,
      );
      return [];
    }

    const chatSearchResponse = await searchDocumentsInMilvus(
      binaryEmbedding,
      await retrieveConfigValue("milvus.collections.chat"),
      "text_content",
      topK,
      userId,
    );
    return chatSearchResponse.results;
  } catch (error) {
    logger.log("Milvus", `Error in findRelevantChats: ${error}`);
    return []; // Return empty array on error
  }
}

/**
 * Finds relevant documents in a Milvus collection based on a message.
 * @param {string} message - The message to search for.
 * @param {string} userId - The user ID.
 * @param {number} topK - The number of top results to return.
 * @returns {Promise<object[]|boolean>} - An array of relevant document results or false if the collection doesn't exist.
 */
async function findRelevantDocuments(message, userId, topK = 10) {
  try {
    const exists = await client.hasCollection({
      collection_name: `${await retrieveConfigValue("milvus.collections.intelligence")}_${userId}`,
    });

    if (!exists.value) {
      logger.log(
        "Milvus",
        `Collection ${await retrieveConfigValue("milvus.collections.intelligence")}_${userId} does not exist.`,
      );
      const created = await checkAndCreateCollection(
        await retrieveConfigValue("milvus.collections.intelligence"),
        userId,
      );
      if (!created) {
        return [];
      }
    }

    const isLoaded = await loadCollectionIfNeeded(
      await retrieveConfigValue("milvus.collections.intelligence"),
      userId,
    );
    if (!isLoaded) {
      logger.log(
        "Milvus",
        `Failed to load collection: ${await retrieveConfigValue("milvus.collections.intelligence")}_${userId}. Exiting search.`,
      );
      return [];
    }

    const messageEmbedding = await getMessageEmbedding(message);
    const binaryEmbedding = Buffer.from(messageEmbedding);
    const collectionSchema = await getCollectionSchema(
      await retrieveConfigValue("milvus.collections.intelligence"),
      userId,
    );

    const embeddingField = collectionSchema.fields.find(
      (field) => field.name === "embedding",
    );
    const expectedDim = embeddingField?.type_params.find(
      (param) => param.key === "dim",
    )?.value;

    if (!expectedDim) {
      logger.log(
        "Milvus",
        "Could not retrieve the expected dimension for the embedding field.",
      );
      return [];
    }

    if (binaryEmbedding.length !== parseInt(expectedDim / 8)) {
      logger.log(
        "Milvus",
        `Dimension mismatch: expected ${expectedDim}, got ${messageEmbedding.length}.`,
      );
      return [];
    }

    const searchResponse = await searchDocumentsInMilvus(
      binaryEmbedding,
      await retrieveConfigValue("milvus.collections.intelligence"),
      "text_content",
      topK,
      userId,
    );

    return searchResponse.results;
  } catch (error) {
    logger.log("Milvus", `Error in findRelevantDocuments: ${error}`);
    return [];
  }
}

/**
 * Finds relevant voice interactions in a Milvus collection based on a message.
 * @param {string} message - The message to search for.
 * @param {string} userId - The user ID.
 * @param {number} topK - The number of top results to return.
 * @returns {Promise<object[]|boolean>} - An array of relevant voice interaction results or false if the collection doesn't exist.
 */
async function findRelevantVoiceInMilvus(message, userId, topK = 5) {
  try {
    const exists = await client.hasCollection({
      collection_name: `${await retrieveConfigValue("milvus.collections.voice")}_${userId}`,
    });

    if (!exists.value) {
      logger.log(
        "Milvus",
        `Collection ${await retrieveConfigValue("milvus.collections.voice")}_${userId} does not exist.`,
      );
      const created = await checkAndCreateCollection(
        await retrieveConfigValue("milvus.collections.voice"),
        userId,
      );
      if (!created) {
        return [];
      }
    }

    const isLoaded = await loadCollectionIfNeeded(
      await retrieveConfigValue("milvus.collections.voice"),
      userId,
    );
    if (!isLoaded) {
      logger.log(
        "Milvus",
        `Failed to load collection: ${await retrieveConfigValue("milvus.collections.voice")}_${userId}. Exiting search.`,
      );
      return [];
    }

    const messageEmbedding = await getMessageEmbedding(message);
    const binaryEmbedding = Buffer.from(messageEmbedding);
    const collectionSchema = await getCollectionSchema(
      await retrieveConfigValue("milvus.collections.voice"),
      userId,
    );

    const embeddingField = collectionSchema.fields.find(
      (field) => field.name === "embedding",
    );
    const expectedDim = embeddingField?.type_params.find(
      (param) => param.key === "dim",
    )?.value;

    if (!expectedDim) {
      logger.log(
        "Milvus",
        "Could not retrieve the expected dimension for the embedding field.",
      );
      return [];
    }

    if (binaryEmbedding.length !== parseInt(expectedDim / 8)) {
      logger.log(
        "Milvus",
        `Dimension mismatch: expected ${expectedDim}, got ${messageEmbedding.length}.`,
      );
      return [];
    }

    const voiceResponse = await searchDocumentsInMilvus(
      binaryEmbedding,
      await retrieveConfigValue("milvus.collections.voice"),
      "summary",
      topK,
      userId,
    );

    return voiceResponse.results;
  } catch (error) {
    logger.log("Milvus", `Error in findRelevantVoiceInMilvus: ${error}`);
    return [];
  }
}

/**
 * Inserts or updates user information in the user_info collection using upsert.
 *
 * @param {string} userId - The ID of the user associated with the collection.
 * @param {object} userInfo - The user information object.
 * @returns {Promise<void>}
 */
async function upsertUserInfo(userId, userInfo) {
  try {
    const collectionName = `${await retrieveConfigValue("milvus.collections.user")}_${userId}`;
    const userEmbedding = await getMessageEmbedding(userInfo.username);

    const fieldsData = [
      {
        embedding: userEmbedding,
        username: userInfo.username,
        gender: userInfo.gender || "",
        age: userInfo.age || 0,
        residence: userInfo.residence || "",
      },
    ];

    await client.upsert({
      collection_name: collectionName,
      fields_data: fieldsData,
    });

    logger.log(
      "Milvus",
      `User info for ${userInfo.username} upserted in collection ${collectionName}.`,
    );
  } catch (error) {
    logger.log("Milvus", `Error upserting user info: ${error}`);
  }
}

async function findUserInMilvus(username, userId) {
  try {
    const collectionName = `${await retrieveConfigValue("milvus.collections.user")}_${userId}`; // Add _${userId} to the collection name

    // Check if the collection exists and load it if necessary
    const collectionExists = await client.hasCollection({
      collection_name: collectionName,
    });

    if (!collectionExists.value) {
      logger.log("Milvus", `Collection ${collectionName} does not exist.`);
      return null;
    } else {
      const isLoaded = await loadCollectionIfNeeded(collectionName, userId);
      if (!isLoaded) {
        logger.log("Milvus", `Collection ${collectionName} is not loaded.`);
        return null;
      }
    }

    // Generate embedding for the username
    const usernameEmbedding = await getMessageEmbedding(username);
    const binaryEmbedding = Buffer.from(usernameEmbedding);

    // Perform the search
    const searchParams = {
      collection_name: collectionName,
      data: binaryEmbedding,
      search_params: buildSearchParams({
        anns_field: "embedding",
        topk: 1,
        metric_type: MetricType.JACCARD,
        params: JSON.stringify({ nprobe: 128 }),
      }),
      vector_type: DataType.BinaryVector,
      output_fields: ["gender", "age", "residence"],
    };

    const searchResponse = await client.search(searchParams);

    if (searchResponse.results.length > 0) {
      const user = searchResponse.results[0];
      return user;
    } else {
      logger.log(
        "Milvus",
        `User ${username} not found in collection ${collectionName}.`,
      );
      return null;
    }
  } catch (error) {
    logger.log("Milvus", `Error searching for user: ${error}`);
    return null;
  }
}

/**
 * Inserts vectors into a Milvus collection.
 * @param {object[]} data - The data to insert, containing embedding, relation, and content.
 * @param {string} collection - The name of the collection.
 * @param {string} userId - The user ID.
 * @returns {Promise<void>}
 */
async function insertVectorsToMilvus(data, collection, userId) {
  const fieldsData = data.map((item) => ({
    embedding: item.embedding,
    relation: item.relation,
    text_content: item.content,
  }));

  try {
    const insertResponse = await client.insert({
      collection_name: `${collection}_${userId}`,
      fields_data: fieldsData,
    });

    if (insertResponse.status.error_code === "Success") {
      logger.log(
        "Milvus",
        `Inserted ${data.length} new items into ${collection}_${userId}`,
      );
    } else {
      logger.log(
        "Milvus",
        `Failed to insert data into ${collection}_${userId}. Reason: ${insertResponse.status.reason}`,
      );
    }
  } catch (error) {
    logger.log("Milvus", `Error inserting vectors: ${error}`);
  }
}

/**
 * Upserts intelligence vectors into a Milvus collection.
 *
 * @param {object[]} data - An array of objects, where each object represents a document to upsert.
 * @param {string} collection - The name of the collection.
 * @param {string} userId - The user ID.
 * @returns {Promise<void>}
 */
async function upsertIntelligenceToMilvus(data, collection, userId) {
  if (!data || data.length === 0) {
    logger.log("Milvus", "No data to upsert.");
    return;
  }

  try {
    const upsertResponse = await client.upsert({
      collection_name: `${collection}_${userId}`,
      fields_data: data,
    });

    if (upsertResponse.status.error_code === "Success") {
      logger.log(
        "Milvus",
        `Upserted ${data.length} items into ${collection}_${userId}`,
      );
      return true
    } else {
      logger.log(
        "Milvus",
        `Failed to upsert data into ${collection}_${userId}. Reason: ${upsertResponse.status.reason}`,
      );
      return false
    }
  } catch (error) {
    logger.log("Milvus", `Error upserting data: ${error}`);
  }
}

async function deleteVectorsFromMilvus(relations, collection, userId) {
  try {
    for (const relation of relations) {
      // Assuming 'relation' is the name of the primary key field
      const deleteResponse = await client.deleteEntities({
        collection_name: `${collection}_${userId}`,
        expr: `relation in ['${relation}']`,
      });

      if (deleteResponse.status.error_code === "Success") {
        logger.log(
          "Milvus",
          `Deleted vector with relation '${relation}' from ${collection}_${userId}`,
        );
      } else {
        logger.log(
          "Milvus",
          `Failed to delete vector with relation '${relation}' from ${collection}_${userId}. Reason: ${deleteResponse.status.reason}`,
        );
      }
    }
  } catch (error) {
    logger.log("Milvus", `Error deleting vectors: ${error}`);
  }
}

/**
 * Inserts or updates vectors related to augmented intelligence into a Milvus collection.
 * @param {number[]} vectors - The vector embeddings to insert or update.
 * @param {string} content - The content associated with the vectors.
 * @param {string} relational - A string describing the relationship or category of the content.
 * @param {string} userId - The identifier of the user to whom the data belongs.
 * @returns {Promise<boolean>} - True if the operation was successful, otherwise false.
 */
async function insertAugmentVectorsToMilvus(
  vectors,
  content,
  relational,
  userId,
) {
  try {
    const collectionName = `${await retrieveConfigValue("milvus.collections.intelligence")}_${userId}`;

    const exists = await client.hasCollection({
      collection_name: collectionName,
    });
    if (!exists.value) {
      logger.log("Milvus", `Collection ${collectionName} does not exist.`);
      const created = await checkAndCreateCollection(
        await retrieveConfigValue("milvus.collections.intelligence"),
        userId,
      );
      if (!created) {
        logger.log("Milvus", `Failed to create collection ${collectionName}.`);
        return false;
      }
    }

    const isLoaded = await loadCollectionIfNeeded(
      await retrieveConfigValue("milvus.collections.intelligence"),
      userId,
    );
    if (!isLoaded) {
      logger.log("Milvus", `Failed to load collection ${collectionName}.`);
      return false;
    }

    // Prepare the data for insertion
    const fieldsData = [
      {
        embedding: vectors,
        relation: relational,
        text_content: content,
      },
    ];

    const insertResponse = await client.insert({
      collection_name: collectionName,
      fields_data: fieldsData,
    });

    if (insertResponse.status.error_code === "Success") {
      logger.log(
        "Augment",
        `Inserted/updated data in collection ${collectionName}`,
      );
      return true;
    } else {
      logger.log(
        "Augment",
        `Failed to insert/update data in collection ${collectionName}. Reason: ${insertResponse.status.reason}`,
      );
      return false;
    }
  } catch (error) {
    logger.log("Augment", `Error in insertAugmentVectorsToMilvus: ${error}`);
    return false;
  }
}

/**
 * Retrieves web context, summarizes it, and stores it in Milvus.
 * @param {string[]} urls - The URLs to pull content from.
 * @param {string} query - The search query.
 * @param {string} subject - The subject of the search.
 * @param {string} userId - The user ID.
 * @returns {Promise<string|boolean>} - The summary string or false if failed.
 */
// In ai-logic.js, replace the entire function body of retrieveWebContext with the following:
/**
 * Retrieves web context, summarizes it, and stores it in Milvus.
 * @param {object[]} urls - Array of URL objects from Brave search.
 * @param {string} query - The search query.
 * @param {string} subject - The subject of the search.
 * @param {string} userId - The user ID.
 * @returns {Promise<string|boolean>} - The summary string or false if failed.
 */
async function retrieveWebContext(urls, query, subject, userId) {
  try {
    logger.log(
      "LLM",
      `Starting summarization based on search term: '${query}'`,
    );

    const pageContents = await pullFromWeb(urls, subject);
    if (!pageContents || pageContents.trim() === "") {
      logger.log("Augment", "No data to summarize for the search.");
      return false; // Return false if no content found
    }

    const instruct = await summaryPrompt(pageContents);

    const chatTask = await sendChatCompletionRequest(instruct, await retrieveConfigValue("models.summary"))

    const summaryOutput = `### Summary of ${subject}:\n${chatTask.response}`;

    const embeddingArray = await getMessageEmbedding(subject);

    const upsertData = [
      {
        relation: subject,
        text_content: summaryOutput,
        embedding: embeddingArray,
      },
    ];

    // Upsert to Milvus
    const upsertResult = await upsertIntelligenceToMilvus(
      upsertData,
      await retrieveConfigValue("milvus.collections.intelligence"),
      userId,
    );

    if (upsertResult) {
      logger.log("Augment", `Stored summary for '${subject}' into vector DB. Generation time: ${chatTask.tokensPerSecond}`);
      return summaryOutput;
    } else {
      logger.log(
        "Augment",
        `Failed to store summary for '${subject}' into vector DB.`,
        "err",
      );
      return false;
    }
  } catch (error) {
    logger.log(
      "Augment",
      `Failed to retrieve context for query: '${query}' due to error: ${error}`,
      "err",
    );
    return false;
  }
}

/**
 * Searches the Brave API for web results.
 * @param {string} query - The search query.
 * @param {string} freshness - The freshness parameter for the search.
 * @returns {Promise<object[]>} - An array of web results.
 */
async function searchBraveAPI(query, freshness) {
  try {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("result_filter", "web");
    // Add Goggles ID if you have one or remove the line if not applicable
    // url.searchParams.set('goggles_id', 'your_goggles_id');
    url.searchParams.set("freshness", freshness);

    const httpsAgent = new https.Agent({
      keepAlive: true,
      rejectUnauthorized: true,
      timeout: 10000,
    });

    const response = await fetch(url.toString(), {
      method: "GET",
      agent: httpsAgent,
      headers: {
        "X-Subscription-Token": await retrieveConfigValue("brave.apiKey"),
        Accept: "application/json",
        "User-Agent": "curl/7.68.0", // You can change this to a custom user agent if needed
      },
    });

    const data = await response.json();
    if (data && data.web && Array.isArray(data.web.results)) {
      const chosenResults = data.web.results.slice(0, 3);
      return chosenResults;
    } else {
      logger.log(
        "Brave Search",
        `No web results found from Brave for '${query}' using freshness '${freshness}'`,
        "err",
      );
      return [];
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

/**
 * Infers a search parameter from a query using a specified model.
 * @param {string} query - The query to infer the search parameter from.
 * @param {string} userId - The user ID.
 * @returns {Promise<string>} - The inferred search parameter, or "pass" if the query builder opts out.
 */
async function inferSearchParam(query, userId) {
  try {
    var instruct = await queryPrompt(query, userId);

    const chatTask = await sendChatCompletionRequest(instruct, await retrieveConfigValue("models.query"))

    if (
      !chatTask.response.includes(";") ||
      chatTask.response.toLowerCase() === "pass"
    ) {
      logger.log("LLM", `Query builder opted out of search for this query.`);
      return "pass";
    } else {
      logger.log("LLM", `Returned optimized search param: '${chatTask.response}'. Time to generate: ${chatTask.tokensPerSecond}t/s`);
      return chatTask.response;
    }
  } catch (error) {
    logger.log("LLM", `Error inferring search parameter: ${error}`);
    return "pass"; // Return "pass" to indicate failure or opt-out
  }
}

/**
 * Inserts chat vectors into a Milvus collection.
 * @param {number[]} vectors - The vector embeddings for the chat.
 * @param {string} message - The raw chat message.
 * @param {string} sumText - The summarized chat text.
 * @param {string} response - The AI's response to the chat.
 * @param {string} user - The username associated with the chat.
 * @param {string} date - The timestamp of the chat.
 * @param {string} userId - The user ID.
 * @returns {Promise<boolean>} - True if the operation was successful, false otherwise.
 */
async function insertChatVectorsToMilvus(
  vectors,
  message,
  sumText,
  response,
  user,
  date,
  userId,
) {
  try {
    const collectionName = `${await retrieveConfigValue("milvus.collections.chat")}_${userId}`;

    const exists = await client.hasCollection({
      collection_name: collectionName,
    });
    if (!exists.value) {
      logger.log("Milvus Chat", `Collection ${collectionName} does not exist.`);
      const created = await checkAndCreateCollection(
        await retrieveConfigValue("milvus.collections.chat"),
        userId,
      );
      if (!created) {
        logger.log(
          "Milvus Chat",
          `Could not spawn collection '${collectionName}'`,
        );
        return false;
      }
    }

    const isLoaded = await loadCollectionIfNeeded(
      await retrieveConfigValue("milvus.collections.chat"),
      userId,
    );
    if (!isLoaded) {
      logger.log(
        "Milvus Chat",
        `Failed to load collection '${collectionName}'`,
      );
      return false;
    }

    const fieldsData = [
      {
        embedding: vectors,
        username: user,
        text_content: sumText,
        raw_msg: message,
        ai_message: response,
        time_stamp: date,
      },
    ];

    const insertResponse = await client.insert({
      collection_name: collectionName,
      fields_data: fieldsData,
    });

    if (insertResponse.status.error_code === "Success") {
      logger.log("Milvus Chat", `Inserted chat vectors into ${collectionName}`);
      return true;
    } else {
      logger.log(
        "Milvus Chat",
        `Failed to insert chat vectors into ${collectionName}. Reason: ${insertResponse.status.reason}`,
      );
      return false;
    }
  } catch (error) {
    logger.log("Milvus Chat", `Error inserting chat vectors: ${error}`);
    return false;
  }
}

/**
 * Inserts voice interaction vectors into a Milvus collection.
 * @param {number[]} vectors - The vector embeddings for the voice interaction.
 * @param {string} summary - A summary of the voice interaction.
 * @param {string} message - The user's voice message.
 * @param {string} response - The AI's response to the voice message.
 * @param {string} user - The username associated with the voice interaction.
 * @param {string} date - The timestamp of the voice interaction.
 * @param {string} userId - The user ID.
 * @returns {Promise<boolean>} - True if the operation was successful, false otherwise.
 */
async function insertVoiceVectorsIntoMilvus(
  vectors,
  summary,
  message,
  response,
  user,
  date,
  userId,
) {
  try {
    const collectionName = `${await retrieveConfigValue("milvus.collections.voice")}_${userId}`;

    const exists = await client.hasCollection({
      collection_name: collectionName,
    });
    if (!exists.value) {
      logger.log(
        "Milvus Voice",
        `Collection ${collectionName} does not exist.`,
      );
      const created = await checkAndCreateCollection(
        await retrieveConfigValue("milvus.collections.voice"),
        userId,
      );
      if (!created) {
        logger.log(
          "Milvus Voice",
          `Could not spawn collection '${collectionName}'`,
        );
        return false;
      }
    }

    const isLoaded = await loadCollectionIfNeeded(
      await retrieveConfigValue("milvus.collections.voice"),
      userId,
    );
    if (!isLoaded) {
      logger.log(
        "Milvus Voice",
        `Failed to load collection '${collectionName}'`,
      );
      return false;
    }

    const fieldsData = [
      {
        embedding: vectors,
        username: user,
        user_message: message,
        ai_resp: response,
        summary: summary,
        date_time: date,
      },
    ];

    const insertResponse = await client.insert({
      collection_name: collectionName,
      fields_data: fieldsData,
    });

    if (insertResponse.status.error_code === "Success") {
      logger.log(
        "Milvus Voice",
        `Inserted voice interaction vectors into ${collectionName}`,
      );
      return true;
    } else {
      logger.log(
        "Milvus Voice",
        `Failed to insert voice interaction vectors into ${collectionName}. Reason: ${insertResponse.status.reason}`,
      );
      return false;
    }
  } catch (error) {
    logger.log(
      "Milvus Voice",
      `Error inserting voice interaction vectors: ${error}`,
    );
    return false;
  }
}

/**
 * Reads files recursively from a directory and returns an array of file paths with a .json extension.
 * @param {string} directory - The directory to read files from.
 * @returns {Promise<string[]>} - An array of file paths.
 */
async function readFilesFromDirectory(directory) {
  const files = [];
  try {
    const items = await fs.readdir(directory, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(directory, item.name);
      if (item.isDirectory()) {
        const subDirFiles = await readFilesFromDirectory(fullPath);
        files.push(...subDirFiles);
      } else if (item.isFile() && path.extname(item.name) === ".json") {
        files.push(fullPath);
      }
    }
  } catch (error) {
    logger.log("File System", `Error reading directory ${directory}: ${error}`);
    return []; // Return an empty array to indicate failure
  }
  return files;
}

/**
 * Checks if a collection exists in Milvus, and creates it if it doesn't.
 * @param {string} collection - The name of the collection to check.
 * @param {string} userId - The user ID.
 * @returns {Promise<boolean>} - True if the collection exists or was created, false otherwise.
 */
async function checkAndCreateCollection(collection, userId) {
  try {
    const exists = await client.hasCollection({
      collection_name: `${collection}_${userId}`,
    });

    if (!exists.value) {
      logger.log(
        "Milvus",
        `Collection '${collection}_${userId}' does not exist. Attempting to create...`,
      );
      await createCollection(collection, userId);
      logger.log(
        "Milvus",
        `Collection '${collection}_${userId}' creation attempted.`,
      );
      return true; // Collection was created or creation was attempted
    } else {
      logger.log(
        "Milvus",
        `Collection '${collection}_${userId}' already exists.`,
      );
      return true; // Collection already exists
    }
  } catch (error) {
    logger.log(
      "Milvus",
      `Error checking or creating collection '${collection}_${userId}': ${error}`,
    );
    return false; // Indicate failure
  }
}

/**
 * Sends file content to a vectorization service to convert it into a structured format.
 * @param {object} fileContent - The content of the file to be vectorized.
 * @returns {Promise<object>} - An object containing the relation, content, filename, and position.
 */
// async function sendFileForVectorization(fileContent) {
//   try {
//     const vectorInstruct = await fs.readFile(
//       "./instructs/helpers/convert.prompt",
//       "utf-8",
//     );
//     const openai = new OpenAI({
//       baseURL: await retrieveConfigValue("models.conversion.endpoint"),
//       apiKey: await retrieveConfigValue("models.conversion.apiKey"),
//     });

//     const completion = await openai.chat.completions.create({
//       model: await retrieveConfigValue("models.conversion.model"),
//       messages: [
//         {
//           role: "system",
//           content: vectorInstruct,
//         },
//         {
//           role: "user",
//           content: JSON.stringify(fileContent.content),
//         },
//       ],
//     });
//     const returnArray = completion.choices[0].message.content.split(";");
//     return {
//       relation: returnArray[0],
//       content: fileContent.content,
//       filename: returnArray[1],
//       position: fileContent.position,
//     };
//   } catch (error) {
//     logger.log("Vectorization", `Error vectorizing file content: ${error}`);
//     return null; // Indicate failure
//   }
// }

/**
 * Compares local and remote documents and determines necessary actions (insert, update, delete).
 *
 * @param {string} directory - The directory containing the local files.
 * @param {string} userId - The user ID.
 * @param {string} collectionName - The name of the Milvus collection.
 * @returns {Promise<object>} - An object containing arrays for missing, update, and remove actions.
 */
async function compareDocuments(directory, userId, collectionName) {
  // Get local file data
  const filenames = await readFilesFromDirectory(`${directory}/${userId}`);
  const localDocuments = (
    await Promise.all(
      filenames.map(async (filename) => {
        try {
          const content = await fs.readFile(filename, "utf8");
          return isValidJson(content) ? JSON.parse(content) : null;
        } catch (error) {
          logger.log(
            "File System",
            `Error reading or parsing file ${filename}: ${error}`,
          );
          return null;
        }
      }),
    )
  ).filter((content) => content !== null);

  // Get existing documents from Milvus
  const existingDocsResponse = await client.query({
    collection_name: collectionName,
    output_fields: ["relation", "text_content", "embedding"],
    limit: 10000,
  });

  logger.log(
    "Milvus",
    `Retrieved ${existingDocsResponse.data.length} existing documents from Milvus for user ${userId}.`,
  );

  const existingDocsMap = new Map(
    existingDocsResponse.data.map((doc) => [doc.relation, doc]),
  );

  // Prepare data for comparison
  const toInsert = [];
  const toUpdate = [];
  const toDelete = new Set(existingDocsMap.keys());

  for (const localDoc of localDocuments) {
    if (!localDoc || !localDoc.relation || localDoc.content === undefined) {
      logger.log(
        "Milvus",
        `Skipping invalid local document: ${JSON.stringify(localDoc)}`,
      );
      continue;
    }
    const existingDoc = existingDocsMap.get(localDoc.relation);

    // Get the embedding for the relation
    const embedding = await getMessageEmbedding(localDoc.relation);
    const flattenedEmbedding = embedding.flat(); // Flatten the embedding here

    if (!existingDoc) {
      // New document: add to toInsert
      toInsert.push({
        relation: localDoc.relation,
        text_content: localDoc.content,
        embedding: flattenedEmbedding,
      });
    } else {
      // Existing document: remove from deletion set, check for content change
      toDelete.delete(localDoc.relation);

      // Log localDoc.content and existingDoc.text_content for debugging

      if (existingDoc.text_content !== localDoc.content) {
        // Modified document: add to toUpdate
        toUpdate.push({
          relation: localDoc.relation,
          text_content: localDoc.content,
          embedding: flattenedEmbedding,
        });
      } else {
      }
    }
  }

  // Format for output
  const result = {
    missing: toInsert,
    update: toUpdate,
    remove: Array.from(toDelete).map((relation) => ({ relation })),
  };

  return result;
}

/**
 * Processes files in a directory, comparing them with the corresponding Milvus collection,
 * and performs necessary operations like upsertion and deletions.
 *
 * @param {string} directory - The directory containing the files to process.
 * @param {string} userId - The user ID.
 * @returns {Promise<void>}
 */
/**
 * Processes files in a directory, comparing them with the corresponding Milvus collection,
 * and performs necessary operations like upsertion and deletions.
 *
 * @param {string} directory - The directory containing the files to process.
 * @param {string} userId - The user ID.
 * @returns {Promise<void>}
 */
async function processFiles(directory, userId) {
  try {
    const collectionName = `${await retrieveConfigValue("milvus.collections.intelligence")}_${userId}`;
    const collectionCreated = await checkAndCreateCollection(
      await retrieveConfigValue("milvus.collections.intelligence"),
      userId,
    );
    if (!collectionCreated) {
      logger.log(
        "Milvus",
        `Failed to create or verify collection for ${userId}.`,
      );
      return;
    }

    const loadedColl = await loadCollectionIfNeeded(
      await retrieveConfigValue("milvus.collections.intelligence"),
      userId,
    );
    if (!loadedColl) {
      logger.log("Milvus", `Failed to load collection for ${userId}.`);
      return;
    }

    // Use the compareDocuments function to get the actions needed
    const actions = await compareDocuments(directory, userId, collectionName);

    // Perform upserts for new and updated documents
    if (actions.missing.length > 0) {
      await upsertIntelligenceToMilvus(
        [...actions.missing],
        await retrieveConfigValue("milvus.collections.intelligence"),
        userId,
      );
      logger.log(
        "Milvus",
        `Adding ${actions.missing.length} documents to ${userId}'s intelligence collection...`,
      );
    }

    if (actions.update.length > 0) {
      await upsertIntelligenceToMilvus(
        [...actions.update],
        await retrieveConfigValue("milvus.collections.intelligence"),
        userId,
      );
      logger.log(
        "Milvus",
        `Updating ${actions.missing.length} documents from ${userId}'s intelligence collection...`,
      );
    }

    // Perform deletions for removed documents
    if (actions.remove.length > 0) {
      await deleteVectorsFromMilvus(
        actions.remove.map((doc) => doc.relation),
        await retrieveConfigValue("milvus.collections.intelligence"),
        userId,
      );
      logger.log(
        "Milvus",
        `Removing ${actions.missing.length} documents from ${userId}'s intelligence collection...`,
      );
    }
  } catch (error) {
    logger.log("Milvus", `Error processing files for ${userId}: ${error}`);
  }
}

/**
 * Responds to a message with context retrieved from Milvus.
 * @param {string} message - The message to respond to.
 * @param {string} username - The username of the sender.
 * @param {string} userID - The user ID.
 * @returns {Promise<string>} - The response string.
 */
async function respondWithContext(message, username, userID) {
  try {
    const [rawContext, voiceCtx, chatHistory] = await Promise.all([
      findRelevantDocuments(message, userID, 8),
      findRelevantVoiceInMilvus(message, userID, 3),
      findRelevantChats(message, username, userID, 3),
    ]);

    const [contextBody, relChatBody, relVoiceBody] = await Promise.all([
      resultsReranked(rawContext, message, userID, true),
      resultsReranked(chatHistory, message, userID),
      resultsReranked(voiceCtx, message, userID),
    ]);

    const promptData = {
      relChats: Array.isArray(relChatBody) ? relChatBody : [],
      relContext: contextBody,
      relVoice: Array.isArray(relVoiceBody) ? relVoiceBody : [],
      user: username,
    };

    const openai = new OpenAI({
      baseURL: await retrieveConfigValue("models.chat.endpoint"),
      apiKey: await retrieveConfigValue("models.chat.apiKey"),
    });
    const body = await contextPromptChat(promptData, message, userID);

    const chatTask = await sendChatCompletionRequest(body, await retrieveConfigValue("models.chat"))

    logger.log("System", `Generated textual character response in ${chatTask.tokensPerSecond}t/s`) 
    return await replyStripped(chatTask.response, userID);
  } catch (error) {
    console.error("Error calling resultsReranked:", error);
  }
}

async function rerankString(message, userId) {
  const promptRerank = await rerankPrompt(message, userId);
  const chatTask = await sendChatCompletionRequest(promptRerank, await retrieveConfigValue("models.rerank"))
  return chatTask.response;
}

async function respondWithoutContext(message, userId) {
  const instruct = await nonContextChatPrompt(message, userId);
  const chatTask = await sendChatCompletionRequest(instruct, await retrieveConfigValue("models.chat"))
  return replyStripped(chatTask.response);
}

async function respondWithVoice(message, userId) {
  const fixedAcro = await fixTTSString(message);
  const userObj = await returnAuthObject(userId);
  logger.log(
    "LLM",
    `Converted ${fixedAcro.acronymCount} acronyms in ${userObj.bot_name}'s TTS message.`,
  );
  const voiceForm = new FormData();
  voiceForm.append("text_input", fixedAcro.fixedString);
  voiceForm.append("text_filtering", "standard");
  voiceForm.append("character_voice_gen", userObj.speaker_file);
  voiceForm.append("narrator_enabled", "false");
  voiceForm.append("text_not_inside", "character");
  voiceForm.append("rvccharacter_voice_gen", userObj.rvc_model);
  voiceForm.append("rvccharacter_pitch", userObj.rvc_pitch);
  voiceForm.append("language", "en");
  voiceForm.append("output_file_name", userObj.user_id);
  voiceForm.append("output_file_timestamp", "true");
  voiceForm.append("autoplay", "false");
  voiceForm.append("temperature", "0.80");
  voiceForm.append("repetition_penalty", "2.0");

  const res = await axios.post(
    new URL(await retrieveConfigValue("alltalk.ttsGenEndpoint.internal")),
    voiceForm
  );

  if (res.status == 200) {
    if (userObj.is_local == true) {
      const audioUrl = `${await retrieveConfigValue("alltalk.ttsServeEndpoint.internal")}${res.data.output_file_url}`;
      return audioUrl;
    } else {
      const audioUrl = `${await retrieveConfigValue("alltalk.ttsServeEndpoint.external")}${res.data.output_file_url}`;
      return audioUrl;
    }
  } else {
    console.error(`Request failed with: ${res.data}`);
  }
}

async function respondToDirectVoice(message, userId, withVoice = false) {
  const fixedAcro = await fixTTSString(message);
  const userObj = await returnAuthObject(userId);
  
  try {
    const [voiceCtx, rawContext] = await Promise.all([
      findRelevantVoiceInMilvus(message, userId, 3),
      findRelevantDocuments(message, userId, 6),
    ]);

    const [contextBody, voiceCtxBody] = await Promise.all([
      resultsReranked(rawContext, message, userId, true),
      withVoice
        ? resultsReranked(voiceCtx, message, userId, false)
        : "- No additional voice conversations to supply.",
    ]);

    const promptData = {
      relChats: "- No additional chat content.",
      relContext: contextBody,
      relVoice: voiceCtxBody,
      user: userObj.player_name,
    };

    const body = await contextPromptChat(promptData, message, userId);
    const chatTask = await sendChatCompletionRequest(body, await retrieveConfigValue("models.chat"))
    logger.log("LLM", `Generated textual response to voice message. Time to generate: ${chatTask.tokensPerSecond}t/s`)
    const strippedResp = await replyStripped(chatTask.response, userId);
    const userObj = await returnAuthObject(userId);
    if (withVoice) {
      const voiceForm = new FormData();
      voiceForm.append("text_input", fixedAcro.fixedString);
      voiceForm.append("text_filtering", "standard");
      voiceForm.append("character_voice_gen", userObj.speaker_file);
      voiceForm.append("narrator_enabled", "false");
      voiceForm.append("text_not_inside", "character");
      voiceForm.append("rvccharacter_voice_gen", userObj.rvc_model);
      voiceForm.append("rvccharacter_pitch", userObj.rvc_pitch);
      voiceForm.append("language", "en");
      voiceForm.append("output_file_name", userObj.user_id);
      voiceForm.append("output_file_timestamp", "true");
      voiceForm.append("autoplay", "false");
      voiceForm.append("temperature", "0.80");
      voiceForm.append("repetition_penalty", "2.0");


      const res = await axios.post(
        `${await retrieveConfigValue("alltalk.ttsGenEndpoint.internal")}`,
        voiceForm,
      );

      if (res.status === 200) {
        logger.log("Voice", `Direct voice response from AllTalk successful.`);
        let audioUrl;
        if (userObj.is_local == true) {
          audioUrl = `${await retrieveConfigValue("alltalk.ttsServeEndpoint.internal")}${res.data.output_file_url}`;
        } else {
          audioUrl = `${await retrieveConfigValue("alltalk.ttsServeEndpoint.external")}${res.data.output_file_url}`;
        }
        return {
          audio_url: `${audioUrl}${res.data.output_file_url}`,
          response: strippedResp,
        };
      } else {
        return strippedResp;
      }
    } else {
      return strippedResp;
    }
  } catch (error) {
    logger.log("Voice", `Error in respondToDirectVoice: ${error}`);
    return "Error processing voice response.";
  }
}

async function addChatMessageAsVector(
  sumText,
  message,
  username,
  date,
  response,
  userId,
) {
  const loadedColl = await loadCollectionIfNeeded(
    await retrieveConfigValue("milvus.collections.chat"),
    userId,
  );
  if (!loadedColl) {
    logger.log("Milvus", `Can't load collection for chat.`);
    return; // Early return on failure
  }

  try {
    const embeddingsArray = await getMessageEmbedding(sumText);
    const success = await insertChatVectorsToMilvus(
      embeddingsArray,
      message,
      sumText,
      response,
      username,
      date,
      userId,
    );
    if (success) {
      logger.log("Milvus", "Chat text successfully inserted into Milvus.");
    } else {
      logger.log("Milvus", "Failed to insert chat text into Milvus.");
    }
  } catch (error) {
    logger.log("Milvus", `Error processing chat text: ${error}`);
  }
}

async function addVoiceMessageAsVector(
  sumString,
  message,
  username,
  date,
  response,
  userId,
) {
  const loadedColl = await loadCollectionIfNeeded(
    await retrieveConfigValue("milvus.collections.voice"),
    userId,
  );
  if (!loadedColl) {
    logger.log("Milvus", `Can't load collection for voice.`);
    return; // Early return on failure
  }

  try {
    const embeddingsArray = await getMessageEmbedding(message);
    const success = await insertVoiceVectorsIntoMilvus(
      embeddingsArray,
      sumString,
      message,
      response,
      username,
      date,
      userId,
    );
    if (success) {
      logger.log("Milvus", "Voice message successfully inserted into Milvus.");
    } else {
      logger.log("Milvus", "Failed to insert voice message into Milvus.");
    }
  } catch (error) {
    logger.log("Milvus", `Error processing voice message: ${error}`);
  }
}

async function respondToEvent(event, userId) {
  const eventMessage = await returnTwitchEvent(event, userId);
  const instructPrompt = await eventPromptChat(eventMessage, userId);

  const chatTask = await sendChatCompletionRequest(instructPrompt, await retrieveConfigValue("models.chat"))
  logger.log("LLM", `Generated event response. Time to generate: ${chatTask.tokensPerSecond}t/s`)
  const strippedResponse = await replyStripped(
    chatTask.response,
    userId,
  );
  return strippedResponse;
}

async function startIndexingVectors(userId) {
  const authObjects = await returnAuthObject(userId);
  logger.log("Milvus", `Beginning indexing for ${authObjects.user_id}`);
  await processFiles(
    `${await retrieveConfigValue("milvus.localTextDirectory")}`,
    authObjects.user_id,
  );
}

async function checkMilvusHealth() {
  const isUp = await client.checkHealth();
  return isUp.isHealthy;
}

/**
 * Drops specified collection(s) in Milvus based on the provided parameters.
 * Supports dropping a single collection for a user, all collections of a type for a user,
 * or all collections for all users.
 *
 * @param {string} collection - The name of the collection to drop, or "all" for all collections.
 * @param {string} userId - The ID of the user, or "all" for all users.
 * @returns {Promise<boolean>} - True if the operation was successful, false otherwise.
 */
async function weGottaGoBald(collection, userId) {
  try {
    if (userId === "all") {
      // Reload all specified collections for all users
      const allUsers = await returnAPIKeys();
      let allDropsSuccessful = true;

      for (const user of allUsers) {
        if (collection === "all") {
          const allCollections = [
            await retrieveConfigValue("milvus.collections.user"),
            await retrieveConfigValue("milvus.collections.intelligence"),
            await retrieveConfigValue("milvus.collections.chat"),
            await retrieveConfigValue("milvus.collections.voice"),
          ];
          for (const coll of allCollections) {
            const success = await dropCollection(coll, user.user_id);
            if (!success) {
              allDropsSuccessful = false;
            }
          }
        } else {
          const success = await dropCollection(collection, user.user_id);
          if (!success) {
            allDropsSuccessful = false;
          }
        }
      }
      return allDropsSuccessful;
    } else {
      // Reload a specific collection for a specific user
      return await dropCollection(collection, userId);
    }
  } catch (error) {
    logger.log("Milvus", `Error during database reload: ${error}`);
    return false;
  }
}

/**
 * Drops a specified collection in Milvus for a given user.
 *
 * @param {string} collection - The name of the collection to drop.
 * @param {string} userId - The ID of the user associated with the collection.
 * @returns {Promise<boolean>} - True if the collection was dropped successfully, false otherwise.
 */
async function dropCollection(collection, userId) {
  const collectionName = `${collection}_${userId}`;
  try {
    const exists = await client.hasCollection({
      collection_name: collectionName,
    });

    if (!exists.value) {
      logger.log("Milvus", `Collection '${collectionName}' does not exist.`);
      return false;
    }

    const status = await client.dropCollection({
      collection_name: collectionName,
    });

    if (status.error_code === "Success") {
      logger.log(
        "Milvus",
        `Collection '${collectionName}' dropped successfully.`,
      );
      return true;
    } else {
      logger.log(
        "Milvus",
        `Failed to drop collection '${collectionName}'. Reason: ${status.reason}`,
      );
      return false;
    }
  } catch (error) {
    logger.log(
      "Milvus",
      `Error dropping collection '${collectionName}': ${error}`,
    );
    return false;
  }
}

const isValidJson = (input) => {
  if (typeof input === "string") {
    try {
      JSON.parse(input);
      return true;
    } catch {
      return false;
    }
  } else if (typeof input === "object" && input !== null) {
    return true;
  }
  return false;
};

async function checkEndpoint(endpoint, key, modelName) {
  try {
    if (endpoint === (await retrieveConfigValue("models.embedding.endpoint"))) {
      if (
        (await retrieveConfigValue("models.embedding.apiKeyType")) ===
        "infinity"
      ) {
        const response = await axios.get(`${endpoint}/models`, {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          validateStatus: (status) => status < 500,
        });

        if (
          response.status === 200 &&
          response.data &&
          Array.isArray(response.data.data)
        ) {
          const modelFound = response.data.data.some(
            (model) => model.id === modelName,
          );
          if (modelFound) {
            return true;
          } else {
            throw new Error(
              `Model ${modelName} not found in the list of available models.`,
            );
          }
        } else {
          throw new Error(
            `Invalid response from embedding endpoint: ${response.status}`,
          );
        }
      } else {
        const openai = new OpenAI({
          baseURL: endpoint,
          apiKey: key,
        });
        const response = await openai.models.embedding.list();
        if (response.data.id) {
          return true;
        } else {
          throw new Error(`No response from the provided OpenAI API key.`);
        }
      }
    } else {
      const openai = new OpenAI({
        baseURL: endpoint,
        apiKey: key,
      });
      const response = await openai.models.list();
      if (
        response.data &&
        Array.isArray(response.data) &&
        response.data.length > 0
      ) {
        return true;
      } else {
        throw new Error(`Invalid or empty response from LLM endpoint`);
      }
    }
  } catch (err) {
    logger.log("INIT", `Error checking endpoint ${endpoint}: ${err}`);
    throw err;
  }
}

export {
  checkEndpoint,
  respondWithContext,
  checkMilvusHealth,
  inferSearchParam,
  retrieveWebContext,
  rerankString,
  searchBraveAPI,
  respondToDirectVoice,
  addVoiceMessageAsVector,
  loadCollectionIfNeeded,
  addChatMessageAsVector,
  insertAugmentVectorsToMilvus,
  respondWithoutContext,
  getMessageEmbedding,
  respondWithVoice,
  respondToEvent,
  processFiles,
  startIndexingVectors,
  findRelevantVoiceInMilvus,
  findRelevantDocuments,
  weGottaGoBald,
  checkAndCreateCollection,
};