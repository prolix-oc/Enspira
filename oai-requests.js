import { retrieveConfigValue } from "./config-helper.js";

export class ChatRequestBody {
  constructor(prompt, context, message, user = "") {
    return (async () => {
      this.userFrom =
        user === ""
          ? message
          : `${user} sends the following message: ${message}`;
      this.messages = [
        {
          role: "system",
          content: prompt,
        },
      ];

      if (context) {
        this.messages.push({
          role: "user",
          content: context,
        });
      }

      this.messages.push({
        role: "assistant",
        content:
          "I understand. I'll keep the provided rules, character information, and given context in mind when responding to the next user message.",
      });

      this.messages.push({
        role: "user",
        content: this.userFrom,
      });

      this.model = await retrieveConfigValue("models.chat.model");
      this.max_tokens = parseInt(
        await retrieveConfigValue("samplers.chat.maxTokens"),
      );
      this.generate_window = parseInt(
        await retrieveConfigValue("samplers.chat.generateWindow"),
      );
      this.stream = false;
      this.speculative_ngram = (await retrieveConfigValue("samplers.chat.speculativeNgram")) === "true"; // Treat as boolean
      this.token_healing = (await retrieveConfigValue("samplers.chat.tokenHealing")) === "true";;
      this.top_k = parseInt(await retrieveConfigValue("samplers.chat.topK"));
      this.min_p = parseFloat(await retrieveConfigValue("samplers.chat.minP"));
      this.xtc_threshold = parseFloat(
        await retrieveConfigValue("samplers.chat.xtcThreshold"),
      );
      this.xtc_probability = parseFloat(
        await retrieveConfigValue("samplers.chat.xtcProbability"),
      );
      this.top_p = parseFloat(await retrieveConfigValue("samplers.chat.topP"));
      this.typical_p = parseFloat(
        await retrieveConfigValue("samplers.chat.typicalP"),
      );
      this.min_tokens = parseInt(
        await retrieveConfigValue("samplers.chat.minTokens"),
      );
      this.repetition_penalty = parseFloat(
        await retrieveConfigValue("samplers.chat.repetitionPenalty"),
      );
      this.presence_penalty = parseFloat(
        await retrieveConfigValue("samplers.chat.presencePenalty"),
      );
      this.repetition_range = parseInt(
        await retrieveConfigValue("samplers.chat.repetitionRange"),
      );
      this.presence_range = parseInt(
        await retrieveConfigValue("samplers.chat.presenceRange"),
      );
      this.temperature = parseFloat(
        await retrieveConfigValue("samplers.chat.temperature"),
      );

      return this;
    })();
  }
}

export class ToolRequestBody {
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
      this.speculative_ngram = (await retrieveConfigValue("samplers.tool.speculativeNgram")) === "true";
      this.token_healing = (await retrieveConfigValue("samplers.tool.tokenHealing")) === "true";
      this.top_k = parseInt(await retrieveConfigValue("samplers.tool.topK"));
      this.min_p = parseFloat(await retrieveConfigValue("samplers.tool.minP"));

      return this;
    })();
  }
}