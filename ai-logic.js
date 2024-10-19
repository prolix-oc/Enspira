import axios, { isCancel, AxiosError } from 'axios';
import fs from "fs-extra"
import path from 'path';
import moment from 'moment';
import ansi from './node_modules/ansi-colors-es6/index.js';
import { MilvusClient, DataType, MetricType, IndexType, ConsistencyLevelEnum, LoadState, buildSearchParams } from '@zilliz/milvus2-sdk-node';
import { error } from 'console';

const client = new MilvusClient({ address: '172.20.20.132:19530' });
const EMBEDDING_MODEL_URL = 'http://172.20.10.211:5000/v1/embeddings';
const COLLECTION_NAME = 'layla_intelligence';
const API_KEY = '';
const TEXT_DIRECTORY = './data';

function normalizeVector(vector) {
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    return vector.map(val => val / magnitude);
}

async function createCollection() {
    const collectionSchema = {
        collection_name: COLLECTION_NAME,
        consistency_level: ConsistencyLevelEnum.Strong,
        schema: [
            {
                name: 'embedding',
                data_type: DataType.FloatVector,
                type_params: {
                    dim: 768
                }, 
                is_primary_key: false,
                auto_id: false,                
            },
            {
                name: 'filename',
                data_type: DataType.VarChar,
                max_length: 255,
                is_primary_key: true,
                auto_id: false
            },
            {
                name: 'filepath',
                data_type: DataType.VarChar,
                max_length: 255,
                is_primary_key: false,
                auto_id: false
            },
            {
                name: 'text_content',
                data_type: DataType.VarChar,
                max_length: 4096,
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
              params: { M: 48 , efConstruction: 200 }
            }
        ]
    };

    try {
        const response = await client.createCollection(collectionSchema);
        console.log('Collection and index created successfully:', response);
        
    } catch (error) {
        console.error('Error creating collection or index:', error);
    }
}

async function getCollectionSchema() {

    try {
        const schemaResponse = await client.describeCollection({ collection_name: COLLECTION_NAME });
        console.log('DIM results: ', schemaResponse.schema.fields[0].type_params)
        return schemaResponse.schema;
    } catch (error) {
        console.error('Error fetching collection schema:', error);
        throw error;
    }
}

async function loadCollectionIfNeeded(collectionName) {
    try {
        const collectionStatus = await client.getLoadState({ collection_name: collectionName });
        if (collectionStatus.state === LoadState.LoadStateNotExist) {
            console.log(`Collection ${collectionName} does not exist`);
            return false;
        } else if (collectionStatus.state === LoadState.LoadStateNotLoad) {
            const loadParams = {
                collection_name: collectionName
            };
    
            await client.loadCollection(loadParams);
            console.log(`Collection ${collectionName} loaded successfully.`);
            return true;
        } else {
            console.log(`Collection '${COLLECTION_NAME}' already loaded.`)
            return true;
        }
        
    } catch (error) {
        console.error('Error loading collection:', error);
        throw error;
    }
}

async function getQueryEmbedding(query) {
    try {
        const response = await axios.post(EMBEDDING_MODEL_URL, {
            text: [query]
        },  { headers: { "x-api-key": "cbbc516ea61851cd255d4dbb3f66e724" }});

        const embedding = response.data.data[0].embedding;

        return embedding;
    } catch (error) {
        console.error('Error getting query embedding:', error);
        throw error;
    }
}

async function getMessageEmbedding(message) {
    try {
        const response = await axios.post(EMBEDDING_MODEL_URL, {
            input: [message] 
        }, { headers: { "x-api-key": API_KEY }});

        const embeddings = response.data.data[0].embedding;
        return embeddings;
    } catch (error) {
        console.error('Error getting message embedding:', error);
        throw error;
    }
}

async function searchDocumentsInMilvus(queryEmbedding) {
    try {
        
        const searchParams = {
            collection_name: COLLECTION_NAME,
            vector: [normalizeVector(queryEmbedding)],
            topk: 4,
            metric_type: MetricType.COSINE,
            output_fields: ['text_content'],
            vector_type: DataType.FloatVector,
            search_params: buildSearchParams({ef: 100}),
            consistency_level: ConsistencyLevelEnum.Strong 
        };

        const searchResponse = await client.search(searchParams);
        return searchResponse;
    } catch (error) {
        console.error('Error searching in Milvus:', error);
        throw error;
    }
}

