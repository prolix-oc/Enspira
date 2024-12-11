import axios from 'axios';
import fs from "fs-extra"
import path from 'path';
import util from 'util'
import * as child_process from 'child_process'
import moment from 'moment';
import { MilvusClient, DataType, MetricType, IndexType, ConsistencyLevelEnum, LoadState, buildSearchParams } from '@zilliz/milvus2-sdk-node';
import { error } from 'console';
import OpenAI from 'openai';
import FormData from 'form-data';
import { promptTokenCount, promptWithBody, replyStripped, queryPrompt, summaryPrompt, contextPromptChat, eventPromptChat, rerankPrompt } from './prompt-helper.js';
import { returnTwitchEvent } from './twitch_helper.js';
import { resultsReranked, interpretEmotions, pullFromWeb } from './data-helper.js';
import { returnAPIKeys, returnAuthObject } from './api-helper.js';

const intelligenceSchema = (userId) => {
    return {
        collection_name: `${process.env.INTELLIGENCE_COLLECTION}_${userId}`,
        consistency_level: ConsistencyLevelEnum.Strong,
        schema: [
            {
                name: 'embedding',
                data_type: DataType.FloatVector,
                dim: 1024,
                is_primary_key: false,
                auto_id: false,
            },
            {
                name: 'relation',
                data_type: DataType.VarChar,
                max_length: 256,
                is_primary_key: true,
                auto_id: false
            },
            {
                name: 'text_content',
                data_type: DataType.VarChar,
                max_length: 16384,
                is_primary_key: false,
                auto_id: false
            }
        ],
        index_params: [
            {
                field_name: 'embedding',
                index_name: 'emb_lookup',
                index_type: IndexType.HNSW,
                metric_type: MetricType.COSINE,
                params: { M: 48, efConstruction: 200 }
            }
        ]
    }

}

const chatSchema = (userId) => {
    return {
        collection_name: `${process.env.CHAT_COLLECTION}_${userId}`,
        consistency_level: ConsistencyLevelEnum.Strong,
        schema: [
            {
                name: 'embedding',
                data_type: DataType.FloatVector,
                dim: 1024,
                is_primary_key: false,
                auto_id: false,
            },
            {
                name: 'username',
                data_type: DataType.VarChar,
                max_length: 256,
                is_primary_key: true,
                auto_id: false
            },
            {
                name: 'text_content',
                data_type: DataType.VarChar,
                max_length: 4096,
                is_primary_key: false,
                auto_id: false
            },
            {
                name: 'raw_msg',
                data_type: DataType.VarChar,
                max_length: 1024,
                is_primary_key: false,
                auto_id: false
            },
            {
                name: 'ai_message',
                data_type: DataType.VarChar,
                max_length: 1024,
                is_primary_key: false,
                auto_id: false
            },
            {
                name: 'time_stamp',
                data_type: DataType.VarChar,
                max_length: 256,
                is_primary_key: false,
                auto_id: false
            }
        ],
        index_params: [
            {
                field_name: 'embedding',
                index_name: 'emb_chat_lookup',
                index_type: IndexType.HNSW,
                metric_type: MetricType.COSINE,
                params: { M: 48, efConstruction: 200 }
            }
        ]
    }

}

const voiceSchema = (userId) => {
    return {
        collection_name: `${process.env.VOICE_COLLECTION}_${userId}`,
        consistency_level: ConsistencyLevelEnum.Strong,
        schema: [
            {
                name: 'embedding',
                data_type: DataType.FloatVector,
                dim: 1024,
                is_primary_key: false,
                auto_id: false,
            },
            {
                name: 'username',
                data_type: DataType.VarChar,
                max_length: 32,
                is_primary_key: false,
                auto_id: false
            },
            {
                name: 'user_message',
                data_type: DataType.VarChar,
                max_length: 256,
                is_primary_key: true,
                auto_id: false
            },
            {
                name: 'ai_resp',
                data_type: DataType.VarChar,
                max_length: 4096,
                is_primary_key: false,
                auto_id: false
            },
            {
                name: 'summary',
                data_type: DataType.VarChar,
                max_length: 4096,
                is_primary_key: false,
                auto_id: false
            },
            {
                name: 'date_time',
                data_type: DataType.VarChar,
                max_length: 1024,
                is_primary_key: false,
                auto_id: false
            }
        ],
        index_params: [
            {
                field_name: 'embedding',
                index_name: 'emb_voice_lookup',
                index_type: IndexType.HNSW,
                metric_type: MetricType.COSINE,
                params: { M: 48, efConstruction: 200 }
            }
        ]
    }

};

const now = moment();
const execute = util.promisify(child_process.exec)
const client = new MilvusClient({ address: process.env.MILVUS_URL });

async function returnCollectionSchema(collection, userId) {
    switch (collection) {
        case "intelligence":
            return intelligenceSchema(userId)
            break;
        case "twitch_chat":
            return chatSchema(userId)
            break;
        case "vocal":
            return voiceSchema(userId)
            break;
        default:
            logger.log('Milvus', `No schema defined for collection ${collection}`)
            break;
    }
}
const authTokens = await returnAPIKeys()

