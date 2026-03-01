# Enspira Extension Developer Guide

This guide covers everything you need to know to build extensions for Enspira.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Extension Structure](#extension-structure)
3. [Manifest Reference](#manifest-reference)
4. [SDK API](#sdk-api)
5. [Event Types](#event-types)
6. [Storage API](#storage-api)
7. [Permissions](#permissions)
8. [Lifecycle Hooks](#lifecycle-hooks)
9. [Best Practices](#best-practices)
10. [Example Extensions](#example-extensions)

---

## Quick Start

### 1. Create Extension Directory

```bash
mkdir my-extension
cd my-extension
npm init -y
```

### 2. Create manifest.json

```json
{
  "id": "com.example.my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "A brief description of what this extension does",
  "main": "dist/index.js",
  "enspiraVersion": ">=2.0.0",
  "events": ["twitch:chat", "twitch:follow"],
  "permissions": ["events:read"]
}
```

### 3. Create Source File

```typescript
// src/index.ts
import { defineExtension } from '@enspira/sdk';

export default defineExtension({
  manifest: require('../manifest.json'),

  async onLoad(context) {
    context.logger.info('MyExtension', 'Extension loaded!');

    // Subscribe to events
    context.eventBus.subscribe('twitch:follow', async (event) => {
      const username = event.data.username;
      context.logger.info('MyExtension', `New follower: ${username}`);
    });
  },

  async onUnload() {
    // Cleanup code here
  }
});
```

### 4. Build and Install

```bash
npm run build
```

Then in Enspira TUI:
```
ext load /path/to/my-extension
ext enable com.example.my-extension
```

---

## Extension Structure

```
my-extension/
├── package.json          # npm package configuration
├── manifest.json         # Extension metadata and permissions
├── tsconfig.json         # TypeScript configuration (optional)
├── src/
│   └── index.ts          # Main entry point
└── dist/
    └── index.js          # Compiled output (referenced in manifest.main)
```

### package.json Example

```json
{
  "name": "my-extension",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "watch": "tsc --watch"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

### tsconfig.json Example

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "node",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

---

## Manifest Reference

The `manifest.json` file defines your extension's metadata and capabilities.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier (reverse domain notation recommended) |
| `name` | string | Yes | Human-readable display name |
| `version` | string | Yes | Semantic version (e.g., "1.0.0") |
| `author` | string | Yes | Author name or organization |
| `description` | string | Yes | Brief description of functionality |
| `main` | string | Yes | Path to compiled entry point |
| `enspiraVersion` | string | No | Minimum Enspira version required (e.g., ">=2.0.0") |
| `events` | string[] | No | Event types to subscribe to (for filtering) |
| `permissions` | string[] | No | Required permissions |

### ID Format

Use reverse domain notation for unique IDs:
- `com.yourcompany.extension-name`
- `io.github.username.project`

Valid characters: letters, numbers, dots, hyphens, underscores.

---

## SDK API

### defineExtension()

The main helper for creating extensions:

```typescript
import { defineExtension } from '@enspira/sdk';

export default defineExtension({
  manifest: require('../manifest.json'),

  // Lifecycle hooks
  async onLoad(context) { },
  async onUnload() { },
  async onEnable() { },
  async onDisable() { },

  // Event handlers
  async onEvent(event) { },

  // Middleware (requires permissions)
  async beforeEvent(event) { return event; },
  async afterResponse(event, response) { return response; }
});
```

### ExtensionContext

The context object passed to `onLoad`:

```typescript
interface ExtensionContext {
  logger: Logger;           // Scoped logging
  config: ReadonlyConfig;   // Read-only config access
  eventBus: EventBusClient; // Event subscription
  storage: ExtensionStorage; // Persistent storage
  manifest: ExtensionManifest;
  extensionPath: string;    // Path to extension directory
}
```

### Logger

```typescript
context.logger.info('Tag', 'Message here');
context.logger.warn('Tag', 'Warning message');
context.logger.error('Tag', 'Error message');
context.logger.debug('Tag', 'Debug message');
```

### EventBusClient

```typescript
// Subscribe to specific event type
const unsubscribe = context.eventBus.subscribe('twitch:follow', async (event) => {
  console.log('New follower:', event.data.username);
});

// Subscribe to all events
context.eventBus.subscribe('*', async (event) => {
  console.log('Event received:', event.type);
});

// Emit custom events
await context.eventBus.emit('extension:my-custom-event', {
  customData: 'value'
});

// Unsubscribe when done
unsubscribe();
```

---

## Event Types

### Twitch Events

| Event Type | Description | Data Fields |
|------------|-------------|-------------|
| `twitch:chat` | Chat message received | `user`, `message`, `firstMessage`, `badges`, `emotes` |
| `twitch:follow` | New follower | `username`, `userId`, `followed_at` |
| `twitch:subscribe` | New subscription | `user`, `subTier`, `isGift` |
| `twitch:gift` | Gift subscription | `user`, `recipientUserName`, `subTier`, `anonymous` |
| `twitch:cheer` | Bits cheered | `donoFrom`, `donoAmt`, `donoMessage` |
| `twitch:raid` | Incoming raid | `username`, `viewers` |
| `twitch:stream.online` | Stream went live | `startTime`, `type` |
| `twitch:stream.offline` | Stream ended | `endTime` |
| `twitch:redemption` | Channel point redemption | Varies by redemption |

### System Events

| Event Type | Description | Data Fields |
|------------|-------------|-------------|
| `system:startup` | Enspira started | `timestamp` |
| `system:shutdown` | Enspira shutting down | `timestamp` |
| `system:config.changed` | Configuration updated | `path`, `oldValue`, `newValue` |

### AI Events

| Event Type | Description | Data Fields |
|------------|-------------|-------------|
| `ai:response.generated` | AI response created | `user`, `originalMessage`, `response`, `type` |
| `ai:response.sent` | Response sent to chat | `response`, `chatMessageSent`, `chatMessageId` |

### Custom Events

Extensions can emit custom events using the `extension:` prefix:

```typescript
await context.eventBus.emit('extension:my-event', {
  action: 'something-happened',
  data: { key: 'value' }
});
```

### Event Object Structure

```typescript
interface EnspiraEvent {
  id: string;           // Unique event ID (UUID)
  timestamp: Date;      // When the event occurred
  type: string;         // Event type (e.g., 'twitch:follow')
  source: string;       // Origin: 'twitch', 'api', 'internal', 'extension'
  data: Record<string, unknown>;  // Event-specific data
  user?: {              // User info if applicable
    id: string;
    name: string;
    roles: string[];
  };
  meta?: {              // Additional metadata
    extensionId?: string;
    processed?: boolean;
  };
}
```

---

## Storage API

Extensions have access to isolated, persistent key-value storage backed by SQLite.

### Basic Operations

```typescript
async onLoad(context) {
  const storage = context.storage;

  // Set a value
  storage.set('my-key', { count: 42, name: 'test' });

  // Get a value
  const data = storage.get<{ count: number; name: string }>('my-key');
  console.log(data?.count); // 42

  // Check if key exists
  if (storage.has('my-key')) {
    console.log('Key exists');
  }

  // Delete a key
  const deleted = storage.delete('my-key'); // returns true if existed

  // Get all keys
  const allKeys = storage.keys();

  // Get keys with prefix
  const userKeys = storage.keys('user:');

  // Clear all data
  storage.clear();

  // Get total count
  const count = storage.size();
}
```

### Typed Storage Helper

```typescript
import { createTypedStorage } from '@enspira/sdk';

interface MyData {
  followers: string[];
  lastUpdated: string;
}

async onLoad(context) {
  const typedStorage = createTypedStorage<MyData>(context.storage);

  // Type-safe operations
  typedStorage.set('followers', ['user1', 'user2']);
  const followers = typedStorage.get('followers'); // string[] | undefined
}
```

### Storage Best Practices

- Use prefixes to namespace your keys: `myext:settings`, `myext:cache:item1`
- Store only serializable data (JSON-compatible)
- Don't store sensitive credentials in plain text
- Clean up old data periodically to avoid bloat

---

## Permissions

Extensions must declare required permissions in their manifest.

| Permission | Description |
|------------|-------------|
| `events:read` | Receive events from Enspira |
| `events:modify` | Modify events before processing (middleware) |
| `config:read` | Read Enspira configuration values |
| `user:read` | Access user data |
| `response:inject` | Inject or modify AI responses |

### Permission Examples

**Read-only extension:**
```json
{
  "permissions": ["events:read"]
}
```

**Middleware extension:**
```json
{
  "permissions": ["events:read", "events:modify"]
}
```

**Full access extension:**
```json
{
  "permissions": ["events:read", "events:modify", "config:read", "response:inject"]
}
```

---

## Lifecycle Hooks

### onLoad(context)

Called when the extension is loaded. Use this for initialization.

```typescript
async onLoad(context) {
  // Initialize resources
  this.client = new SomeClient();

  // Set up event subscriptions
  context.eventBus.subscribe('twitch:follow', this.handleFollow);

  // Load saved state
  const state = context.storage.get('state');
  if (state) {
    this.restoreState(state);
  }

  context.logger.info('MyExt', 'Extension loaded successfully');
}
```

### onUnload()

Called when the extension is unloaded. Clean up resources here.

```typescript
async onUnload() {
  // Save state before unloading
  this.context.storage.set('state', this.getState());

  // Close connections
  await this.client?.close();

  // Clear timers
  clearInterval(this.updateTimer);
}
```

### onEnable()

Called when the extension is enabled (after being disabled).

```typescript
async onEnable() {
  // Resume functionality
  this.startProcessing();
}
```

### onDisable()

Called when the extension is disabled (but still loaded).

```typescript
async onDisable() {
  // Pause functionality without full cleanup
  this.stopProcessing();
}
```

### onEvent(event)

Called for each event the extension is subscribed to.

```typescript
async onEvent(event) {
  switch (event.type) {
    case 'twitch:follow':
      await this.handleFollow(event);
      break;
    case 'twitch:subscribe':
      await this.handleSubscribe(event);
      break;
  }
}
```

---

## Best Practices

### Error Handling

Always wrap async operations in try-catch:

```typescript
async onEvent(event) {
  try {
    await this.processEvent(event);
  } catch (error) {
    this.context.logger.error('MyExt', `Error processing event: ${error}`);
    // Don't re-throw - let other extensions continue
  }
}
```

### Resource Management

- Clean up subscriptions in `onUnload`
- Close network connections
- Clear timers and intervals
- Save important state before unload

### Performance

- Avoid blocking operations in event handlers
- Use async/await properly
- Don't hold large objects in memory
- Use storage for persistence, not in-memory caches

### Security

- Validate all external input
- Don't log sensitive information
- Use HTTPS for external API calls
- Don't store credentials in plain text

### Compatibility

- Specify `enspiraVersion` in manifest
- Handle missing optional features gracefully
- Test with different Enspira configurations

---

## Example Extensions

### Discord Webhook Notifier

Sends notifications to Discord when events occur.

```typescript
// src/index.ts
import { defineExtension, EnspiraEvent } from '@enspira/sdk';

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

async function sendToDiscord(message: string): Promise<void> {
  await fetch(WEBHOOK_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: message })
  });
}

export default defineExtension({
  manifest: require('../manifest.json'),

  async onLoad(context) {
    context.logger.info('Discord', 'Discord notifier loaded');

    context.eventBus.subscribe('twitch:follow', async (event) => {
      const username = event.data.username;
      await sendToDiscord(`New follower: **${username}**`);
    });

    context.eventBus.subscribe('twitch:subscribe', async (event) => {
      const user = event.data.user;
      const tier = event.data.subTier;
      await sendToDiscord(`New ${tier} subscriber: **${user}**`);
    });

    context.eventBus.subscribe('twitch:raid', async (event) => {
      const raider = event.data.username;
      const viewers = event.data.viewers;
      await sendToDiscord(`Raid from **${raider}** with ${viewers} viewers!`);
    });
  }
});
```

**manifest.json:**
```json
{
  "id": "com.example.discord-notifier",
  "name": "Discord Notifier",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "Sends stream events to Discord webhooks",
  "main": "dist/index.js",
  "events": ["twitch:follow", "twitch:subscribe", "twitch:raid"],
  "permissions": ["events:read"]
}
```

### Chat Statistics Tracker

Tracks chat statistics and stores them persistently.

```typescript
// src/index.ts
import { defineExtension } from '@enspira/sdk';

interface ChatStats {
  totalMessages: number;
  uniqueChatters: Set<string>;
  messagesByUser: Record<string, number>;
  lastReset: string;
}

export default defineExtension({
  manifest: require('../manifest.json'),

  async onLoad(context) {
    // Load existing stats or initialize
    const saved = context.storage.get<{
      totalMessages: number;
      uniqueChatters: string[];
      messagesByUser: Record<string, number>;
      lastReset: string;
    }>('stats');

    const stats: ChatStats = saved ? {
      totalMessages: saved.totalMessages,
      uniqueChatters: new Set(saved.uniqueChatters),
      messagesByUser: saved.messagesByUser,
      lastReset: saved.lastReset
    } : {
      totalMessages: 0,
      uniqueChatters: new Set(),
      messagesByUser: {},
      lastReset: new Date().toISOString()
    };

    context.eventBus.subscribe('twitch:chat', async (event) => {
      const user = event.data.user as string;

      stats.totalMessages++;
      stats.uniqueChatters.add(user);
      stats.messagesByUser[user] = (stats.messagesByUser[user] || 0) + 1;

      // Save every 10 messages
      if (stats.totalMessages % 10 === 0) {
        context.storage.set('stats', {
          totalMessages: stats.totalMessages,
          uniqueChatters: Array.from(stats.uniqueChatters),
          messagesByUser: stats.messagesByUser,
          lastReset: stats.lastReset
        });
      }
    });

    context.logger.info('Stats', `Loaded with ${stats.totalMessages} messages tracked`);
  },

  async onUnload() {
    // Final save handled by storage
  }
});
```

### Stream Alert System

Responds to stream events with custom messages.

```typescript
// src/index.ts
import { defineExtension } from '@enspira/sdk';

export default defineExtension({
  manifest: require('../manifest.json'),

  async onLoad(context) {
    const alertMessages = context.storage.get<Record<string, string>>('alerts') || {
      follow: 'Thanks for the follow, {user}!',
      subscribe: 'Welcome to the family, {user}!',
      raid: 'Incoming raid from {user} with {viewers} viewers!'
    };

    context.eventBus.subscribe('twitch:follow', async (event) => {
      const message = alertMessages.follow.replace('{user}', event.data.username as string);
      context.logger.info('Alert', message);
      // Could trigger TTS, overlay, etc.
    });

    context.eventBus.subscribe('twitch:subscribe', async (event) => {
      const message = alertMessages.subscribe.replace('{user}', event.data.user as string);
      context.logger.info('Alert', message);
    });

    context.eventBus.subscribe('twitch:raid', async (event) => {
      const message = alertMessages.raid
        .replace('{user}', event.data.username as string)
        .replace('{viewers}', String(event.data.viewers));
      context.logger.info('Alert', message);
    });
  }
});
```

---

## Troubleshooting

### Extension Won't Load

1. Check manifest.json is valid JSON
2. Verify `main` path points to compiled output
3. Check for missing required fields in manifest
4. Look at Enspira logs for error messages

### Events Not Received

1. Verify `events` array in manifest includes the event type
2. Check `permissions` includes `events:read`
3. Ensure extension is enabled (not just loaded)
4. Confirm event subscription in `onLoad`

### Storage Not Persisting

1. SQLite requires `better-sqlite3` to be installed
2. Check for write permissions in extensions/data directory
3. Verify you're calling `storage.set()` not just modifying objects

### Hot Reload Issues

1. Use `ext reload <id>` to reload after changes
2. Ensure build output is updated before reload
3. Check for resources not being cleaned up in `onUnload`

---

## TUI Commands Reference

| Command | Description |
|---------|-------------|
| `ext list` | List all installed extensions |
| `ext load <path>` | Load extension from directory |
| `ext unload <id>` | Unload extension by ID |
| `ext reload <id>` | Hot reload extension |
| `ext install <git-url>` | Clone and install from git |
| `ext enable <id>` | Enable a disabled extension |
| `ext disable <id>` | Disable extension (keeps loaded) |
| `ext uninstall <id>` | Remove extension completely |
| `ext info <id>` | Show extension details |

---

## Getting Help

- Check the Enspira logs for error messages
- Review example extensions for patterns
- Open an issue on the Enspira repository

Happy coding!