async function findRelevantDocuments(message) {
    try {
        const isLoaded = await loadCollectionIfNeeded(COLLECTION_NAME);
        if (!isLoaded) {
            console.error(`Failed to load collection: ${COLLECTION_NAME}. Exiting search.`);
            return;
        }

        const messageEmbedding = await getMessageEmbedding(message);
        console.log('Message embedding dimension:', messageEmbedding.length);

        const collectionSchema = await getCollectionSchema();
        
        console.log('Schema:', collectionSchema);

        const embeddingField = collectionSchema.fields.find(field => field.name === 'embedding');
        console.log(`Got embedding: ${JSON.stringify(embeddingField)}`)
        const expectedDim = embeddingField && embeddingField.type_params[0]? parseInt(embeddingField.type_params[0].value) : undefined;

        if (expectedDim === undefined) {
            console.error('Could not retrieve the expected dimension for the embedding field.');
            return;
        }

        console.log(`Expected Dimension: ${expectedDim}`);
        
        if (messageEmbedding.length !== expectedDim) {
            console.error(`Dimension mismatch: expected ${expectedDim}, got ${messageEmbedding.length}.`);
            return;
        }

        const searchResponse = await searchDocumentsInMilvus(messageEmbedding);
        console.log(searchResponse)
        const results = searchResponse.results; 

        if (!Array.isArray(results[0].embedding)) {
            console.error('Expected results to be an array but got:', results[0].embedding);
            return;
        }

        console.log('Search results:');
        results.forEach((id, index) => {
            console.log(`Document ID: ${results[index].id}, Distance: ${results[index].score}`);
        });
    } catch (error) {
        console.error('Error in findRelevantDocuments:', error);
    }
}

async function searchInMilvus(queryEmbedding) {
    try {
        const searchParams = {
            collection_name: COLLECTION_NAME,
            query_records: [normalizeVector(queryEmbedding)],
            top_k: 4,
            params: { nprobe: 10 },
            limit: 4
        };

        const searchResponse = await client.search(searchParams);

        console.log('Search results:', searchResponse);
        return searchResponse;
    } catch (error) {
        console.error('Error searching in Milvus:', error);
    }
}

async function searchForWord(word) {
    try {
        const queryEmbedding = await getQueryEmbedding(word);
        const results = await searchInMilvus(queryEmbedding);

        results.forEach(result => {
            console.log(`Found similar item: ${result.id}, Distance: ${result.distance}`);
        });
    } catch (error) {
        console.error('Error in search flow:', error);
    }
}

async function getEmbeddings(text) {
    try {
        const queryResponse = await client.query({
            collection_name: COLLECTION_NAME,
            output_fields: ['count(*)']
        });
        const searchStuff = queryResponse.data[0]
        if (parseInt(searchStuff['count(*)']) > 0) {
            return;
        } else {
            const response = await axios.post(EMBEDDING_MODEL_URL, {
                input: Array.isArray(text) ? text : [text]
            }, { headers: { "x-api-key": "cbbc516ea61851cd255d4dbb3f66e724" }});
            
            const embeddings = response.data.data.map(item => item.embedding);
    
            if (!Array.isArray(embeddings) || embeddings.some(v => !Array.isArray(v) || v.some(num => isNaN(num)))) {
                throw new Error('Invalid embedding vector generated');
            }
    
            return embeddings;
        }
    } catch (error) {
        console.error('Error getting embeddings:', error);
        throw error;
    }
}