async function createCollection(collection, userId) {
    logger.log('Milvus', `Recreating collection '${collection}' from scratch... for ${userId}`)
    try {
        const schema = await returnCollectionSchema(collection, userId)
        const response = await client.createCollection(schema);
        logger.log('Milvus', `Collection '${collection}_${userId}' created with response: ${response.reason}`);
    } catch (error) {
        logger.log('Milvus', `Error in creation: ${error}`);
    }
}

async function getCollectionSchema(collection, userId) {
    try {
        const schemaResponse = await client.describeCollection({ collection_name: `${collection}_${userId}` });
        return schemaResponse.schema;
    } catch (error) {
        logger.log('Milvus', `Error fetching schema: ${error}`);
        throw error;
    }
}

async function loadCollectionIfNeeded(collectionName, userId) {
    try {
        const collectionStatus = await client.getLoadState({ collection_name: `${collectionName}_${userId}` });
        if (collectionStatus.state === LoadState.LoadStateNotExist) {
            logger.log('Milvus', `Collection ${collectionName}_${userId} does not exist`);
            return false;
        } else if (collectionStatus.state === LoadState.LoadStateNotLoad) {
            await client.loadCollection({ collection_name: `${collectionName}_${userId}` });
            logger.log('Milvus', `Collection ${collectionName}_${userId} loaded successfully.`);
            return true;
        } else {
            return true;
        }

    } catch (error) {
        logger.log('Milvus', `Error loading collection: ${error}`);
        throw error;
    }
}

async function getMessageEmbedding(message) {
    const embeddingData = {
        input: Array.isArray(message) ? message : [message],
        model: process.env.EMBEDDING_MODEL
    }
    try {
        const response = await axios.post(process.env.EMBEDDING_ENDPOINT + "/embeddings", embeddingData);
        const embeddingResp = response.data.data;
        if (embeddingResp.length > 1) {
            return embeddingResp
        } else {
            return embeddingResp[0].embedding
        }
    } catch (error) {
        logger.log('System', `Error generating embedding: ${error}`);
        throw error;
    }
}

async function searchDocumentsInMilvus(queryEmbedding, collectionName, textParam, limit, userId, query) {
    if (queryEmbedding.length > 0) {
        try {
            const searchParams = {
                collection_name: `${collectionName}_${userId}`,
                vector: [queryEmbedding],
                topk: 20,
                metric_type: MetricType.COSINE,
                output_fields: [`${textParam}`],
                vector_type: DataType.FloatVector,
                search_params: buildSearchParams({ ef: 300, limit: limit, range_filter: 0.9, radius: 0.7 }),
                consistency_level: ConsistencyLevelEnum.Strong
            };

            const searchResponse = await client.search(searchParams);

            return searchResponse;

        } catch (error) {
            logger.log('Milvus', `Error searching in Milvus: ${error}`);
            throw error;
        }
    } else {
        logger.log('Milvus', 'Collection was empty.')
    }
}

async function findRelevantChats(message, user, userId, topK = 10) {
    try {
        const created = await checkAndCreateCollection(process.env.CHAT_COLLECTION, userId)
        if (!created) {
            logger.log('Milvus', "It's fucked.")
            return false;
        } else {
            const loadCollect = await loadCollectionIfNeeded(process.env.VOICE_COLLECTION, userId);
            logger.log('Milvus', "We loaded the fucker " + loadCollect)
            logger.log('Milvus', "It's unfucked.")
        }
        const messageEmbedding = await getMessageEmbedding(message);
        logger.log('Milvus', `Message embedding dimension: ${messageEmbedding.length}`);
        const collectionSchema = await getCollectionSchema(process.env.CHAT_COLLECTION, userId);

        logger.log('Milvus', `Schema loaded.`);

        const embeddingField = collectionSchema.fields.find(field => field.name === 'embedding');
        logger.log('Milvus', `Found relevant embeddings.`)
        const expectedDim = embeddingField && embeddingField.type_params[0] ? parseInt(embeddingField.type_params[0].value) : undefined;

        if (expectedDim === undefined) {
            logger.log('Milvus', 'Could not retrieve the expected dimension for the embedding field.');
            return;
        }

        logger.log('Milvus', `Expected Dimension: ${expectedDim}`);

        if (messageEmbedding.length !== expectedDim) {
            logger.log('Milvus', `Dimension mismatch: expected ${expectedDim}, got ${messageEmbedding.length}.`);
            return;
        }

        const chatSearchResponse = await searchDocumentsInMilvus(messageEmbedding, `${process.env.CHAT_COLLECTION}`, 'text_content', topK, userId);
        logger.log('Milvus', `Found these results: ${JSON.stringify(chatSearchResponse.results)}`)
        return chatSearchResponse.results

    } catch (error) {
        logger.log('Milvus', `Error in findRelevantChats: ${error}`);
    }
}

