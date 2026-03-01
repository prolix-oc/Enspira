/**
 * LLM Request Body Classes for Enspira
 * Handles construction of request bodies for various LLM API calls
 * @module core/llm-requests
 */

import { retrieveConfigValue } from './config.js';
import type {
  ChatMessage,
  ChatPromptData,
  ResponseFormat,
} from '../types/index.js';

// ============================================
// Chat Request Body
// ============================================

/**
 * Builds a chat completion request body with all context components
 */
export class ChatRequestBody {
  messages: ChatMessage[];
  stream: boolean;
  model?: string;
  top_k?: number;
  min_p?: number;
  xtc_threshold?: number;
  xtc_probability?: number;
  top_p?: number;
  typical_p?: number;
  min_tokens?: number;
  repetition_penalty?: number;
  presence_penalty?: number;
  repetition_range?: number;
  presence_range?: number;
  temperature?: number;
  max_tokens?: number;
  generate_window?: number;
  dynatemp?: boolean;
  dynatemp_min?: number;
  dynatemp_max?: number;

  constructor(promptData: ChatPromptData) {
    this.messages = [
      // System message with core instructions
      {
        role: 'system',
        content: promptData.systemPrompt,
      },
    ];

    // Add each context component as a separate user message
    if (promptData.characterDescription) {
      this.messages.push({
        role: 'user',
        content: promptData.characterDescription,
      });
    }

    if (promptData.characterPersonality) {
      this.messages.push({
        role: 'user',
        content: promptData.characterPersonality,
      });
    }

    if (promptData.worldInfo) {
      this.messages.push({
        role: 'user',
        content: promptData.worldInfo,
      });
    }

    if (promptData.scenario) {
      this.messages.push({
        role: 'user',
        content: promptData.scenario,
      });
    }

    if (promptData.playerInfo) {
      this.messages.push({
        role: 'user',
        content: promptData.playerInfo,
      });
    }

    if (promptData.recentChat) {
      this.messages.push({
        role: 'user',
        content: promptData.recentChat,
      });
    }

    if (promptData.weatherInfo) {
      this.messages.push({
        role: 'user',
        content: promptData.weatherInfo,
      });
    }

    // Add additional context elements if they exist
    if (promptData.additionalContext) {
      Object.entries(promptData.additionalContext).forEach(([_key, value]) => {
        if (value && value.trim()) {
          this.messages.push({
            role: 'user',
            content: value,
          });
        }
      });
    }

    // Add assistant acknowledgment
    this.messages.push({
      role: 'assistant',
      content:
        "I understand. I'll keep the provided rules, character information, and provided context in mind when responding to the next user message.",
    });

    // Add the actual user query
    this.messages.push({
      role: 'user',
      content: promptData.userMessage,
    });

    // Set streaming to true by default
    this.stream = true;
  }

  /**
   * Static factory method for async initialization
   */
  static async create(promptData: ChatPromptData): Promise<ChatRequestBody> {
    const instance = new ChatRequestBody(promptData);
    await instance.initialize();
    return instance;
  }

  /**
   * Handle async initialization - loads config values in parallel
   */
  async initialize(): Promise<void> {
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
      generateWindow,
    ] = await Promise.all([
      retrieveConfigValue<string>('models.chat.model'),
      retrieveConfigValue<string>('samplers.chat.topK'),
      retrieveConfigValue<string>('samplers.chat.minP'),
      retrieveConfigValue<string>('samplers.chat.xtcThreshold'),
      retrieveConfigValue<string>('samplers.chat.xtcProbability'),
      retrieveConfigValue<string>('samplers.chat.topP'),
      retrieveConfigValue<string>('samplers.chat.typicalP'),
      retrieveConfigValue<string>('samplers.chat.minTokens'),
      retrieveConfigValue<string>('samplers.chat.repetitionPenalty'),
      retrieveConfigValue<string>('samplers.chat.presencePenalty'),
      retrieveConfigValue<string>('samplers.chat.repetitionRange'),
      retrieveConfigValue<string>('samplers.chat.presenceRange'),
      retrieveConfigValue<string>('samplers.chat.temperature'),
      retrieveConfigValue<string>('samplers.chat.dynTempMin'),
      retrieveConfigValue<string>('samplers.chat.dynTempMax'),
      retrieveConfigValue<boolean>('samplers.chat.dynTemp'),
      retrieveConfigValue<string>('samplers.chat.maxTokens'),
      retrieveConfigValue<string>('samplers.chat.generateWindow'),
    ]);

