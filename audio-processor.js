// go-audio-processor.js
// Bridge between Node.js and the Go audio processing server
import fs from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import axios from 'axios';
import { logger } from './create-global-logger.js';

// Default port for the Go server
const DEFAULT_PORT = 3456;
let goServerPort = DEFAULT_PORT;
let serverProcess = null;
let serverStarting = false;
let serverReady = false;

/**
 * Starts the Go server if it's not already running
 * @returns {Promise<boolean>} - True if server started successfully
 */
export async function ensureGoServerRunning() {
  // If server is already ready, just return
  if (serverReady) {
    return true;
  }
  
  // If server is in the process of starting, wait for it
  if (serverStarting) {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (serverReady) {
          clearInterval(checkInterval);
          resolve(true);
        }
      }, 100);
      
      // Timeout after 10 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve(false);
      }, 10000);
    });
  }
  
  serverStarting = true;
  
  try {
    // Try to connect to the server first (it might already be running externally)
    try {
      await axios.get(`http://localhost:${goServerPort}/health`, { timeout: 500 });
      logger.log("Audio", "Go audio processor server is already running");
      serverReady = true;
      serverStarting = false;
      return true;
    } catch (connectionErr) {
      // Server is not running, we need to start it
      logger.log("Audio", "Starting Go audio processor server...");
    }
    
    // Find the executable
    const binaryPath = path.join(process.cwd(), 'bin', process.platform === 'win32' ? 'audio-processor.exe' : 'audio-processor');
    const binaryExists = await fs.pathExists(binaryPath);
    
    if (!binaryExists) {
      logger.error("Audio", `Go audio processor not found at ${binaryPath}`);
      serverStarting = false;
      return false;
    }
    
    // Start the server
    serverProcess = exec(`"${binaryPath}" ${goServerPort}`, (error) => {
      if (error) {
        logger.error("Audio", `Go server exited with error: ${error.message}`);
        serverReady = false;
      }
    });
    
    // Wait for the server to start
    let attempts = 0;
    const maxAttempts = 20;
    
    while (attempts < maxAttempts) {
      try {
        await axios.get(`http://localhost:${goServerPort}/health`, { timeout: 500 });
        serverReady = true;
        serverStarting = false;
        logger.log("Audio", "Go audio processor server started successfully");
        return true;
      } catch (err) {
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    logger.error("Audio", "Failed to start Go audio processor server after multiple attempts");
    serverStarting = false;
    return false;
  } catch (error) {
    logger.error("Audio", `Error starting Go server: ${error.message}`);
    serverStarting = false;
    return false;
  }
}

/**
 * Processes audio using the Go server
 * @param {string} inputFilePath - Path to the input WAV file
 * @param {Object} options - Processing options
 * @returns {Promise<string>} - Path to the processed file
 */
export async function processAudio(inputFilePath, options = {}) {
  const {
    outputDir = 'final',
    preset = 'clarity',
    userId = 'null'
  } = options;

  try {
    // Ensure server is running
    const serverRunning = await ensureGoServerRunning();
    if (!serverRunning) {
      throw new Error("Go audio processing server is not available");
    }
    
    // Create request data
    const requestData = {
      input_path: path.resolve(inputFilePath),
      preset: preset,
      user_id: userId
    };
    
    // Send request to Go server
    const response = await axios.post(`http://localhost:${goServerPort}/process`, requestData, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 second timeout
    });
    
    if (response.data.success) {
      const outputPath = path.join(outputDir, response.data.output_file);
      logger.log("Audio", `Successfully processed audio to ${outputPath}`);
      return `/${response.data.output_file}`; // Return just the filename with leading slash for URL path
    } else {
      throw new Error(response.data.error || "Unknown error processing audio");
    }
  } catch (error) {
    logger.error("Audio", `Error processing audio with Go server: ${error.message}`);
    throw error;
  }
}

/**
 * Shutdown the Go server gracefully
 */
export function shutdownGoServer() {
  if (serverProcess) {
    logger.log("Audio", "Shutting down Go audio processor server");
    serverProcess.kill();
    serverProcess = null;
    serverReady = false;
  }
}

// Register shutdown handler
process.on('exit', shutdownGoServer);
process.on('SIGINT', () => {
  shutdownGoServer();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdownGoServer();
  process.exit(0);
});