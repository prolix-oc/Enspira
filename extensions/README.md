# Enspira Extensions

This directory contains the extension system for Enspira.

## Directory Structure

```
extensions/
├── README.md              # This file
├── DEVELOPER_GUIDE.md     # Full developer documentation
├── installed/             # Installed extensions go here
├── data/                  # Extension SQLite databases
└── template/              # Starter template for new extensions
```

## Quick Start

1. Copy the `template/` directory to start a new extension
2. Edit `manifest.json` with your extension details
3. Write your extension code in `src/index.ts`
4. Build with `npm run build`
5. Load in Enspira: `ext load /path/to/your-extension`

## TUI Commands

```
ext list              # List installed extensions
ext load <path>       # Load extension from path
ext unload <id>       # Unload extension
ext reload <id>       # Hot reload extension
ext install <git-url> # Install from git
ext enable <id>       # Enable extension
ext disable <id>      # Disable extension
ext uninstall <id>    # Remove extension
ext info <id>         # Show extension details
```

## Documentation

See [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md) for complete documentation including:

- Extension structure and manifest reference
- SDK API documentation
- Event types and handlers
- Storage API
- Permissions system
- Example extensions
- Troubleshooting guide

## Installing Extensions

### From Local Directory

```
ext load /path/to/extension
ext enable com.example.extension-id
```

### From Git

```
ext install https://github.com/user/enspira-extension.git
ext enable com.example.extension-id
```

## Creating Extensions

The simplest extension:

```typescript
// src/index.ts
import { defineExtension } from '@enspira/sdk';

export default defineExtension({
  manifest: require('../manifest.json'),

  async onLoad(context) {
    context.eventBus.subscribe('twitch:follow', async (event) => {
      context.logger.info('MyExt', `New follower: ${event.data.username}`);
    });
  }
});
```

```json
// manifest.json
{
  "id": "com.example.my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "Does something cool",
  "main": "dist/index.js",
  "permissions": ["events:read"]
}
```
