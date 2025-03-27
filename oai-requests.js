import { retrieveConfigValue } from "./config-helper.js";

export class ChatRequestBody {
  constructor(promptData) {
    this.messages = [
      // System message with core instructions
      {
        role: "system",
        content: promptData.systemPrompt
      }
    ];

    // Add each context component as a separate user message
    if (promptData.characterDescription) {
      this.messages.push({
        role: "user",
        content: promptData.characterDescription
      });
    }

    if (promptData.characterPersonality) {
      this.messages.push({
        role: "user",
        content: promptData.characterPersonality
      });
    }

    if (promptData.worldInfo) {
      this.messages.push({
        role: "user",
        content: promptData.worldInfo
      });
    }

    if (promptData.scenario) {
      this.messages.push({
        role: "user",
        content: promptData.scenario
      });
    }

    if (promptData.playerInfo) {
      this.messages.push({
        role: "user",
        content: promptData.playerInfo
      });
    }

    if (promptData.recentChat) {
      this.messages.push({
        role: "user",
        content: promptData.recentChat
      });
    }

    if (promptData.weatherInfo) {
      this.messages.push({
        role: "user",
        content: promptData.weatherInfo
      });
    }

    // Add additional context elements if they exist
    if (promptData.additionalContext) {
      Object.entries(promptData.additionalContext).forEach(([key, value]) => {
        if (value && value.trim()) {
          this.messages.push({
            role: "user",
            content: value
          });
        }
      });
    }

    // Add assistant acknowledgment
    this.messages.push({
      role: "assistant",
      content: "I understand. I'll keep the provided rules, character information, and provided context in mind when responding to the next user message."
    });

    // Add the actual user query
    this.messages.push({
      role: "user",
      content: promptData.userMessage
    });

    // Set streaming to true by default
    this.stream = true;
  }

  // Static factory method for async initialization
  static async create(promptData) {
    const instance = new ChatRequestBody(promptData);
    await instance.initialize();
    return instance;
  }

  // Handle async initialization
  async initialize() {
    // Load all configuration values in parallel for better performance
    const [
      model,
      topK,
      minP,
      xtcThreshold,
      xtcProbability,
      topP,
      typicalP,
      minTokens,
      repetitionPenalty,
      presencePenalty,
      repetitionRange,
      presenceRange,
      temperature,
      dynTempMax,
      dynTempMin,
      dynTemp,
      maxTokens,
      generateWindow
    ] = await Promise.all([
      retrieveConfigValue("models.chat.model"),
      retrieveConfigValue("samplers.chat.topK"),
      retrieveConfigValue("samplers.chat.minP"),
      retrieveConfigValue("samplers.chat.xtcThreshold"),
      retrieveConfigValue("samplers.chat.xtcProbability"),
      retrieveConfigValue("samplers.chat.topP"),
      retrieveConfigValue("samplers.chat.typicalP"),
      retrieveConfigValue("samplers.chat.minTokens"),
      retrieveConfigValue("samplers.chat.repetitionPenalty"),
      retrieveConfigValue("samplers.chat.presencePenalty"),
      retrieveConfigValue("samplers.chat.repetitionRange"),
      retrieveConfigValue("samplers.chat.presenceRange"),
      retrieveConfigValue("samplers.chat.temperature"),
      retrieveConfigValue("samplers.chat.dynTempMin"),
      retrieveConfigValue("samplers.chat.dynTempMax"),
      retrieveConfigValue("samplers.chat.dynTemp"),
      retrieveConfigValue('samplers.chat.maxTokens'),
      retrieveConfigValue('samplers.chat.generateWindow')
    ]);

    // Assign values to this instance
    this.model = model;
    this.top_k = parseInt(topK);
    this.min_p = parseFloat(minP);
    this.xtc_threshold = parseFloat(xtcThreshold);
    this.xtc_probability = parseFloat(xtcProbability);
    this.top_p = parseFloat(topP);
    this.typical_p = parseFloat(typicalP);
    this.min_tokens = parseInt(minTokens);
    this.repetition_penalty = parseFloat(repetitionPenalty);
    this.presence_penalty = parseFloat(presencePenalty);
    this.repetition_range = parseInt(repetitionRange);
    this.presence_range = parseInt(presenceRange);
    this.temperature = parseFloat(temperature);
    this.max_tokens = parseInt(maxTokens);
    this.generate_window = parseInt(generateWindow);
    
    // Add dynamic temperature settings if enabled
    if (dynTemp) {
      this.dynatemp = dynTemp;
      this.dynatemp_min = parseFloat(dynTempMin);
      this.dynatemp_max = parseFloat(dynTempMax);
    }
  }
}

