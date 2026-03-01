# Enspira Extension Template

This is a starter template for building Enspira extensions.

## Getting Started

1. **Copy this directory** to a new location:
   ```bash
   cp -r template my-extension
   cd my-extension
   ```

2. **Update manifest.json** with your extension details:
   - Change `id` to a unique identifier (e.g., `com.yourname.extension-name`)
   - Update `name`, `author`, and `description`
   - Modify `events` to include only the events you need
   - Adjust `permissions` as required

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Modify src/index.ts** with your extension logic

5. **Build the extension**:
   ```bash
   npm run build
   ```

6. **Load in Enspira**:
   ```
   ext load /path/to/my-extension
   ext enable com.yourname.extension-name
   ```

## Development

- `npm run build` - Compile TypeScript to JavaScript
- `npm run watch` - Watch mode for development
- `npm run clean` - Remove compiled output

## Hot Reload

After making changes:
1. Run `npm run build`
2. In Enspira TUI: `ext reload com.yourname.extension-name`

## Documentation

See the [Developer Guide](../DEVELOPER_GUIDE.md) for:
- Full SDK API reference
- Event types and data
- Storage API
- Permissions
- Best practices
- More examples

## File Structure

```
my-extension/
├── manifest.json     # Extension metadata
├── package.json      # npm configuration
├── tsconfig.json     # TypeScript configuration
├── src/
│   └── index.ts      # Main extension code
└── dist/             # Compiled output (generated)
    └── index.js
```