async function findRelevantDocuments(message, userId, topK = 10) {
    const exists = await client.hasCollection({ collection_name: `${process.env.INTELLIGENCE_COLLECTION}_${userId}` });
    if (!exists.value) {
        logger.log('Milvus', `Collection ${process.env.INTELLIGENCE_COLLECTION}_${userId} does not exist.`);
        const created = await checkAndCreateCollection(process.env.INTELLIGENCE_COLLECTION, userId)
        if (!created) {
            logger.log('Milvus', "It's fucked.")
            return false;
        } else {
            const loadCollect = await loadCollectionIfNeeded(process.env.INTELLIGENCE_COLLECTION, userId);
            logger.log('Milvus', "We loaded the fucker " + loadCollect)
            logger.log('Milvus', "It's unfucked.")
        }
    }
    try {
        const isLoaded = await loadCollectionIfNeeded(process.env.INTELLIGENCE_COLLECTION, userId);
        if (!isLoaded) {
            logger.log('Milvus', `Failed to load collection: ${process.env.INTELLIGENCE_COLLECTION}_${userId}. Exiting search.`);
            return;
        }

        const messageEmbedding = await getMessageEmbedding(message);
        logger.log('Milvus', `Message embedding dimension: ${messageEmbedding.length}`);
        const collectionSchema = await getCollectionSchema(process.env.INTELLIGENCE_COLLECTION, userId);

        logger.log('Milvus', `Schema loaded.`);

        const embeddingField = collectionSchema.fields.find(field => field.name === 'embedding');
        logger.log('Milvus', `Found embeddings field.`)
        const expectedDim = embeddingField && embeddingField.type_params[0] ? parseInt(embeddingField.type_params[0].value) : undefined;

        if (expectedDim === undefined) {
            logger.log('Milvus', 'Could not retrieve the expected dimension for the embedding field.');
            return;
        }

        logger.log('Milvus', `Expected Dimension: ${expectedDim}`);

        if (messageEmbedding.length !== expectedDim) {
            logger.log('Milvus', `Dimension mismatch: expected ${expectedDim}, got ${messageEmbedding.length}.`);
            return;
        }

        const searchResponse = await searchDocumentsInMilvus(messageEmbedding, `${process.env.INTELLIGENCE_COLLECTION}`, 'text_content', topK, userId);
        return searchResponse.results
    } catch (error) {
        logger.log('Milvus', `Error in findRelevantDocuments: ${error}`);
    }
}

async function findRelevantVoiceInMilvus(message, userId, topK = 5) {
    const exists = await client.hasCollection({ collection_name: `${process.env.VOICE_COLLECTION}_${userId}` });
    if (!exists.value) {
        logger.log('Milvus', `Collection ${process.env.INTELLIGENCE_COLLECTION}_${userId} does not exist.`);
        const created = await checkAndCreateCollection(process.env.VOICE_COLLECTION, userId)
        if (!created) {
            logger.log('Milvus', "It's fucked.")
            return false;
        } else {
            const loadCollect = await loadCollectionIfNeeded(process.env.VOICE_COLLECTION, userId);
            logger.log('Milvus', "We loaded the fucker " + loadCollect)
            logger.log('Milvus', "It's unfucked.")
        }
    }
    try {
        const isLoaded = await loadCollectionIfNeeded(process.env.VOICE_COLLECTION, userId);
        if (!isLoaded) {
            logger.log('Milvus', `Failed to load collection: ${process.env.VOICE_COLLECTION}_${userId}. Exiting search.`);
            return;
        }

        const messageEmbedding = await getMessageEmbedding(message);
        logger.log('Milvus', `Message embedding dimension: ${messageEmbedding.length}`);
        const collectionSchema = await getCollectionSchema(process.env.INTELLIGENCE_COLLECTION, userId);

        logger.log('Milvus', `Schema loaded.`);

        const embeddingField = collectionSchema.fields.find(field => field.name === 'embedding');
        logger.log('Milvus', `Found relevant embeddings.`)
        const expectedDim = embeddingField && embeddingField.type_params[0] ? parseInt(embeddingField.type_params[0].value) : undefined;

        if (expectedDim === undefined) {
            logger.log('Milvus', 'Could not retrieve the expected dimension for the embedding field.');
            return;
        }

        logger.log('Milvus', `Expected Dimension: ${expectedDim}`);

        if (messageEmbedding.length !== expectedDim) {
            logger.log('Milvus', `Dimension mismatch: expected ${expectedDim}, got ${messageEmbedding.length}.`);
            return;
        }

        const voiceResponse = await searchDocumentsInMilvus(messageEmbedding, `${process.env.INTELLIGENCE_COLLECTION}`, 'summary', topK, userId);
        return voiceResponse.results
    } catch (error) {
        logger.log('Milvus', `Error in findRelevantDocuments: ${error}`);
    }
}

