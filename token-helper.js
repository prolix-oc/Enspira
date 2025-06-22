import fs from "fs";
import path from "path";
import { Tokenizer } from "tokenizers";
import axios, { AxiosHeaders } from "axios";
import { retrieveConfigValue } from "./config-helper.js";

const tokenizerJsons = {};
const tokenizerInstances = {}; // Cache for Tokenizer instances

export const preloadAllTokenizers = () => {
  const resourcesPath = "./resources";
  const modelDirectories = fs
    .readdirSync(resourcesPath)
    .filter((file) =>
      fs.statSync(path.join(resourcesPath, file)).isDirectory(),
    );
  for (const modelDir of modelDirectories) {
    const tokenizerFilePath = path.join(resourcesPath, modelDir, "tokenizer.json");
    if (fs.existsSync(tokenizerFilePath)) {
      try {
        const tokenizerContent = fs.readFileSync(tokenizerFilePath, "utf-8");
        tokenizerJsons[modelDir] = tokenizerContent;
      } catch (error) {
        logger.log("Tokenizer", `Failed to load tokenizer for model ${modelDir}: ${error.message}`, "err");
      }
    } else {
      logger.log("Tokenizer", `Tokenizer file not found for model: ${modelDir}`, "err");
    }
  }
  logger.log("Tokenizer", `Loaded tokenizers: ${Object.keys(tokenizerJsons).join(", ")}`);
};

export const getTokenizerInstance = async (model) => {
  if (tokenizerInstances[model]) {
    return tokenizerInstances[model];
  }
  const tokenizerJson = tokenizerJsons[model];
  if (!tokenizerJson) {
    logger.log("Tokenizer", `Tokenizer JSON not found for model: ${model}`, "err");
    return null;
  }
  try {
    const instance = await Tokenizer.fromString(tokenizerJson);
    tokenizerInstances[model] = instance;
    return instance;
  } catch (error) {
    logger.log("Tokenizer", `Error creating tokenizer for model ${model}: ${error.message}`, "err");
    return null;
  }
};


export const getTokenizerJson = async (model) => tokenizerJsons[model];

export const getPromptCount = async (
  systemPrompt,
  userPrompt,
  modelType,
  contextPrompt = "",
) => {
  const tokenizerJson = await getTokenizerJson(modelType);
  if (!tokenizerJson) {
    logger.log(
      "Tokenizer",
      `Tokenizer not found for model type: ${modelType}`,
      "err",
    );
  }
  try {
    const tokenizer = await Tokenizer.fromString(tokenizerJson);

    const systemEncoded = await tokenizer.encode(JSON.stringify(systemPrompt));
    const userEncoded = await tokenizer.encode(JSON.stringify(userPrompt));
    const contextEncoded = contextPrompt
      ? await tokenizer.encode(JSON.stringify(contextPrompt))
      : { getLength: () => 0 };
    const tokenCount =
      systemEncoded.getLength() +
      userEncoded.getLength() +
      contextEncoded.getLength();
    return tokenCount;
  } catch (error) {
    logger.log(
      "error",
      `Error during tokenization for model ${modelType}: ${error.message}`,
    );
  }
};

export const getPromptTokens = async (
  requestBody,
  modelType
) => {
  const tokenizerJson = await getTokenizerJson(modelType);
  if (!tokenizerJson) {
    logger.log(
      "Tokenizer",
      `Tokenizer not found for model type: ${modelType}`,
      "err",
    );
  }
  try {
    const tokenizer = await Tokenizer.fromString(tokenizerJson);

    let totalTokens = 0
    for await (const message of requestBody.messages) {
      const messageContent = await tokenizer.encode(message.content)
      totalTokens += messageContent.getLength()
    }
    return totalTokens;
  } catch (error) {
    logger.log(
      "error",
      `Error during tokenization for model ${modelType}: ${error.message}`,
    );
  }
};

export const getOutputTokens = async (
  message,
  modelType
) => {
  const tokenizerJson = await getTokenizerJson(modelType);
  if (!tokenizerJson) {
    logger.log(
      "Tokenizer",
      `Tokenizer not found for model type: ${modelType}`,
      "err",
    );
  }
  try {
    const tokenizer = await Tokenizer.fromString(tokenizerJson);
    let totalTokens = 0
    const messageContent = await tokenizer.encode(message)
    totalTokens += messageContent.getLength()
    return totalTokens;
  } catch (error) {
    logger.log(
      "error",
      `Error during tokenization for model ${modelType}: ${error.message}`,
    );
  }
};

export const promptTokenizedFromRemote = async (message) => {
  const baseURL = await retrieveConfigValue("models.chat.endpoint")
  const isVllm = await retrieveConfigValue("models.chat.isVllm")
  const modelName = await retrieveConfigValue("models.chat.model")
  let fullUrl = ""
  let reqBody = {}
  if (isVllm) {
    fullUrl = baseURL + "/tokenize"
    fullUrl = fullUrl.replace("/v1", "")
    reqBody = {
      messages: message,
      model: modelName
    }
  } else {
    fullUrl = baseURL + "/tokenize"
    reqBody = {
      messages: message,
      model: modelName
    }  
  }

  try {
    const response = await axios.post(fullUrl,
      reqBody,
      { 
        headers: {
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip, deflate, br'
        },
      }
    )
    return response.data.count;
  } catch (error) {
    logger.log(
      "error",
      `Error during tokenization for model ${await retrieveConfigValue("models.chat.model")}: ${error.message}`,
    );
  }
}