async function insertVectorsToMilvus(vectors, filenames, text) {

    const exists = await client.hasCollection({ collection_name: COLLECTION_NAME });
    console.log(`Checking existence of collection '${COLLECTION_NAME}':`, exists);

    if (!exists.value) {
        console.log(`Collection ${COLLECTION_NAME} does not exist.`);
        const created = await checkAndCreateCollection(COLLECTION_NAME)
        if (!created) {
            console.error("It's fucked.")
            return false;
        } else {
            const loadCollect = await loadCollectionIfNeeded(COLLECTION_NAME);
            console.log("We loaded the fucker " + loadCollect)
            console.log("It's unfucked.")
        }
    }

    try {
        const queryResponse = await client.query({
            collection_name: COLLECTION_NAME,
            output_fields: ['count(*)']
        });
        const searchStuff = queryResponse.data[0]
        if (parseInt(searchStuff['count(*)']) > 0) {
            console.log(`Skipping embedding process for text in collection '${COLLECTION_NAME}'`)
            return;
        } else {
            const fieldsData = vectors.map((embeddings, index) => {
                const filenameWithoutExt = path.basename(filenames[index], path.extname(filenames[index]));
                return {
                    embedding: normalizeVector(embeddings),
                    filename: filenameWithoutExt,
                    filepath: filenames[index],
                    text_content: text[index] 
                };
            });
    
    
            fieldsData.forEach((item, index) => {
                if (!Array.isArray(item.embedding) || 
                    item.embedding.some(num => typeof num !== 'number' || isNaN(num))) {
                    console.error(`Invalid embedding at index ${index}:`, item.embedding);
                }
            });
            console.log(`Returned the following entries: ${JSON.stringify(queryResponse)}`)
            const existingFilenames = new Set(queryResponse.data.map(doc => doc.filename));
            const uniqueFieldsData = fieldsData.filter(item => !existingFilenames.has(item.filename));
    
            console.log(`There are ${searchStuff['count(*)']} items in collection.`)
            if (parseInt(filenames.length) == parseInt(searchStuff['count(*)']) && parseInt(searchStuff['count(*)']) != 0 ) {
                console.log('No new unique vectors to insert.');
                return;
            } else if (parseInt(filenames.length) >= parseInt(searchStuff['count(*)']) && parseInt(searchStuff['count(*)']) != 0) {
                const clearedForReset = await weGottaGoBald();
                if (clearedForReset) {
                    const insertResponse = await client.insert({
                        collection_name: COLLECTION_NAME,
                        fields_data: uniqueFieldsData
                    });
                    console.log('Inserted vectors:', insertResponse);
                } else {
                    console.error('Failed to insert new vectors.');
                }
            } else {
                console.log(`Inserting new vectors for collection ${COLLECTION_NAME}`)
                const insertResponse = await client.insert({
                    collection_name: COLLECTION_NAME,
                    fields_data: uniqueFieldsData
                });
            }
    
        }        
    } catch (error) {
        console.error('Error inserting vectors:', error);
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

async function checkAndCreateCollection(client) {
    const exists = await client.hasCollection({ collection_name: COLLECTION_NAME });
    
    if (!exists.value) {
        console.log(`Collection '${COLLECTION_NAME}' does not exist. Creating it...`);
        await createCollection();
        const existsAfterCreation = await client.hasCollection({ collection_name: COLLECTION_NAME });
        if (!existsAfterCreation.value) {
            console.error(`Failed to create collection '${COLLECTION_NAME}'. Exiting.`);
            return false;
        } else {
            console.log(`Collection '${COLLECTION_NAME}' created successfully.`);
            return true;
        }
    } else {
        console.log(`Collection '${COLLECTION_NAME}' seems to exist, somehow.`)
        return true;
    }
}

async function processFiles(directory) {
    try {
        const collectionCreated = await checkAndCreateCollection(client);
        
        if (!collectionCreated) {
            return;
        } else {
            const loadedColl = await loadCollectionIfNeeded(COLLECTION_NAME);
            if (loadedColl) {
            } else {
                console.error(`Collection '${COLLECTION_NAME}' failed to load.`)
                throw error;
            }
        }
        const filenames = await readFilesFromDirectory(directory);
        const fileContents = await Promise.all(filenames.map(async filename => {
            const content = await fs.promises.readFile(filename, 'utf8');
            return content;
        }));

        const embeddingsArray = await Promise.all(fileContents.map(content => getEmbeddings(content)));
        const embeddings = embeddingsArray.flat();
        const textArray = await Promise.all(fileContents.map(async text_content => {
            return text_content; 
        }));
        textArray.flat();

        insertVectorsToMilvus(embeddings, filenames, textArray)
    } catch (error) {
        console.error('Error processing files:', error);
    }
}

function genParameters(llmModel, llmPrompt, llmMaxTok, llmMinP, llmRepPen, llmTemp, llmBanned) {
    var chatCompleteBody = {
        model: llmModel,
        prompt: llmPrompt,
        max_tokens: llmMaxTok,
        stream: false,
        min_p: llmMinP,
        repetition_penalty: llmRepPen,
        temperature: llmTemp,
        banned_strings: llmBanned
    }
    return chatCompleteBody;
}

function processInstructionAndContext(message, username) {
    const instructTemplate = fs.readFileSync("instruct.txt", "utf-8");
    const contextFile = fs.readFileSync("context.txt", "utf-8");
    const fullString = `${instructTemplate}\n\nHere are the interactions you've had previously:\n\n${contextFile}\n\nYour role play starts now. Respond to the following message from ${username} in character: ${message}`
    return fullString;
}

async function genTextComplete(message, username, bans) {

    const instructAndContext = processInstructionAndContext(message, username);
    const chatBody = genParameters("KoboldAI_LLaMA2-13B-Psyfighter2", instructAndContext, 250, 0.05, 1.05, 1.1, "")
    axios.post('http://172.20.10.211:5000/v1/completions', chatBody, { headers: { "x-api-key": "cbbc516ea61851cd255d4dbb3f66e724" }})
    .then(function (response) {
        console.log(response.data.choices);
        return response.data.choices[0].text;
    })
    .catch(function (error) {
        console.log(error);
        return "null"
    });
}

async function startIndexingVectors() {
    await processFiles(TEXT_DIRECTORY);
}

async function weGottaGoBald(){
    try {
        const exists = await client.hasCollection({ collection_name: COLLECTION_NAME });
        
        if (!exists.value) {
            console.log(`Collection '${COLLECTION_NAME}' does not exist.`);
            return;
        }

        await client.dropCollection({ collection_name: COLLECTION_NAME });
        console.log(`Collection '${COLLECTION_NAME}' dropped successfully.`);
        return true;
    } catch (error) {
        console.error('Error dropping collection:', error);
    }
}    
export { genTextComplete, processInstructionAndContext, genParameters, processFiles, startIndexingVectors, findRelevantDocuments, searchForWord, weGottaGoBald };