export class ChatRequestBodyCoT {
  constructor(promptData) {
    // Initialize with the system prompt
    this.messages = [
      {
        role: "system",
        content: promptData.systemPrompt
      }
    ];

    // Add each context component as a separate user message
    if (promptData.characterDescription) {
      this.messages.push({
        role: "user",
        content: promptData.characterDescription
      });
    }

    if (promptData.characterPersonality) {
      this.messages.push({
        role: "user",
        content: promptData.characterPersonality
      });
    }

    if (promptData.worldInfo) {
      this.messages.push({
        role: "user",
        content: promptData.worldInfo
      });
    }

    if (promptData.scenario) {
      this.messages.push({
        role: "user",
        content: promptData.scenario
      });
    }

    if (promptData.playerInfo) {
      this.messages.push({
        role: "user",
        content: promptData.playerInfo
      });
    }

    if (promptData.recentChat) {
      this.messages.push({
        role: "user",
        content: promptData.recentChat
      });
    }

    if (promptData.weatherInfo) {
      this.messages.push({
        role: "user",
        content: promptData.weatherInfo
      });
    }

    // Add additional context elements if they exist
    if (promptData.additionalContext) {
      Object.entries(promptData.additionalContext).forEach(([key, value]) => {
        if (value && value.trim()) {
          this.messages.push({
            role: "user",
            content: value
          });
        }
      });
    }

    // Add assistant acknowledgment
    this.messages.push({
      role: "assistant",
      content: "I understand all given instructions and who I am now. I'll ensure I think deeply but concisely about the message and respond according to my thoughts."
    });

    // Add the actual user query
    this.messages.push({
      role: "user",
      content: promptData.userMessage
    });

    // Set streaming to true by default
    this.stream = true;

    // Define the JSON response format for chain-of-thought
    this.response_format = {
      type: "json_schema",
      json_schema: {
        name: "thoughtful_response",
        schema: {
          type: "object",
          properties: {
            thoughts: {
              type: "array",
              items: {
                type: "string",
                description: "One brief thought about the user's message. Keep each thought under 250 words maximum."
              },
              maxItems: 6,
              description: "A short list of key thoughts that capture your reasoning process."
            },
            final_response: {
              type: "string",
              description: "Your final response to the user, optimized for Twitch chat. Keep it under 500 characters when possible."
            }
          },
          required: ["thoughts", "final_response"],
          additionalProperties: false
        },
        strict: true
      }
    };
  }

  // Static factory method for async initialization
  static async create(promptData) {
    const instance = new ChatRequestBodyCoT(promptData);
    await instance.initialize();
    return instance;
  }

  // Handle async initialization
  async initialize() {
    // Load all configuration values in parallel for better performance
    const [
      model,
      maxTokens,
      generateWindow,
      topK,
      minP,
      xtcThreshold,
      xtcProbability,
      topP,
      typicalP,
      minTokens,
      repetitionPenalty,
      presencePenalty,
      repetitionRange,
      presenceRange,
      temperature,
      dynTemp,
      dynTempMin,
      dynTempMax
    ] = await Promise.all([
      retrieveConfigValue("models.chat.model"),
      retrieveConfigValue("samplers.chat.maxTokens"),
      retrieveConfigValue("samplers.chat.generateWindow"),
      retrieveConfigValue("samplers.chat.topK"),
      retrieveConfigValue("samplers.chat.minP"),
      retrieveConfigValue("samplers.chat.xtcThreshold"),
      retrieveConfigValue("samplers.chat.xtcProbability"),
      retrieveConfigValue("samplers.chat.topP"),
      retrieveConfigValue("samplers.chat.typicalP"),
      retrieveConfigValue("samplers.chat.minTokens"),
      retrieveConfigValue("samplers.chat.repetitionPenalty"),
      retrieveConfigValue("samplers.chat.presencePenalty"),
      retrieveConfigValue("samplers.chat.repetitionRange"),
      retrieveConfigValue("samplers.chat.presenceRange"),
      retrieveConfigValue("samplers.chat.temperature"),
      retrieveConfigValue("samplers.chat.dynTemp"),
      retrieveConfigValue("samplers.chat.dynTempMin"),
      retrieveConfigValue("samplers.chat.dynTempMax")
    ]);

    // Assign and parse all configuration values
    this.model = model;
    this.max_tokens = parseInt(maxTokens);
    this.generate_window = parseInt(generateWindow);
    this.top_k = parseInt(topK);
    this.min_p = parseFloat(minP);
    this.xtc_threshold = parseFloat(xtcThreshold);
    this.xtc_probability = parseFloat(xtcProbability);
    this.top_p = parseFloat(topP);
    this.typical_p = parseFloat(typicalP);
    this.min_tokens = parseInt(minTokens);
    this.repetition_penalty = parseFloat(repetitionPenalty);
    this.presence_penalty = parseFloat(presencePenalty);
    this.repetition_range = parseInt(repetitionRange);
    this.presence_range = parseInt(presenceRange);
    this.temperature = parseFloat(temperature);
    
    // Add dynamic temperature settings if enabled
    if (dynTemp) {
      this.dynatemp = dynTemp;
      this.dynatemp_min = parseFloat(dynTempMin);
      this.dynatemp_max = parseFloat(dynTempMax);
    }
  }
}

