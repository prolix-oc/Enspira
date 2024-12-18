import fs from "fs";
import path from "path";
import { Tokenizer } from "tokenizers";

const tokenizerJsons = {};

export const preloadAllTokenizers = () => {
  const resourcesPath = "./resources";

  const modelDirectories = fs
    .readdirSync(resourcesPath)
    .filter((file) =>
      fs.statSync(path.join(resourcesPath, file)).isDirectory(),
    );

  for (const modelDir of modelDirectories) {
    const tokenizerFilePath = path.join(
      resourcesPath,
      modelDir,
      "tokenizer.json",
    );

    if (fs.existsSync(tokenizerFilePath)) {
      try {
        const tokenizerContent = fs.readFileSync(tokenizerFilePath, "utf-8"); // Read the file content
        tokenizerJsons[modelDir] = tokenizerContent; // Store the JSON string
      } catch (error) {
        logger.log(
          "Tokenizer",
          `Failed to load tokenizer for model ${modelDir}: ${error.message}`,
          "err",
        );
      }
    } else {
      logger.log(
        "Tokenizer",
        `Tokenizer file not found for model: ${modelDir}`,
        'err'
      );
    }
  }
  logger.log("Tokenizer", `Loaded tokenizers: ${Object.keys(tokenizerJsons).join(", ")}`);

};

export const getTokenizerJson = (model) => tokenizerJsons[model];

export const getPromptCount = async (
  systemPrompt,
  userPrompt,
  modelType,
  contextPrompt = "",
) => {
  const tokenizerJson = getTokenizerJson(modelType);
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