async function insertVectorsToMilvus(data, collection, userId) {
    const exists = await client.hasCollection({ collection_name: `${collection}_${userId}` });

    if (!exists.value) {
        logger.log('Milvus', `Collection ${collection} does not exist.`);
        const created = await checkAndCreateCollection(process.env.INTELLIGENCE_COLLECTION, userId)
        if (!created) {
            logger.log('Milvus', "It's fucked.")
            return false;
        } else {
            const loadCollect = await loadCollectionIfNeeded(collection, userId);
            logger.log('Milvus', "We loaded the fucker " + loadCollect)
            logger.log('Milvus', "It's unfucked.")
        }
    } else {
        logger.log('Milvus', `Collection '${collection}_${userId}' is available.`);
    }

    try {
        const queryResponse = await client.query({
            collection_name: `${collection}_${userId}`,
            output_fields: ['count(*)']
        });
        const searchStuff = queryResponse.data[0]
        if (parseInt(searchStuff['count(*)']) > parseInt(data.length)) {
            logger.log('Milvus', `Skipping embedding process for data in collection '${collection}_${userId}'`)
            return;
        } else {
            const fieldsData = data.map((item, index) => {
                return {
                    embedding: item.embedding,
                    relation: item.relation,
                    text_content: item.content
                };
            });
            fieldsData.forEach((item, index) => {
                if (!Array.isArray(item.embedding) ||
                    item.embedding.some(num => typeof num !== 'number' || isNaN(num))) {
                    logger.log('Milvus', `Invalid embedding at index ${index}`);
                }
            });
            const existingFilenames = new Set(queryResponse.data.map(doc => doc.relation));
            const uniqueFieldsData = fieldsData.filter(item => !existingFilenames.has(item.relation));

            logger.log('Milvus', `There are ${searchStuff['count(*)']} items in collection '${collection}_${userId}'.`)
            logger.log('Milvus', `There are ${data.length} local knowledge files for ${collection}_${userId}.`)
            if (parseInt(data.length) == parseInt(searchStuff['count(*)']) && parseInt(searchStuff['count(*)']) != 0) {
                logger.log('Milvus', 'No new unique vectors to insert.');
                return;
            } else if (parseInt(data.length) >= parseInt(searchStuff['count(*)']) && parseInt(searchStuff['count(*)']) != 0) {
                const insertResponse = await client.insert({
                    collection_name: `${collection}_${userId}`,
                    fields_data: uniqueFieldsData
                });
            } else {
                logger.log('Milvus', `Inserting new data into collection ${collection}_${userId}.`)
                const insertResponse = await client.insert({
                    collection_name: `${collection}_${userId}`,
                    fields_data: uniqueFieldsData
                });
                logger.log('Milvus Std', `Inserted data.`);
            }

        }
    } catch (error) {
        logger.log('Milvus', `Error inserting vectors: ${error}`);
    }
}

async function insertAugmentVectorsToMilvus(vectors, content, relational, userId) {
    const exists = await client.hasCollection({ collection_name: `${process.env.INTELLIGENCE_COLLECTION}_${userId}` });
    const queryResponse = await client.query({
        collection_name: `${process.env.INTELLIGENCE_COLLECTION}_${userId}`,
        output_fields: ['count(*)']
    });
    logger.log('Milvus Emb', `Embedding has ${vectors.length} indexes`)
    const fieldsData = [{
        embedding: vectors,
        relation: relational,
        text_content: content
    }];

    if (!exists.value) {
        logger.log('Milvus', `Collection '${process.env.INTELLIGENCE_COLLECTION}_${userId}' does not exist.`);
        const created = await checkAndCreateCollection(process.env.INTELLIGENCE_COLLECTION, userId)
        if (!created) {
            logger.log('Milvus', "It's fucked.")
            return false;
        } else {
            const loadCollect = await loadCollectionIfNeeded(process.env.INTELLIGENCE_COLLECTION, userId);
            logger.log('Milvus', "We loaded the fucker " + loadCollect)
            logger.log('Milvus', "It's unfucked.")
        }
    } else {
        logger.log('Milvus', `Collection '${process.env.INTELLIGENCE_COLLECTION}_${userId}' is available.`);
    }
    try {
        const searchStuff = queryResponse.data[0]

        logger.log('Milvus', `There are ${searchStuff['count(*)']} items in collection.`)
        const insertResponse = await client.insert({
            collection_name: `${process.env.INTELLIGENCE_COLLECTION}_${userId}`,
            fields_data: fieldsData
        });
        if (insertResponse.status.code == 0) {
            logger.log('Augment', `Inserted retrieved data into intelligence`);
            return true
        } else {
            logger.log('Augment', `Failed to insert retrieved data into intelligence. Reason: ${insertResponse.status.reason}`);
            return false
        }
    } catch (error) {
        logger.log('Augment', `Error inserting vectors to intelligence: ${error}`);
    }
}

async function retrieveWebContext(urls, query, subject, userId) {
    logger.log('LLM', `Starting summarization based on search term: ${query}...`)
    var pageContentText = await pullFromWeb(urls)
    const instruct = await summaryPrompt(subject, pageContentText)
    logger.log('Augment', `Prompt is going to use ${promptTokenCount(instruct, process.env.SUMMARY_MODEL_TYPE)} tokens.`)
    const openai = new OpenAI({
        baseURL: process.env.SUMMARY_ENDPOINT,
        apiKey: process.env.SUMMARY_API_KEY
    })
    const completion = await openai.chat.completions.create({
        model: process.env.SUMMARY_MODEL,
        messages: [
            {
                "role": "system",
                "content": instruct
            }
        ],
        "provider": {
            "order": [
                "Fireworks",
                "Avian.io"
            ],
            "allow_fallbacks": true
        }
    })

    logger.log('LLM', `Summary response: ${JSON.stringify(completion.choices, null, "  ")}, error: ${JSON.stringify(completion.error, null, "  ")}`)
    const fullVectors = await getMessageEmbedding(query)
    const makeSummary = `### Summary of ${query}:\n${completion.choices[0].message.content}`
    const doneAug = await insertAugmentVectorsToMilvus(fullVectors, makeSummary, subject, userId)
    if (doneAug) {
        logger.log('Augment', `Stored summary string for ${subject} into vector DB.`)
        return makeSummary
    } else {
        logger.log('Augment', `Failed to store summary string for ${subject} into vector DB.`, 'err')
        return false
    }
}