export class ToolRequestBody {
  // Constructor handles synchronous initialization
  constructor(prompt, model, message) {
    // Initialize the basic message structure
    this.model = model;
    this.messages = [
      {
        role: "system",
        content: prompt,
      },
      {
        role: "user",
        content: message,
      },
    ];
  }

  // Static factory method provides a clean async interface
  static async create(prompt, model, message) {
    const instance = new ToolRequestBody(prompt, model, message);
    await instance.initialize();
    return instance;
  }

  // Private method handles all async initialization
  async initialize() {
    // Load all configuration values in parallel for better performance
    const [temperature, topP, topK, minP] = await Promise.all([
      retrieveConfigValue("samplers.tool.temperature"),
      retrieveConfigValue("samplers.tool.topP"),
      retrieveConfigValue("samplers.tool.topK"),
      retrieveConfigValue("samplers.tool.minP")
    ]);

    // Assign the parsed values to the instance
    this.temperature = parseFloat(temperature);
    this.top_p = parseFloat(topP);
    this.top_k = parseInt(topK);
    this.min_p = parseFloat(minP);
    this.stream = true;
  }
}

export class QueryRequestBody {
  // Constructor handles all synchronous initialization
  constructor(prompt, model, message) {
    // Set up the basic message structure
    this.model = model;
    this.messages = [
      {
        role: "system",
        content: prompt,
      },
      {
        role: "user",
        content: message,
      },
    ];

    // Initialize the JSON schema response format
    this.response_format = {
      type: "json_schema",
      json_schema: {
        name: "query_response",
        schema: {
          type: "object",
          properties: {
            valid: {
              type: "boolean",
              description: "Whether or not this is a Valid Inquiry for performing searches on. True for valid, False for invalid."
            },
            searchTerm: {
              type: "string",
              description: "The SEO-optimized search term related to the inquiry."
            },
            subject: {
              type: "string",
              description: "The inferred subject of the inquiry."
            },
            vectorString: {
              type: "string",
              description: "The vector similiarity search optimized string you have created."
            },
            freshness: {
              type: "string",
              description: "The freshness rating that applies to this search."
            },
            reason: {
              type: "string",
              description: "If query was deemed to be not valid, briefly and concisely explain why you determined the query was invalid. For valid queries, leave this empty."
            }
          },
          required: ["valid", "searchTerm", "subject", "vectorString", "freshness", "reason"],
          additionalProperties: false
        },
        strict: true
      }
    };
  }

  // Static factory method provides the async creation interface
  static async create(prompt, model, message) {
    const instance = new QueryRequestBody(prompt, model, message);
    await instance.initialize();
    return instance;
  }

  // Private method handles all async initialization
  async initialize() {
    // Load all configuration values in parallel for better performance
    const [
      temperature,
      topP,
      topK,
      minP,
      generateWindow,
      maxTokens
    ] = await Promise.all([
      retrieveConfigValue("samplers.tool.temperature"),
      retrieveConfigValue("samplers.tool.topP"),
      retrieveConfigValue("samplers.tool.topK"),
      retrieveConfigValue("samplers.tool.minP"),
      retrieveConfigValue("samplers.tool.generateWindow"),
      retrieveConfigValue("samplers.tool.maxTokens")
    ]);

    // Assign and parse all the configuration values
    this.temperature = parseFloat(temperature);
    this.top_p = parseFloat(topP);
    this.top_k = parseInt(topK);
    this.min_p = parseFloat(minP);
    this.generate_window = parseInt(generateWindow);
    this.max_tokens = parseInt(maxTokens);
    this.stream = true;
  }
}

