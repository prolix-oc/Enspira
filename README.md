# 🌟 Enspira: A RAG-powered, multipurpose chat bot.

Create true-to-life AI characters with personality that evolve and adapt to an ever-changing climate of knowledge and context! Building a character with Enspira is simple and fun.

## 🔧 Requirements

- A backend provider for multiple LLM models (OpenRouter, OpenAI, self-hosted, etc)
- AllTalk-TTS for TTS (set it up with `XTTSv2 2.0.2` and `RVCv2` for both compatibility and more convincing voices)
- infinity-emb to serve a reranker, embedding, and classification model.

## 🎮 See a live demo!

Talk to my bot Layla live on my [Twitch channel](https://twitch.tv/prolix_gg) to see her capabilities and the power of Enspira's character building.

## 🧑‍🦱 Character Creation

Create a character by first adding a `character_card.txt` file in the `world_info` folder. This character card will contain information like physical appearance and features that help ground your AI assistant into reality. Each physical trait should be bullet pointed in a list, using a hyphen (`-`) to denote a line.

Then, create a `character_personality.txt` file in the same directory and make a bullet-pointed list of personality traits and quirks you wish to impart upon your assistant. Prepend each line with a hypen like previously.

Afterwards, create a `player_info.txt` file to describe you, the "player", to the AI so it can retain important knowledge about you. Each line should be prepended with a hyphen.

Next, create a `scenario.txt` file to describe the scenario that the assistant is currently in. This can be either reading your chat messages, responding to emails, or any other number of tasks.

Next, create a `rules.txt` file to give the assistant some guidelines to follow when responding to user messages. This is important, as it will ground the LLM and give it proper direction. An example can be found in `world_info/player/rules.example.txt`, and should work for most if not all LLM models.

Finally, create a `world_info.txt` file to give the asssistant important details and lore about the area surrounding them. This further helps ground the character in the moment. Prepend each line with a hyphen.

## 📐 Setting Up The Models

The modularity of this framework allows it to connect to any number of OpenAI API-compatible backends, such as tabbyAPI, Ollama, Oogabooga, Textgen-Web-UI, and more! It also allows for using OpenAI's own endpoints, and OpenRouter endpoints.

### Endpoint recommendations (GPU rich):

Run quantized language models through tabbyAPI, serve embedding, reranking and classifier models via infinity-emb, then provide an endpoint URL + model name for the following tasks:

- **Summarization**: I recommend Cohere's `Command-R` or Meta's `Llama-3.3-70B-Instruct`. Bear in mind a 4bpw of Command-R (not Plus) requires almost the entirety of a 3090 to run locally, especially with 32K context.
- **Data Conversion (Optional)**: I recommend `Command-R` or Qwen's `Qwen2.5-32B-Instruct` for this task. This model will reformat non-JSON data text files into proper JSON, and create a vector database entry for it.
- **Query Building**: This model is responsible for creating a semi-colon separated string for searching the web using Brave's Search API. I recommend `Qwen2.5-7B-Instruct`, Google's `Gemma2-9B-Instruct`, or `Llama-3.1-8B-Instruct` as they follow directions very well for this task.
- **Reranking Query Builder**: This model builds a string that will rephrase the input message into a query string to feed into a reranking model of your choice. I recommend `Qwen2.5-1.5B-Instruct` or `Gemma2-2B-Instruct`, as they are lightweight and don't struggle with this task.
- **Chat Model**: This is the real meat and potatoes of the assistant. I recommend using a finetune of `Mistral-Small-Instruct-2409` called [Pantheon-RP-Pure-1.6.2](https://huggingface.co/async0x42/Gryphe_Pantheon-RP-Pure-1.6.2-22b-Small-exl2_5bpw). At a quant of 5.0bpw with 12,288 context length and FP16 cache, it uses around 21.2GB of VRAM and follows instructions properly. Another option is a finetune of `Qwen2.5-32B-Instruct` by ParasiticRogue, linked here. I recommend using their 4.25bpw quant with their custom dataset. These RP models are extremely capable of becoming characters and are recommended in my testing.
- **Embedding Models**: This can be served using `infinity-emb`, and doesn't require a GPU to run. I recommend Alibaba's `gte-large-en-v1.5` model on HuggingFace.
- **Reranking Models**: This can be served using `infinity-emb`, and doesn't require a GPU to run (though it will be faster on a GPU). I recommend MixedBread AI's `mxbai-rerank-xsmall-v1` model for CPU only, and their `large-v1` model for GPU operation. Both are available on HuggingFace.
- **Text Classifier Models**: This can be served using `infinity-emb`, and doesn't require a GPU to run. I recommend Jitesh's `emotion-english` model on HuggingFace.

### Endpoint Recommendations (1x RTX 3090):

- **Summarization**: I recommend Cohere's `Command-R` or Meta's `Llama-3.3-70B-Instruct`, served via OpenRouter. They are both low-cost, very accurate models that can be guided to create accurate summaries of web data.
- **Data Conversion (Optional)**: I recommend `Command-R` or Qwen's `Qwen2.5-32B-Instruct` served via OpenRouter.
- **Query Building**: This model is responsible for creating a semi-colon separated string for searching the web using Brave's Search API. I recommend `Qwen2.5-7B-Instruct`, Google's `Gemma2-9B-Instruct`, or `Llama-3.1-8B-Instruct` served via OpenRouter.
- **Reranking Query Builder**: Run a separate instance of tabbyAPI with a 4bpw quant of `Qwen2.5-1.5B-Instruct`, 2048 context length and Q8 cache. This only occupies 1.1GB of VRAM.
- **Chat Model**: I recommend the `Mistral-Small-Instruct-2409` finetune [Pantheon-RP-Pure-1.6.2](https://huggingface.co/async0x42/Gryphe_Pantheon-RP-Pure-1.6.2-22b-Small-exl2_5bpw) in a 5bpw EXL2 quant, 12,288 context length, and FP16 cache. This model will occupy 18.6GB of VRAM on my own RTX 3090, and generates outputs at 48-50 tokens per second.
- **Embedding, Reranking and Classifier Models**: Rent a cloud VPS or use a system you may have at home to run the `infinity-emb` models mentioned above in `fp32` format. Reranking on dual Xeon E5-2697v4s with 192GB of RAM takes approximately 1 second for ten documents, and creating embeddings from a batch of 28 documents takes about 400-500ms (in my experience). Text classification takes 32ms.

### Endpoint Recommendations (GPU Poor):

- Find all equivalent models via an API provider like OpenRouter, ArliAI, or NanoGPT. These are pay-as-you-go providers, and will only charge you for what you use.

## 🎤 Setting up the TTS

Follow the setup instructions provided from the [AllTalk-TTS GitHub](https://github.com/erew123/alltalk_tts/tree/alltalkbeta), ensuring you set it up using the new v2 beta. The XTTSv2 2.0.3 model may try to download automatically. You should instead use the 2.0.2 model. Find a clear, noise-free voice sample of the voice you'd like to clone and provide it in the `voices` folder as a 16-bit, 22050Hz monaural .wav file.

Next, download an RVC model from this website and add it to the `rvc_models` folder in a new folder. For example, it should look like `Voice_Folder/Voice_File.pth` in this directory.

Customize your user profile in `auth_tokens.json` to match the speaker file and RVC model paths desired, then update the environment variables (`.env` file) with the IP and port that AllTalk has launched on.

## 🔌 Interfacing with the API

Here are the endpoints to use (these are geared towards Twitch streaming):

- `POST /chatreq`:

  - Request: `{"message": "User message here", "user": "Username", "firstMessage": false or true }`
  - Response: `{"response": "LLM text response", "audio_url": "http://linktottspath/audio/file.wav" }`

- `POST /eventreq`:

  - Request: `{"eventType": "<refer to docs>", "eventData": {... JSON object of event data from Twitch (refer to docs)... } }`
  - Response: `{"response": "LLM text response", "audio_url": "http://linktottspath/audio/file.wav" }`

- `POST /voicereq`:

  - **WARNING**: This step requires using the Enspira-STT backend application. This endpoint should not be used if you are not using the Enspira-STT backend.
  - Request: `{"message": "Whisper transcribed speech"}`
  - Response: `{"response": "LLM text response", "audio_url": "http://linktottspath/audio/file.wav" }`

## 📖More documentation soon!

Bear with me as I continue to develop this. Feel free to ask questions in my [Discord server](https://discord.gg/prolix-creates-761728802728181811) or come by my [Twitch channel](https://twitch.tv/prolix_gg).
