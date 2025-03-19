// restart-helper.js
// This script is used to restart the main application
// It's executed as a detached child process when the restart command is issued

import { spawn } from 'child_process';
import { setTimeout } from 'timers/promises';

// Wait for the parent process to exit
await setTimeout(1000);

// Start the application again
const app = spawn('node', ['main.js'], {
  detached: true,
  stdio: 'inherit'
});

// Detach from the child process so it can run independently
app.unref();

// Exit this helper
process.exit(0);