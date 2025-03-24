// logger.js - Updated for single-process application
import moment from "moment";
import fs from 'fs/promises';

// Create logs directory if it doesn't exist
try {
  await fs.mkdir('./logs', { recursive: true });
} catch (err) {
  // Directory likely already exists, ignore
}

export const createLogger = (
  withUI = false,
  logBox = null,
  screen = null,
) => {
  const getTimestamp = () => moment().format("MM/DD/YY [at] HH:mm");

  const formatLogMessage = (source, message) => {
    const timestamp = getTimestamp();
    const formattedMessage =
      typeof message === "string" ? message : JSON.stringify(message);
    return `{gray-fg}${timestamp}{/} [${source}] ${formattedMessage}`;
  };

  const logToScreen = (source, message) => {
    if (withUI && logBox && screen) {
      const formattedLog = formatLogMessage(source, message);
      logBox.pushLine(formattedLog);
      screen.render();
    }
  };

  const logToFile = async (source, message, type) => {
    try {
      const timestamp = getTimestamp();
      const formattedMessage = typeof message === "string" ? message : JSON.stringify(message);
      const logEntry = `${timestamp} [${source}] [${type}] ${formattedMessage}\n`;
      
      // Append to daily log file
      const today = moment().format('YYYY-MM-DD');
      await fs.appendFile(`./logs/${today}.log`, logEntry);
      
      // Also append to type-specific log if it's an error or warning
      if (type === 'error' || type === 'warn') {
        await fs.appendFile(`./logs/${type}.log`, logEntry);
      }
    } catch (err) {
      // If we can't log to file, at least try to show it on screen
      if (withUI && logBox && screen) {
        logBox.pushLine(`{red-fg}Error writing to log file: ${err.message}{/}`);
        screen.render();
      }
    }
  };

  const writeTrace = async (trace, dest) => {
    try {
      await fs.writeFile(`./logs/${dest}`, trace + '\n');
    } catch (err) {
      if (withUI && logBox && screen) {
        logBox.pushLine(`{red-fg}Error writing trace to file: ${err.message}{/}`);
        screen.render();
      }
    }
  };

  const logMessage = (source, message, type = "info") => {
    // Log to UI
    logToScreen(source, message);
    
    // Log to file
    logToFile(source, message, type);
  };

  return {
    log: (source, message, type = "info") => logMessage(source, message, type),
    system: (message) => logMessage(source, message, "info"),
    error: (message) => logMessage(source, message, "error"),
    warn: (message) => logMessage(source, message, "warn"),
    info: (message) => logMessage(source, message, "info"),
    debug: (message) => logMessage(source, message, "debug"),
    trace: (trace, dest) => writeTrace(trace, dest)
  };
};

// Get the global logger if available, otherwise create a basic one
export function getLogger() {
  if (global._sharedObjects && global._sharedObjects.logger) {
    return global._sharedObjects.logger;
  }
  
  if (global.logger) {
    return global.logger;
  }
  
  // Fallback logger
  return createLogger(false);
}

// Export a shared logger instance to be used by modules
export const logger = getLogger();