async function searchBraveAPI(query, freshness) {
    const response = await axios.get(`https://api.search.brave.com/res/v1/web/search?q=${query}&goggles_id=https%3A%2F%2Fraw.githubusercontent.com%2Fbubsnik%2Fgoggles%2Fmain%2Fno-wikipedia.goggles&freshness=${freshness}&result_filter=web`, { headers: { "X-Subscription-Token": process.env.BRAVE_TOKEN, "Accept": "application/json", "Accept-Encoding": "gzip" } });
    if (response.status == 200) {
        const chosenResults = response.data.web.results.slice(0, 3)
        chosenResults.forEach(async function (item) {
            logger.log('Brave Search', `Returned the following page named: ${item.title} at ${item.url}`)
        })
        return chosenResults
    } else {
        logger.log('Brave Search', `Error when searching on Brave: ${response.data}`, 'err')
    }

}

async function inferSearchParam(query, userId) {
    var instruct = await queryPrompt(query, userId)
    const openai = new OpenAI({
        baseURL: process.env.QUERY_ENDPOINT,
        apiKey: process.env.QUERY_API_KEY
    })
    const completion = await openai.chat.completions.create({
        model: process.env.QUERY_BUILDER_MODEL,
        messages: [
            {
                "role": "system",
                "content": instruct
            },
            {
                "role": "user",
                "content": query
            }
        ]
    })
    if (!completion.choices[0].message.content.trim().includes(';') || completion.choices[0].message.content.trim().toLowerCase === "pass") {
        logger.log('LLM', `Query builder opted out of search for this query.`)
        return "pass"
    } else {
        logger.log('LLM', `Returned optimized search param: ${completion.choices[0].message.content.trim()}`)
        return completion.choices[0].message.content.trim()
    }
}

async function insertChatVectorsToMilvus(vectors, message, sumText, response, user, date, userId) {
    const exists = await client.hasCollection({ collection_name: `${process.env.CHAT_COLLECTION}_${userId}` });
    const queryResponse = await client.query({
        collection_name: `${process.env.CHAT_COLLECTION}_${userId}`,
        output_fields: ['count(*)']
    });
    logger.log('Milvus Chat', `Received chat embedding has ${vectors.length} indexes`)
    const fieldsData = [{
        embedding: vectors,
        username: user,
        text_content: sumText,
        raw_msg: message,
        ai_message: response,
        time_stamp: date
    }];

    if (!exists.value) {
        logger.log('Milvus Chat', `Collection ${process.env.CHAT_COLLECTION}_${userId} does not exist.`);
        const created = await checkAndCreateCollection(process.env.CHAT_COLLECTION, userId)
        if (!created) {
            logger.log('Milvus Chat', `Could not spawn collection '${process.env.CHAT_COLLECTION}_${userId}'`)
            return false;
        } else {
            const loadCollect = await loadCollectionIfNeeded(process.env.CHAT_COLLECTION, userId);
            logger.log('Milvus Chat', `Successfully loaded collection '${process.env.CHAT_COLLECTION}_${userId}: ${loadCollect}'`)
        }
    }
    try {
        const searchStuff = queryResponse.data[0]

        logger.log('Milvus Chat', `There are currently ${searchStuff['count(*)']} items in collection.`)
        const insertResponse = await client.insert({
            collection_name: `${process.env.CHAT_COLLECTION}_${userId}`,
            fields_data: fieldsData
        });
        if (insertResponse.status.code == 0) {
            logger.log('Milvus Chat', `Inserted chat vectors`);
            return true
        } else {
            logger.log('Milvus Chat', `Failed to insert chat vectors. Reason: ${insertResponse.status.reason}`);
            return false
        }
    } catch (error) {
        logger.log('Milvus Chat', `Error inserting chat vectors: ${error}`);
    }
}

async function insertVoiceVectorsIntoMilvus(vectors, summary, message, response, user, date, userId) {
    const exists = await client.hasCollection({ collection_name: `${process.env.VOICE_COLLECTION}_${userId}` });
    const queryResponse = await client.query({
        collection_name: `${process.env.VOICE_COLLECTION}_${userId}`,
        output_fields: ['count(*)']
    });
    logger.log('Milvus Chat', `Received chat embedding has ${vectors.length} indexes`)
    const fieldsData = [{
        embedding: vectors,
        username: user,
        user_message: message,
        ai_resp: response,
        summary: summary,
        date_time: date
    }];

    if (!exists.value) {
        logger.log('Milvus Chat', `Collection ${process.env.VOICE_COLLECTION} does not exist.`);
        const created = await checkAndCreateCollection(process.env.VOICE_COLLECTION, userId)
        if (!created) {
            logger.log('Milvus Chat', `Could not spawn collection '${process.env.VOICE_COLLECTION}_${userId}'`)
            return false;
        } else {
            const loadCollect = await loadCollectionIfNeeded(process.env.VOICE_COLLECTION, userId);
            logger.log('Milvus Chat', `Successfully loaded collection '${process.env.VOICE_COLLECTION}_${userId}'`)
        }
    }
    try {
        const searchStuff = queryResponse.data[0]

        logger.log('Milvus Chat', `There are currently ${searchStuff['count(*)']} items in collection.`)
        const insertResponse = await client.insert({
            collection_name: `${process.env.VOICE_COLLECTION}_${userId}`,
            fields_data: fieldsData
        });
        if (insertResponse.status.code == 0) {
            logger.log('Milvus Chat', `Inserted chat vectors for ${userId}`);
            return true
        } else {
            logger.log('Milvus Chat', `Failed to insert chat vectors for ${userId}. Reason: ${insertResponse.status.reason}`);
            return false
        }
    } catch (error) {
        logger.log('Milvus Chat', `Error inserting chat vectors: ${error}`);
    }
}