    // Assign values to this instance
    this.model = model;
    this.top_k = parseInt(String(topK), 10);
    this.min_p = parseFloat(String(minP));
    this.xtc_threshold = parseFloat(String(xtcThreshold));
    this.xtc_probability = parseFloat(String(xtcProbability));
    this.top_p = parseFloat(String(topP));
    this.typical_p = parseFloat(String(typicalP));
    this.min_tokens = parseInt(String(minTokens), 10);
    this.repetition_penalty = parseFloat(String(repetitionPenalty));
    this.presence_penalty = parseFloat(String(presencePenalty));
    this.repetition_range = parseInt(String(repetitionRange), 10);
    this.presence_range = parseInt(String(presenceRange), 10);
    this.temperature = parseFloat(String(temperature));
    this.max_tokens = parseInt(String(maxTokens), 10);
    this.generate_window = parseInt(String(generateWindow), 10);

    // Add dynamic temperature settings if enabled
    if (dynTemp) {
      this.dynatemp = dynTemp;
      this.dynatemp_min = parseFloat(String(dynTempMin));
      this.dynatemp_max = parseFloat(String(dynTempMax));
    }
  }
}

// ============================================
// Chain-of-Thought Chat Request Body
// ============================================

/**
 * Builds a chat completion request with chain-of-thought JSON schema
 */
export class ChatRequestBodyCoT {
  messages: ChatMessage[];
  stream: boolean;
  response_format: ResponseFormat;
  model?: string;
  max_tokens?: number;
  generate_window?: number;
  top_k?: number;
  min_p?: number;
  xtc_threshold?: number;
  xtc_probability?: number;
  top_p?: number;
  typical_p?: number;
  min_tokens?: number;
  repetition_penalty?: number;
  presence_penalty?: number;
  repetition_range?: number;
  presence_range?: number;
  temperature?: number;
  dynatemp?: boolean;
  dynatemp_min?: number;
  dynatemp_max?: number;

