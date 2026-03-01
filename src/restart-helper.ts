/**
 * Restart Helper
 * This script is used to restart the main application
 * It's executed as a detached child process when the restart command is issued
 *
 * Bun Compatibility: Uses process.execPath instead of hardcoded 'node'
 */

import { spawn } from 'child_process';
import { setTimeout } from 'timers/promises';

// Wait for the parent process to exit
await setTimeout(1000);

// Start the application again using the current runtime (Node or Bun)
const app = spawn(process.execPath, ['src/main.tsx'], {
  detached: true,
  stdio: 'inherit',
});

// Detach from the child process so it can run independently
app.unref();

// Exit this helper
process.exit(0);