async function readFilesFromDirectory(directory) {
    const files = [];
    const items = await fs.promises.readdir(directory);
    for (const item of items) {
        const fullPath = path.join(directory, item);
        const stat = await fs.promises.stat(fullPath);
        if (stat.isDirectory()) {
            const subDirFiles = await readFilesFromDirectory(fullPath);
            files.push(...subDirFiles);
        } else if (path.extname(item) === '.txt') {
            files.push(fullPath);
        }
    }
    return files;
}

async function checkAndCreateCollection(collection, userId) {
    const exists = await client.hasCollection({ collection_name: `${collection}_${userId}` });

    if (!exists.value) {
        logger.log('Milvus', `Collection '${collection}' does not exist. Creating it...`);
        await createCollection(collection, userId);
        const existsAfterCreation = await client.hasCollection({ collection_name: `${collection}_${userId}` });
        if (!existsAfterCreation.value) {
            logger.log('Milvus', `Failed to create collection '${collection}' for ${userId}. Exiting.`);
            return false;
        } else {
            logger.log('Milvus', `Collection '${collection}' for ${userId} created successfully.`);
            return true;
        }
    } else {
        return true;
    }
}

async function sendFileForVectorization(fileContent) {
    const vectorInstruct = await fs.promises.readFile('./instructs/instruct_convert.txt')
    const openai = new OpenAI({
        baseURL: process.env.CONVERSION_ENDPOINT,
        apiKey: process.env.CONVERSION_API_KEY
    })

    const completion = await openai.chat.completions.create({
        model: process.env.CONVERSION_MODEL,
        messages: [
            {
                "role": "system",
                "content": vectorInstruct
            },
            {
                "role": "user",
                "content": JSON.stringify(fileContent.content)
            }
        ]
    })
    const returnArray = completion.choices[0].message.content.split(';')
    return {
        relation: returnArray[0],
        content: fileContent.content,
        filename: returnArray[1],
        position: fileContent.position
    }
}

async function processFiles(directory, userId) {
    try {
        const collectionCreated = await checkAndCreateCollection(process.env.INTELLIGENCE_COLLECTION, userId);
        if (!collectionCreated) {
            return;
        } else {
            const loadedColl = await loadCollectionIfNeeded(process.env.INTELLIGENCE_COLLECTION, userId);
            if (loadedColl) {
                const queryResponse = await client.query({
                    collection_name: `${process.env.INTELLIGENCE_COLLECTION}_${userId}`,
                    output_fields: ['count(*)']
                });
                const searchStuff = queryResponse.data[0]
                const storedRecords = searchStuff['count(*)']
                const filenames = await readFilesFromDirectory(`${directory}/${userId}`);
                const fileContents = await Promise.all(filenames.map(async filename => {
                    const content = await fs.promises.readFile(filename, 'utf8');
                    if (isValidJson(content)) {
                        return JSON.parse(content);
                    } else {
                        return content
                    }
                }));

                if (storedRecords == fileContents.length) {
                    logger.log('Milvus', `Collection '${process.env.INTELLIGENCE_COLLECTION}_${userId}' already contains all local knowledge. Proceeding.`)
                } else {
                    let relationStrings = []
                    let contentStrings = []
                    let conversionArray = []
                    let finalArray = []
                    fileContents.forEach(function (item, index) {
                        if (!isValidJson(item)) {
                            conversionArray.push({
                                content: item,
                                position: index
                            });
                        } else {
                            contentStrings.push(item.content)
                            relationStrings.push(item.relation)
                        }
                    })
                    if (conversionArray.length > 0) {
                        conversionArray.forEach(async function (item, index) {
                            const newFile = await sendFileForVectorization(item);
                            logger.log('Augment', `Processing file conversion for ${item}...`)
                            contentStrings.push(newFile.content)
                            relationStrings.push(newFile.relation)
                            await fs.unlink(`${filenames[newFile.position]}`)
                            await fs.writeFile(`./data/${userId}/${newFile.filename}`, JSON.stringify(newDict))
                        })
                    }
                    const embeddingArray = await getMessageEmbedding(relationStrings)
                    embeddingArray.forEach(async function (item, index) {
                        finalArray.push({
                            relation: relationStrings[index],
                            content: contentStrings[index],
                            embedding: item.embedding
                        })
                    })
                    await insertVectorsToMilvus(finalArray, process.env.INTELLIGENCE_COLLECTION, userId)
                }
            } else {
                logger.log('Milvus', `Collection '${process.env.INTELLIGENCE_COLLECTION}_${userId}' failed to load.`)
                throw error;
            }
        }

    } catch (error) {
        logger.log('Milvus', `Error processing files: ${error}`);
    }
}