  constructor(promptData: ChatPromptData) {
    // Initialize with the system prompt
    this.messages = [
      {
        role: 'system',
        content: promptData.systemPrompt,
      },
    ];

    // Add each context component as a separate user message
    if (promptData.characterDescription) {
      this.messages.push({
        role: 'user',
        content: promptData.characterDescription,
      });
    }

    if (promptData.characterPersonality) {
      this.messages.push({
        role: 'user',
        content: promptData.characterPersonality,
      });
    }

    if (promptData.worldInfo) {
      this.messages.push({
        role: 'user',
        content: promptData.worldInfo,
      });
    }

    if (promptData.scenario) {
      this.messages.push({
        role: 'user',
        content: promptData.scenario,
      });
    }

    if (promptData.playerInfo) {
      this.messages.push({
        role: 'user',
        content: promptData.playerInfo,
      });
    }

    if (promptData.recentChat) {
      this.messages.push({
        role: 'user',
        content: promptData.recentChat,
      });
    }

    if (promptData.weatherInfo) {
      this.messages.push({
        role: 'user',
        content: promptData.weatherInfo,
      });
    }

    // Add additional context elements if they exist
    if (promptData.additionalContext) {
      Object.entries(promptData.additionalContext).forEach(([_key, value]) => {
        if (value && value.trim()) {
          this.messages.push({
            role: 'user',
            content: value,
          });
        }
      });
    }

    // Add assistant acknowledgment
    this.messages.push({
      role: 'assistant',
      content:
        "I understand all given instructions and who I am now. I'll ensure I think deeply but concisely about the message and respond according to my thoughts.",
    });

    // Add the actual user query
    this.messages.push({
      role: 'user',
      content: promptData.userMessage,
    });

    // Set streaming to true by default
    this.stream = true;

    // Define the JSON response format for chain-of-thought
    this.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'thoughtful_response',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            thoughts: {
              type: 'array',
              items: {
                type: 'string',
                description:
                  "One brief thought about the user's message. Keep each thought under 250 words maximum.",
              },
              // Note: maxItems is not part of standard JSON Schema but may be supported by some LLM APIs
            },
            final_response: {
              type: 'string',
              description:
                'Your final response to the user, optimized for Twitch chat. Keep it under 500 characters when possible.',
            },
          },
          required: ['thoughts', 'final_response'],
          additionalProperties: false,
        },
      },
    };
  }

  /**
   * Static factory method for async initialization
   */
  static async create(promptData: ChatPromptData): Promise<ChatRequestBodyCoT> {
    const instance = new ChatRequestBodyCoT(promptData);
    await instance.initialize();
    return instance;
  }

  /**
   * Handle async initialization
   */
  async initialize(): Promise<void> {
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
      dynTempMax,
    ] = await Promise.all([
      retrieveConfigValue<string>('models.chat.model'),
      retrieveConfigValue<string>('samplers.chat.maxTokens'),
      retrieveConfigValue<string>('samplers.chat.generateWindow'),
      retrieveConfigValue<string>('samplers.chat.topK'),
      retrieveConfigValue<string>('samplers.chat.minP'),
      retrieveConfigValue<string>('samplers.chat.xtcThreshold'),
      retrieveConfigValue<string>('samplers.chat.xtcProbability'),
      retrieveConfigValue<string>('samplers.chat.topP'),
      retrieveConfigValue<string>('samplers.chat.typicalP'),
      retrieveConfigValue<string>('samplers.chat.minTokens'),
      retrieveConfigValue<string>('samplers.chat.repetitionPenalty'),
      retrieveConfigValue<string>('samplers.chat.presencePenalty'),
      retrieveConfigValue<string>('samplers.chat.repetitionRange'),
      retrieveConfigValue<string>('samplers.chat.presenceRange'),
      retrieveConfigValue<string>('samplers.chat.temperature'),
      retrieveConfigValue<boolean>('samplers.chat.dynTemp'),
      retrieveConfigValue<string>('samplers.chat.dynTempMin'),
      retrieveConfigValue<string>('samplers.chat.dynTempMax'),
    ]);

    // Assign and parse all configuration values
    this.model = model;
    this.max_tokens = parseInt(String(maxTokens), 10);
    this.generate_window = parseInt(String(generateWindow), 10);
    this.top_k = parseInt(String(topK), 10);
    this.min_p = parseFloat(String(minP));
    this.xtc_threshold = parseFloat(String(xtcThreshold));
    this.xtc_probability = parseFloat(String(xtcProbability));
    this.top_p = parseFloat(String(topP));
    this.typical_p = parseFloat(String(typicalP));
    this.min_tokens = parseInt(String(minTokens), 10);
    this.repetition_penalty = parseFloat(String(repetitionPenalty));
    this.presence_penalty = parseFloat(String(presencePenalty));
    this.repetition_range = parseInt(String(repetitionRange), 10);
    this.presence_range = parseInt(String(presenceRange), 10);
    this.temperature = parseFloat(String(temperature));

    // Add dynamic temperature settings if enabled
    if (dynTemp) {
      this.dynatemp = dynTemp;
      this.dynatemp_min = parseFloat(String(dynTempMin));
      this.dynatemp_max = parseFloat(String(dynTempMax));
    }
  }
}

// ============================================
// Tool Request Body
// ============================================

/**
 * Builds a simple tool request body with system and user messages
 */
export class ToolRequestBody {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  stream: boolean;

  constructor(prompt: string, model: string, message: string) {
    this.model = model;
    this.messages = [
      {
        role: 'system',
        content: prompt,
      },
      {
        role: 'user',
        content: message,
      },
    ];
    this.stream = true;
  }

  /**
   * Static factory method for async initialization
   */
  static async create(
    prompt: string,
    model: string,
    message: string
  ): Promise<ToolRequestBody> {
    const instance = new ToolRequestBody(prompt, model, message);
    await instance.initialize();
    return instance;
  }

  /**
   * Private method handles all async initialization
   */
  async initialize(): Promise<void> {
    const [temperature, topP, topK, minP] = await Promise.all([
      retrieveConfigValue<string>('samplers.tool.temperature'),
      retrieveConfigValue<string>('samplers.tool.topP'),
      retrieveConfigValue<string>('samplers.tool.topK'),
      retrieveConfigValue<string>('samplers.tool.minP'),
    ]);

    this.temperature = parseFloat(String(temperature));
    this.top_p = parseFloat(String(topP));
    this.top_k = parseInt(String(topK), 10);
    this.min_p = parseFloat(String(minP));
  }
}

// ============================================
// Query Request Body
// ============================================

