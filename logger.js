import moment from "moment";
import fs from 'fs/promises'
export const createLogger = (
  isPrimary = false,
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
    if (logBox && screen) {
      const formattedLog = formatLogMessage(source, message);
      logBox.pushLine(formattedLog);
      screen.render();
    }
  };

  const writeTrace = async (trace, dest) => {
    await fs.writeFile('./logs/' + dest, trace + '\n')
  }

  const logToWorker = (source, message, type) => {
    if (process.send) {
      process.send({
        type: "log",
        source,
        message,
        timestamp: getTimestamp(),
        logType: type,
      });
    }
  };

  const logMessage = (source, message, type = "info") => {
    if (message === undefined) {
      message = source;
      source = "System";
    }

    if (isPrimary) {
      logToScreen(source, message);
    } else {
      logToWorker(source, message, type);
    }
  };

  return {
    log: (source, message, type = "info") => logMessage(source, message, type),
    system: (message) => logMessage("System", message, "info"),
    error: (message) => logMessage("Error", message, "error"),
    warn: (message) => logMessage("Warning", message, "warn"),
    info: (message) => logMessage("Info", message, "info"),
    debug: (message) => logMessage("Debug", message, "debug"),
    trace: (trace, dest) => writeTrace(trace, dest)
  };
};