async function respondWithContext(message, username, userID) {
    logger.log('System', `Made it to the base of it.`)
    const rawContext = await findRelevantDocuments(message, userID, 10)
    const voiceCtx = await findRelevantVoiceInMilvus(message, userID, 3)
    const chatHistory = await findRelevantChats(message, username, userID, 3)
    try {
        const contextBody = await resultsReranked(rawContext, message, userID, true);
        const relChatBody = await resultsReranked(chatHistory, message, userID);
        const relVoiceBody = await resultsReranked(voiceCtx, message, userID)
        const promptData = {
            relChats: relChatBody,
            relContext: contextBody,
            relVoice: relVoiceBody,
            user: username
        }

        const openai = new OpenAI({
            baseURL: process.env.CHAT_COMPLETION_URL,
            apiKey: process.env.CHAT_COMPLETION_KEY
        })
        const body = await contextPromptChat(promptData, message, userID)
        const response = await openai.chat.completions.create(body)
        const aiResp = response.choices[0].message.content
        return await replyStripped(aiResp, userID)
    } catch (error) {
        console.error('Error calling resultsReranked:', error);
    }
}

async function rerankString(message, userId) {
    const openai = new OpenAI({
        baseURL: process.env.RERANK_STR_ENDPOINT,
        apiKey: process.env.RERANK_STR_API_KEY
    })
    const promptRerank = await rerankPrompt(message, userId)
    const response = await openai.chat.completions.create(promptRerank)
    logger.log('LLM', `Rerank model responded: ${response.choices[0].message.content}`)
    return response.choices[0].message.content
}

async function respondWithoutContext(message) {
    const instruct = await promptWithBody(false, message, null);
    const openai = new OpenAI({
        baseURL: process.env.CHAT_COMPLETION_URL,
        apiKey: process.env.CHAT_COMPLETION_KEY
    })
    const response = await openai.chat.completions.create(instruct)
    return replyStripped(response.choices[0].message.content, userId)
}

async function respondWithVoice(message, userId) {
    const userObj = await returnAuthObject(userId)
    const voiceForm = new FormData();
    voiceForm.append('text_input', `${message}`);
    voiceForm.append('text_filtering', 'standard');
    voiceForm.append('character_voice_gen', userObj.speaker_file);
    voiceForm.append('narrator_enabled', 'false');
    voiceForm.append('text_not_inside', 'character');
    voiceForm.append('rvccharacter_voice_gen', userObj.rvc_model)
    voiceForm.append('rvccharacter_pitch', userObj.rvc_pitch)
    voiceForm.append('language', 'en');
    voiceForm.append('output_file_name', userObj.user_id);
    voiceForm.append('output_file_timestamp', 'true');
    voiceForm.append('autoplay', 'false');
    voiceForm.append('temperature', '0.63')

    const res = await axios.post(`${process.env.ALLTALK_BASE}/api/tts-generate`, voiceForm)

    if (res.status == 200) {
        if (userObj.is_local == true) {
            const audioUrl = `${process.env.ALLTALK_BASE}${res.data.output_file_url}`;
            return audioUrl
        } else {
            const audioUrl = `http://${process.env.PUBLIC_IP}:7851${res.data.output_file_url}`
            return audioUrl
        }
        logger.log('Voice', `Generation from AllTalk successful.`)
        //await audioPlayer.playAudioOnDevice(audioUrl, process.env.AUDIO_PLAYBACK_DEVICE)
    } else {
        console.error(`Request failed with: ${res.data}`)
    }
}
async function respondToDirectVoice(message, userId, withVoice = false) {
    const rawContext = await findRelevantDocuments(message)
    const voiceCtx = await findRelevantVoiceInMilvus(message)
    const userObj = await returnAuthObject(userId)
    const contextBody = await resultsReranked(rawContext, message, true);
    const voiceCtxBody = withVoice ? await voiceReranked(voiceCtx, message, false) : '- No additional voice conversations to supply.'

    const promptData = {
        relChats: '- No additional chat content.',
        relContext: contextBody,
        relVoice: voiceCtxBody,
        user: process.env.USER_NAME
    }

    const openai = new OpenAI({
        baseURL: process.env.CHAT_COMPLETION_URL,
        apiKey: process.env.CHAT_COMPLETION_KEY
    })

    const body = await contextPromptChat(promptData, message, userId)
    const response = await openai.chat.completions.create(body)
    const aiResp = response.choices[0].message.content
    const strippedResp = await replyStripped(aiResp, userId)
    const voiceForm = new FormData();
    voiceForm.append('text_input', `${strippedResp}`);
    voiceForm.append('text_filtering', 'standard');
    voiceForm.append('character_voice_gen', userObj.speaker_file);
    voiceForm.append('narrator_enabled', 'false');
    voiceForm.append('text_not_inside', 'character');
    voiceForm.append('rvccharacter_voice_gen', userObj.rvc_model)
    voiceForm.append('rvccharacter_pitch', userObj.rvc_pitch)
    voiceForm.append('language', 'en');
    voiceForm.append('output_file_name', userObj.user_id);
    voiceForm.append('output_file_timestamp', 'true');
    voiceForm.append('autoplay', 'false');
    voiceForm.append('temperature', '0.8')

    const res = await axios.post(`${process.env.ALLTALK_BASE}/api/tts-generate`, voiceForm)

    if (res.status == 200) {
        logger.log('Voice', `Direct voice response from AllTalk successful.`)
        return {
            audio_url: `${process.env.ALLTALK_BASE}${res.data.output_file_url}`,
            response: strippedResp
        }
    } else {
        console.error(`Request failed with: ${res.data}`)
    }
}