/**
 * Builds a query request body with JSON schema for structured search responses
 */
export class QueryRequestBody {
  model: string;
  messages: ChatMessage[];
  response_format: ResponseFormat;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  generate_window?: number;
  max_tokens?: number;
  stream: boolean;

  constructor(prompt: string, model: string, message: string) {
    this.model = model;
    this.messages = [
      {
        role: 'system',
        content: prompt,
      },
      {
        role: 'user',
        content: message,
      },
    ];
    this.stream = true;

    // Initialize the JSON schema response format
    this.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'query_response',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            valid: {
              type: 'boolean',
              description:
                'Whether or not this is a Valid Inquiry for performing searches on. True for valid, False for invalid.',
            },
            searchTerm: {
              type: 'string',
              description:
                'The SEO-optimized search term related to the inquiry.',
            },
            subject: {
              type: 'string',
              description: 'The inferred subject of the inquiry.',
            },
            vectorString: {
              type: 'string',
              description:
                'The vector similarity search optimized string you have created.',
            },
            freshness: {
              type: 'string',
              description: 'The freshness rating that applies to this search.',
            },
            reason: {
              type: 'string',
              description:
                'If query was deemed to be not valid, briefly and concisely explain why you determined the query was invalid. For valid queries, leave this empty.',
            },
          },
          required: [
            'valid',
            'searchTerm',
            'subject',
            'vectorString',
            'freshness',
            'reason',
          ],
          additionalProperties: false,
        },
      },
    };
  }

  /**
   * Static factory method for async initialization
   */
  static async create(
    prompt: string,
    model: string,
    message: string
  ): Promise<QueryRequestBody> {
    const instance = new QueryRequestBody(prompt, model, message);
    await instance.initialize();
    return instance;
  }

  /**
   * Private method handles all async initialization
   */
  async initialize(): Promise<void> {
    const [temperature, topP, topK, minP, generateWindow, maxTokens] =
      await Promise.all([
        retrieveConfigValue<string>('samplers.tool.temperature'),
        retrieveConfigValue<string>('samplers.tool.topP'),
        retrieveConfigValue<string>('samplers.tool.topK'),
        retrieveConfigValue<string>('samplers.tool.minP'),
        retrieveConfigValue<string>('samplers.tool.generateWindow'),
        retrieveConfigValue<string>('samplers.tool.maxTokens'),
      ]);

    this.temperature = parseFloat(String(temperature));
    this.top_p = parseFloat(String(topP));
    this.top_k = parseInt(String(topK), 10);
    this.min_p = parseFloat(String(minP));
    this.generate_window = parseInt(String(generateWindow), 10);
    this.max_tokens = parseInt(String(maxTokens), 10);
  }
}

// ============================================
// Moderation Request Body
// ============================================

/**
 * Builds a moderation request body with JSON schema for structured moderation responses
 */
export class ModerationRequestBody {
  model: string;
  messages: ChatMessage[];
  response_format: ResponseFormat;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  stream: boolean;

  constructor(prompt: string, model: string, message: string) {
    this.model = model;
    this.messages = [
      {
        role: 'system',
        content: prompt,
      },
      {
        role: 'user',
        content: message,
      },
    ];
    this.stream = true;

    // Set up the JSON schema for moderation responses
    this.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'moderator_response',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            actionNeeded: {
              type: 'boolean',
              description:
                "Whether the user's message is deemed safe (false) or needs to be actioned (true).",
            },
            actionType: {
              type: 'string',
              description:
                "Whether or not the user's message requires a strike or a ban.",
            },
            reason: {
              type: 'string',
              description: 'The reason for issuing the action to the user.',
            },
          },
          required: ['actionNeeded', 'actionType', 'reason'],
          additionalProperties: false,
        },
      },
    };
  }

  /**
   * Static factory method for async initialization
   */
  static async create(
    prompt: string,
    model: string,
    message: string
  ): Promise<ModerationRequestBody> {
    const instance = new ModerationRequestBody(prompt, model, message);
    await instance.initialize();
    return instance;
  }

  /**
   * Private method handles asynchronous initialization
   */
  async initialize(): Promise<void> {
    const [temperature, topP, topK, minP] = await Promise.all([
      retrieveConfigValue<string>('samplers.tool.temperature'),
      retrieveConfigValue<string>('samplers.tool.topP'),
      retrieveConfigValue<string>('samplers.tool.topK'),
      retrieveConfigValue<string>('samplers.tool.minP'),
    ]);

    this.temperature = parseFloat(String(temperature));
    this.top_p = parseFloat(String(topP));
    this.top_k = parseInt(String(topK), 10);
    this.min_p = parseFloat(String(minP));
  }
}