export class ModerationRequestBody {
  // Constructor handles synchronous initialization of message structure and schema
  constructor(prompt, model, message) {
    // Initialize the basic messaging structure for moderation requests
    this.model = model;
    this.messages = [
      {
        role: "system",
        content: prompt,
      },
      {
        role: "user",
        content: message,
      },
    ];

    // Set up the JSON schema for moderation responses
    // This is static and defines the structure all moderation responses must follow
    this.response_format = {
      type: "json_schema",
      json_schema: {
        name: "moderator_response",
        schema: {
          type: "object",
          properties: {
            actionNeeded: {
              type: "boolean",
              description: "Whether the user's message is deemed safe (false) or needs to be actioned (true)."
            },
            actionType: {
              type: "string",
              description: "Whether or not the user's message requires a strike or a ban."
            },
            reason: {
              type: "string",
              description: "The reason for issuing the action to the user."
            },
          },
          required: ["actionNeeded", "actionType", "reason"],
          additionalProperties: false
        },
        strict: true
      }
    };
  }

  // Static factory method provides a clean async interface for creating instances
  static async create(prompt, model, message) {
    const instance = new ModerationRequestBody(prompt, model, message);
    await instance.initialize();
    return instance;
  }

  // Private method handles asynchronous initialization of configuration values
  async initialize() {
    // Load all configuration values in parallel using Promise.all for efficiency
    const [temperature, topP, topK, minP] = await Promise.all([
      retrieveConfigValue("samplers.tool.temperature"),
      retrieveConfigValue("samplers.tool.topP"),
      retrieveConfigValue("samplers.tool.topK"),
      retrieveConfigValue("samplers.tool.minP")
    ]);

    // Parse and assign the configuration values to the instance
    this.temperature = parseFloat(temperature);
    this.top_p = parseFloat(topP);
    this.top_k = parseInt(topK);
    this.min_p = parseFloat(minP);
    this.stream = true;
  }
}

export class SummaryRequestBody {
  // Constructor handles synchronous initialization of the core structure
  constructor(prompt, model, message) {
    // Set up the basic message structure that all requests need
    this.model = model;
    this.messages = [
      {
        role: "system",
        content: prompt,
      },
      {
        role: "user",
        content: message,
      },
    ];

    // Define the JSON schema that governs the format of summary responses
    // This schema ensures we get both a vector-optimized string and complete summary
    this.response_format = {
      type: "json_schema",
      json_schema: {
        name: "summary_response",
        schema: {
          type: "object",
          properties: {
            vectorString: {
              type: "string",
              description: "A single brief and concise sentence about what you've summarized, optimized for ease of retrieval in a vector similarity search."
            },
            summaryContents: {
              type: "string",
              description: "The complete contents of your summary."
            },
          },
          required: ["vectorString", "summaryContents"],
          additionalProperties: false
        },
        strict: true
      }
    };
  }

  // Static factory method creates a clean interface for async instantiation
  static async create(prompt, model, message) {
    const instance = new SummaryRequestBody(prompt, model, message);
    await instance.initialize();
    return instance;
  }

  // Private method handles all asynchronous configuration loading
  async initialize() {
    // Load all sampler configuration values in parallel for better performance
    // This reduces initialization time compared to sequential loading
    const [temperature, topP, topK, minP] = await Promise.all([
      retrieveConfigValue("samplers.tool.temperature"),
      retrieveConfigValue("samplers.tool.topP"),
      retrieveConfigValue("samplers.tool.topK"),
      retrieveConfigValue("samplers.tool.minP")
    ]);

    // Parse and assign the configuration values, ensuring proper type conversion
    this.temperature = parseFloat(temperature);
    this.top_p = parseFloat(topP);
    this.top_k = parseInt(topK);
    this.min_p = parseFloat(minP);
    this.stream = true;
  }
}

export class ConvertDocsRequestBody {
  constructor(prompt, model, message) {
    return (async () => {
      this.model = model;
      this.messages = [
        {
          role: "system",
          content: prompt,
        },
        {
          role: "user",
          content: message,
        },
      ];

      this.temperature = parseFloat(
        await retrieveConfigValue("samplers.tool.temperature"),
      );
      this.top_p = parseFloat(await retrieveConfigValue("samplers.tool.topP"));
      this.top_k = parseInt(await retrieveConfigValue("samplers.tool.topK"));
      this.min_p = parseFloat(await retrieveConfigValue("samplers.tool.minP"));
      this.response_format = {
        "type": "json_schema",
        "json_schema": {
          "name": "conversion_response",
          "schema": {
            "type": "object",
            "properties": {
              "vectorString": { "type": "string", "description": "A concisely written phrasing of the contents you've summarized, optimized for ease of retrieval in a vector similarity search." },
              "summaryContents": { "type": "string", "description": "The complete contents of the summary about the document." },
            },
            "required": ["vectorString", "summaryContents"],
            "additionalProperties": false
          },
          "strict": true
        }
      }
      return this;
    })();
  }
}