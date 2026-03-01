/**
 * Command definitions for TUI autocomplete
 */

export interface CommandDef {
  name: string;
  args: string;
  description: string;
}

export const COMMANDS: CommandDef[] = [
  { name: 'exit', args: '', description: 'Shutdown the application' },
  { name: 'restart', args: '', description: 'Restart the application' },
  { name: 'get', args: '<setting>', description: 'Get a config value' },
  { name: 'set', args: '<setting> <value>', description: 'Set a config value' },
  {
    name: 'setuser',
    args: '<userId> <setting> <value>',
    description: 'Set user parameter',
  },
  {
    name: 'setpass',
    args: '<userId> <password>',
    description: 'Set user password',
  },
  { name: 'reindex', args: '<userId>', description: 'Rebuild RAG index' },
  {
    name: 'reload_db',
    args: '<collection> <userId>',
    description: 'Reload database',
  },
  {
    name: 'test_chats',
    args: '<userId>',
    description: 'Test chat retrieval',
  },
  { name: 'infer', args: '<term>', description: 'Generate search inference' },
  { name: 'help', args: '', description: 'Show available commands' },
  // Extension management commands
  { name: 'ext list', args: '', description: 'List installed extensions' },
  { name: 'ext load', args: '<path>', description: 'Load extension from path' },
  { name: 'ext unload', args: '<id>', description: 'Unload extension by ID' },
  { name: 'ext reload', args: '<id>', description: 'Reload extension (hot reload)' },
  {
    name: 'ext install',
    args: '<git-url>',
    description: 'Install extension from git',
  },
  { name: 'ext enable', args: '<id>', description: 'Enable a disabled extension' },
  { name: 'ext disable', args: '<id>', description: 'Disable extension (keeps loaded)' },
  { name: 'ext uninstall', args: '<id>', description: 'Uninstall extension' },
  { name: 'ext info', args: '<id>', description: 'Show extension details' },
];

/**
 * Filter commands by prefix match
 */
export function filterCommands(input: string): CommandDef[] {
  if (!input.trim()) return [];
  const lowerInput = input.toLowerCase().trim();
  return COMMANDS.filter((cmd) => cmd.name.toLowerCase().startsWith(lowerInput));
}