async function addChatMessageAsVector(sumText, message, username, date, response, userId) {
    const loadedColl = await loadCollectionIfNeeded(process.env.CHAT_COLLECTION, userId);
    if (loadedColl) {
        try {
            const embeddingsArray = await getMessageEmbedding(sumText);
            await insertChatVectorsToMilvus(embeddingsArray, message, sumText, response, username, date, userId);
            logger.log('Milvus', 'Chat text successfully inserted into Milvus.');
        } catch (error) {
            logger.log('Milvus', `Error processing chat text: ${error}`);
        }
    } else {
        logger.log('Milvus', `Can't load collection for chat.`)
    }
}

async function addVoiceMessageAsVector(sumString, message, username, date, response, userId) {
    const loadedColl = await loadCollectionIfNeeded(process.env.CHAT_COLLECTION, userId);
    if (loadedColl) {
        try {
            const embeddingsArray = await getMessageEmbedding(message);
            await insertVoiceVectorsIntoMilvus(embeddingsArray, sumString, message, response, username, date, userId);
            logger.log('Milvus', 'Chat text successfully inserted into Milvus.');
        } catch (error) {
            logger.log('Milvus', `Error processing chat text: ${error}`);
        }
    } else {
        logger.log('Milvus', `Can't load collection for chat.`)
    }
}

async function respondToEvent(event, userId) {
    const eventMessage = await returnTwitchEvent(event, userId)
    logger.log('System', `Got done eventing: ${eventMessage}`)
    const instructPrompt = await eventPromptChat(eventMessage, userId)

    const openai = new OpenAI({
        baseURL: process.env.CHAT_COMPLETION_URL,
        apiKey: process.env.CHAT_COMPLETION_KEY
    })

    const response = await openai.chat.completions.create(instructPrompt)
    const strippedResponse = await replyStripped(response.choices[0].message.content, userId)
    return strippedResponse
}

async function startIndexingVectors(userId) {
    const authObjects = await returnAuthObject(userId)
    logger.log('Milvus', `Beginning indexing for ${authObjects.user_id}`)
    await processFiles(`${process.env.TEXT_DIRECTORY}`, authObjects.user_id);
}

async function checkMilvusHealth() {
    const isUp = await client.checkHealth()
    return isUp.isHealthy
}

async function weGottaGoBald(collection, userId) {
    try {
        const exists = await client.hasCollection({ collection_name: `${collection}_${userId}` });

        if (!exists.value) {
            logger.log('Milvus', `Collection '${collection}' for ${userId} does not exist. Creating...`);
            await createCollection(collection, userId)
            return;
        }

        const status = await client.dropCollection({ collection_name: `${collection}_${userId}` });
        if (status.code != 0) {
            logger.log('Milvus', `Collection '${collection}' for ${userId} failed to drop. Reason: ${status.reason}`);
            return false;
        } else {
            await createCollection(collection, userId)
            return true;
        }
    } catch (error) {
        logger.log('Milvus', `Error dropping collection: ${error}`);
    }
}

const isValidJson = (input) => {
    if (typeof input === 'string') {
        try {
            JSON.parse(input);
            return true;
        } catch {
            return false;
        }
    } else if (typeof input === 'object' && input !== null) {
        return true;
    }
    return false;
};

async function checkEndpoint(endpoint, key, modelName) {
    const openai = new OpenAI({
        baseURL: endpoint,
        apiKey: key
    })
    if (endpoint === process.env.EMBEDDING_ENDPOINT) {
        if (process.env.EMBEDDING_API_KEY_TYPE === "infinity") {
            const response = await axios.get('http://172.20.20.5:7997/models')
            if (response.data.data.id === modelName) {
                return true;
            } else {
                return false;
            }
        } else {
            const response = await openai.models.embedding.list()
            if (response.data.id) {
                return true;
            } else {
                return false;
            }
        }
    } else {
        const response = await openai.models.list()
        if (response.data.id) {
            return true;
        } else {
            return false;
        }

    }
}

export { checkEndpoint, respondWithContext, checkMilvusHealth, inferSearchParam, retrieveWebContext, rerankString, searchBraveAPI, respondToDirectVoice, addVoiceMessageAsVector, loadCollectionIfNeeded, addChatMessageAsVector, insertAugmentVectorsToMilvus, respondWithoutContext, getMessageEmbedding, respondWithVoice, respondToEvent, processFiles, startIndexingVectors, findRelevantVoiceInMilvus, findRelevantDocuments, weGottaGoBald };