## Enspira (Server)

This is the backend server responsible for handling AI logic, Twitch integration, and API endpoints.

.
├── auth/
│   └── auth_keys.example.json  # An example file showing the data structure for user authentication, including API tokens and Twitch credentials.
│
├── config/
│   └── config.example.json  # An example configuration file detailing all settings for the server, APIs, and AI models.
│
├── routes/
│   ├── audio.js  # Defines API routes for serving and managing generated audio files for Text-to-Speech functionality.
│   ├── twitch.js  # Manages all API routes related to Twitch integration, handling EventSub webhooks, authentication, and event testing.
│   ├── v1.js  # Defines the main version 1 API routes, handling core functionalities like chat, voice interactions, and events.
│   └── web.js  # Contains routes for the web-based UI, serving pages for the dashboard, character editor, and user settings.
│
├── utils/
│   ├── api-utils.js  # Provides utility functions for making external API requests, including a client with automatic retries.
│   ├── cache-utils.js  # A utility for creating and managing in-memory caches to improve performance by storing frequently accessed data.
│   ├── error-utils.js  # Defines a custom `ApplicationError` class and handlers for consistent error management and logging.
│   ├── file-utils.js  # Contains helper functions for file system operations, like reading template files with caching.
│   ├── index.js  # A barrel file that exports all utility functions from the directory for easy and clean imports elsewhere.
│   └── string-utils.js  # Provides helper functions for string manipulation, such as replacing placeholders and formatting text for TTS.
│
├── views/  # Contains Nunjucks templates for rendering the HTML pages of the web dashboard.
│   ├── character-details.njk  # Template for displaying the detailed information of a single character from the gallery.
│   ├── character.njk  # Template for the character editor page, allowing users to define their AI's personality and description.
│   ├── dashboard.njk  # The main dashboard template, showing stream status and links to other management pages.
│   ├── gallery.njk  # The template for the character gallery, which displays all available character presets.
│   ├── help.njk  # A help page template that explains how to use template variables within the application.
│   ├── layout.njk  # The base layout template that provides the common HTML structure, navigation, and styling for all web pages.
│   ├── login.njk  # A simple template for the user login page.
│   ├── settings.njk  # The user settings page template, where users can configure their profile, social media, and security.
│   ├── twitch-health.njk  # A template for displaying the health and status of the Twitch integration services.
│   └── world.njk  # The world editor template, allowing users to define the context, scenario, and environment for their AI.
│
├── .cache_ggshield  # A cache file used by the GitGuardian shield tool to avoid re-reporting previously found secrets.
├── .gitignore  # Lists files and directories to be ignored by Git, such as logs, dependencies, and user-specific configurations.
├── ai-logic.js  # Contains the core AI logic for processing events, generating responses, and interacting with the vector database.
├── api-helper.js  # Manages user authentication data and API key access, providing functions to load, retrieve, and update user info.
├── audio-processor.js  # A module for processing audio files using FFmpeg, primarily for enhancing the quality of generated speech.
├── chat-handler.js  # Acts as the central handler for all incoming chat messages, normalizing them and deciding if an AI response is needed.
├── config-helper.js  # A utility for loading and accessing values from the `config.json` file using a simple dot-notation path.
├── create-global-logger.js  # Sets up and exports a global, shared logger instance to ensure consistent logging across the application.
├── data-helper.js  # A module for retrieving and processing data from external sources, like scraping web pages to augment AI context.
├── debug-mention-detection.js # A utility script for testing and debugging the logic that detects character name mentions in chat messages.
├── expression-parser.js  # Handles parsing of expression tags within AI responses to control the character's facial expressions.
├── index.js  # The main entry point for the application, responsible for initializing the Fastify server and registering all routes.
├── logger.js  # A module that creates a flexible logger capable of outputting to both a terminal UI and dedicated log files.
├── main.js  # The primary application file that sets up a terminal-based UI using `neo-blessed` to display logs and handle commands.
├── mongodb-client.js  # Manages all interactions with the MongoDB database, including connections, data migration, and user data operations.
├── oai-requests.js  # Defines classes that construct structured request bodies for OpenAI-compatible API endpoints.
├── package.json  # The standard Node.js project manifest, defining dependencies, scripts, and project metadata.
├── prompt-helper.js  # A key module for building and formatting the prompts sent to the LLM by combining instructions, context, and user messages.
├── response-monitor.js  # A utility for monitoring and recording statistics about API responses to track performance and detect issues.
├── restart-helper.js  # A small utility script that runs in a detached process to handle application restarts gracefully.
├── setup-alternate-spelling.js # A utility script to configure alternate spellings for character names in the database, improving voice interaction.
├── start.bat  # A simple batch script to start the application on Windows by executing `node main.js`.
├── template-engine.js  # Sets up the Nunjucks templating engine used for rendering the HTML of the web dashboard.
├── token-helper.js  # A utility that handles tokenization tasks, providing functions to count tokens in prompts and responses.
├── twitch-eventsub-manager.js  # Manages Twitch EventSub subscriptions, handling the creation, verification, and processing of webhook notifications.
├── twitch-helper.js  # A collection of helper functions for processing Twitch events and formatting them into prompts for the AI.
└── twitch-webhook-tester.js  # A command-line utility for sending mock Twitch EventSub notifications to the local webhook for testing.