// ============================================
// Summary Request Body
// ============================================

/**
 * Builds a summary request body with JSON schema for structured summary responses
 */
export class SummaryRequestBody {
  model: string;
  messages: ChatMessage[];
  response_format: ResponseFormat;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  stream: boolean;

  constructor(prompt: string, model: string, message: string) {
    this.model = model;
    this.messages = [
      {
        role: 'system',
        content: prompt,
      },
      {
        role: 'user',
        content: message,
      },
    ];
    this.stream = true;

    // Define the JSON schema for summary responses
    this.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'summary_response',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            vectorString: {
              type: 'string',
              description:
                "A single brief and concise sentence about what you've summarized, optimized for ease of retrieval in a vector similarity search.",
            },
            summaryContents: {
              type: 'string',
              description: 'The complete contents of your summary.',
            },
          },
          required: ['vectorString', 'summaryContents'],
          additionalProperties: false,
        },
      },
    };
  }

  /**
   * Static factory method for async initialization
   */
  static async create(
    prompt: string,
    model: string,
    message: string
  ): Promise<SummaryRequestBody> {
    const instance = new SummaryRequestBody(prompt, model, message);
    await instance.initialize();
    return instance;
  }

  /**
   * Private method handles all asynchronous configuration loading
   */
  async initialize(): Promise<void> {
    const [temperature, topP, topK, minP] = await Promise.all([
      retrieveConfigValue<string>('samplers.tool.temperature'),
      retrieveConfigValue<string>('samplers.tool.topP'),
      retrieveConfigValue<string>('samplers.tool.topK'),
      retrieveConfigValue<string>('samplers.tool.minP'),
    ]);

    this.temperature = parseFloat(String(temperature));
    this.top_p = parseFloat(String(topP));
    this.top_k = parseInt(String(topK), 10);
    this.min_p = parseFloat(String(minP));
  }
}

// ============================================
// Convert Docs Request Body
// ============================================

/**
 * Builds a document conversion request body with JSON schema
 * Note: Uses standard async factory pattern instead of legacy constructor-returns-promise
 */
export class ConvertDocsRequestBody {
  model: string;
  messages: ChatMessage[];
  response_format: ResponseFormat;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;

  constructor(prompt: string, model: string, message: string) {
    this.model = model;
    this.messages = [
      {
        role: 'system',
        content: prompt,
      },
      {
        role: 'user',
        content: message,
      },
    ];

    this.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'conversion_response',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            vectorString: {
              type: 'string',
              description:
                "A concisely written phrasing of the contents you've summarized, optimized for ease of retrieval in a vector similarity search.",
            },
            summaryContents: {
              type: 'string',
              description:
                'The complete contents of the summary about the document.',
            },
          },
          required: ['vectorString', 'summaryContents'],
          additionalProperties: false,
        },
      },
    };
  }

  /**
   * Static factory method for async initialization
   */
  static async create(
    prompt: string,
    model: string,
    message: string
  ): Promise<ConvertDocsRequestBody> {
    const instance = new ConvertDocsRequestBody(prompt, model, message);
    await instance.initialize();
    return instance;
  }

  /**
   * Private method handles all asynchronous configuration loading
   */
  async initialize(): Promise<void> {
    const [temperature, topP, topK, minP] = await Promise.all([
      retrieveConfigValue<string>('samplers.tool.temperature'),
      retrieveConfigValue<string>('samplers.tool.topP'),
      retrieveConfigValue<string>('samplers.tool.topK'),
      retrieveConfigValue<string>('samplers.tool.minP'),
    ]);

    this.temperature = parseFloat(String(temperature));
    this.top_p = parseFloat(String(topP));
    this.top_k = parseInt(String(topK), 10);
    this.min_p = parseFloat(String(minP));
  }
}

export default {
  ChatRequestBody,
  ChatRequestBodyCoT,
  ToolRequestBody,
  QueryRequestBody,
  ModerationRequestBody,
  SummaryRequestBody,
  ConvertDocsRequestBody,
};
