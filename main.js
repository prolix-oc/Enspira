// main.js - Main application file without using cluster
import blessed from "neo-blessed";
import fs from "fs-extra";
import path from "path";
import { createLogger } from "./logger.js";
import * as aiHelper from "./ai-logic.js";
import { saveAuthToDisk, updateUserParameter } from "./api-helper.js";
import { saveConfigToDisk, retrieveConfigValue, saveConfigValue } from "./config-helper.js";
import { fileURLToPath } from "url";
import { fork } from "child_process";

// Capture original console methods
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug
};

// Setup the UI
const screen = blessed.screen({
  fastCSR: true,
  terminal: "xterm-256color",
  fullUnicode: true,
  dockBorders: true,
  autoPadding: true,
  ignoreDockContrast: false,
});

// Set application title
screen.title = "🌟 Enspira";

// Create UI components
const statusBar = blessed.box({
  top: 0,
  left: 0,
  width: "100%",
  height: 1,
  border: {
    type: "line",
  },
  style: {
    border: {
      fg: "green",
    },
  },
});

const servicesText = blessed.text({
  parent: statusBar,
  top: 0,
  left: 1,
  content: "{bold}Services: {gray-fg}?{/gray-fg}{/bold}",
  tags: true,
});

const apiStatusText = blessed.text({
  parent: statusBar,
  left: `69%`,
  top: 0,
  content: "{left}REST: {gray-fg}?{/gray-fg}{/left}",
  tags: true,
});

const dbStatus = blessed.text({
  parent: statusBar,
  left: `80%`,
  top: 0,
  content: "{left}DB: {gray-fg}?{/gray-fg}{/left}",
  tags: true,
});

const llmStackStatus = blessed.text({
  parent: statusBar,
  left: `90%`,
  top: 0,
  content: "{left}LLM: {gray-fg}?{/gray-fg}{/left}",
  tags: true,
});

const logBox = blessed.log({
  top: 3,
  left: 0,
  bottom: 6,
  width: "100%",
  height: `97%-${statusBar.height + 3}`,
  label: "Logs",
  border: {
    type: "line",
  },
  style: {
    border: {
      fg: "cyan",
    },
  },
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  scrollbar: {
    ch: " ",
    track: {
      bg: "grey",
    },
    style: {
      inverse: true,
    },
  },
  keys: true,
  mouse: true,
  vi: true,
});

const inputBar = blessed.textbox({
  bottom: 0,
  left: 0,
  width: "100%",
  height: 3,
  label: "Command",
  border: {
    type: "line",
  },
  style: {
    border: {
      fg: "magenta",
    },
  },
  inputOnFocus: true,
});

// Add components to screen
screen.append(logBox);
screen.append(inputBar);
screen.append(statusBar);

// Create the logger and set it globally
const logger = createLogger(true, logBox, screen);
global.logger = logger;

// Make logger available as a module export for other modules to import
if (!global._sharedObjects) {
  global._sharedObjects = {};
}
global._sharedObjects.logger = logger;

console.log = (...args) => logger.log("Console", args.join(' '));
console.info = (...args) => logger.info(args.join(' '));
console.warn = (...args) => logger.warn(args.join(' '));
console.error = (...args) => logger.error(args.join(' '));
console.debug = (...args) => logger.debug(args.join(' '));

// Setup status bar update function
function updateStatusBar(apiActive = false, dbConnected = false, llmStackConnected = 0) {
  const apiStatus = apiActive
    ? "{left}REST: {green-fg}✓{/green-fg} Up{/left}"
    : "{left}REST: {red-fg}❌{/red-fg} Down{/left}";

  switch (dbConnected) {
    case false:
      screen.clearRegion(
        dbStatus.left,
        dbStatus.top,
        dbStatus.width,
        dbStatus.height,
      );
      dbStatus.setContent(`{left}DB: {red-fg}❌{/red-fg} Down{/left}`);
      break;
    case true:
      screen.clearRegion(
        dbStatus.left,
        dbStatus.top,
        dbStatus.width,
        dbStatus.height,
      );
      dbStatus.setContent(`{left}DB: {green-fg}✓{/green-fg} Up{/left}`);
      screen.render();
      break;
    default:
      screen.clearRegion(
        dbStatus.left,
        dbStatus.top,
        dbStatus.width,
        dbStatus.height,
      );
      dbStatus.setContent(`{left}DB: ❓{/left}`);
      screen.render();
      break;
  }

  switch (llmStackConnected) {
    case 0:
      screen.title = "🌟 [DOWN] Enspira";
      servicesText.setContent("");
      servicesText.setContent(`{bold}Services: {red-fg}Down{/red-fg}{/bold}`);
      llmStackStatus.setContent("");
      llmStackStatus.setContent(`{left}LLM: {red-fg}❌{/red-fg} Down{/left}`);
      break;
    case 1:
      screen.title = "🌟 [DEGRADED] Enspira";
      servicesText.setContent("");
      servicesText.setContent(`{bold}Services: {yellow-fg}Degraded{/yellow-fg}{/bold}`);
      llmStackStatus.setContent("");
      llmStackStatus.setContent(`{left}LLM: {yellow-fg}⚠{/yellow-fg}{/left}`);
      break;
    case 2:
      screen.title = "🌟 [HEALTHY] Enspira";
      servicesText.setContent("");
      servicesText.setContent(`{bold}Services: {green-fg}All Online{/green-fg}{/bold}`);
      llmStackStatus.setContent("");
      llmStackStatus.setContent(`{left}LLM: {green-fg}✓{/green-fg} Up{/left}`);
      break;
    default:
      break;
  }

  apiStatusText.setContent("");
  apiStatusText.setContent(apiStatus);
  screen.render();
}

// Handle scrolling and navigation events
logBox.on("wheelup", () => {
  logBox.scroll(-1);
  screen.render();
});

logBox.on("wheeldown", () => {
  logBox.scroll(1);
  screen.render();
});

logBox.key(["pageup"], () => {
  logBox.scroll(-logBox.height);
  screen.render();
});

logBox.key(["pagedown"], () => {
  logBox.scroll(logBox.height);
  screen.render();
});

logBox.key(["enter"], () => {
  inputBar.focus();
  screen.render();
});

screen.key(["i"], () => {
  inputBar.focus();
  inputBar.readInput();
  screen.render();
});

screen.key(["up", "down"], () => {
  logBox.focus();
  screen.render();
});

// Variable to track whether we're shutting down
let isShuttingDown = false;

// Function to reset the app module cache
function clearModuleCache() {
  Object.keys(require.cache).forEach(function (key) {
    if (!key.includes('node_modules')) {
      delete require.cache[key];
    }
  });
}

// Application restart function
async function restartApplication() {
  logger.log("System", "Restarting application...");

  // Clean up and save anything important
  await saveAuthToDisk();
  await saveConfigToDisk();

  // For ES modules, we'll use a different approach with child_process
  const restartProcess = fork('./restart-helper.js', [], {
    detached: true,
    stdio: 'ignore'
  });

  restartProcess.unref();
  process.exit(0);
}

// Function to perform a clean shutdown
async function shutdown() {
  if (isShuttingDown) return;

  isShuttingDown = true;
  logger.log("System", "Saving data before shutdown...");

  try {
    await saveAuthToDisk();
    await saveConfigToDisk();
    logger.log("System", "All data saved. Shutting down...");

    // Give time for message to display
    setTimeout(() => {
      process.exit(0);
    }, 500);
  } catch (error) {
    logger.error("System", `Error during shutdown: ${error.message}`);
    process.exit(1);
  }
}

// Handle command input
inputBar.on("submit", async (text) => {
  if (!text.trim()) {
    inputBar.clearValue();
    screen.render();
    return;
  }

  const firstWord = text.trim().split(/\s+/)[0].toLowerCase();
  const args = text.trim().slice(firstWord.length).trim();

  inputBar.clearValue();
  screen.render();

  try {
    switch (firstWord) {
      case "exit":
        shutdown();
        break;

      case "restart":
        logger.log("System", "Restarting framework...");
        restartApplication();
        break;

      case "flush_chat":
        await saveChatContextToDisk(args);
        break;

      case "test_chats":
        const testChats = await aiHelper.returnRecentChats(args, true);
        logger.log("Milvus", `Got the following content: ${JSON.stringify(testChats.chatList)} in ${testChats.executionTime} seconds.`);
        break;

      case "reload_db":
        if (!args) {
          logger.log("System", `Please specify a database to reload.`);
          break;
        }

        const items = args.split(" ");
        const collectionName = items[0];
        const userId = items[1];

        logger.log("System", `Issuing reload DB command...`);
        const done = await aiHelper.weGottaGoBald(collectionName, userId);

        if (done) {
          logger.log("System", `Database reload initiated.`);
        } else {
          logger.log("System", `Database reload failed.`);
        }
        break;

      case "get":
        if (!args) {
          logger.log("System", `Please specify a setting to retrieve.`);
          break;
        }

        const getSetValue = await retrieveConfigValue(args);
        logger.log("System", `'${args}' is set to: ${typeof (getSetValue) === "object" ?
          `${JSON.stringify(getSetValue, { spaces: 2 })}` : `${getSetValue}`}`);
        break;

      case "set":
        if (!args) {
          logger.log("System", `Please specify a setting and value to set.`);
          break;
        }

        const choices = args.split(' ');
        if (choices.length < 2) {
          logger.log("System", `Please provide both a setting name and value.`);
          break;
        }

        const didSave = await saveConfigValue(choices[0], choices[1]);
        didSave ?
          logger.log("Config", `Value '${choices[1]}' for parameter '${choices[0]}' saved.`) :
          logger.log("Config", `Value '${choices[1]}' for parameter '${choices[0]}' failed to save.`);
        break;

      case "setuser":
        if (!args) {
          logger.log("System", `Please specify a user, setting, and value.`);
          break;
        }

        const userChoices = args.split(' ');
        if (userChoices.length < 3) {
          logger.log("System", `Please provide a user ID, setting name, and value.`);
          break;
        }

        const updated = await updateUserParameter(userChoices[0], userChoices[1], userChoices[2]);
        updated ?
          logger.log("Config", `Value '${userChoices[2]}' for parameter '${userChoices[1]}' for user '${userChoices[0]}' saved.`) :
          logger.log("Config", `Value '${userChoices[2]}' for parameter '${userChoices[1]}' for user '${userChoices[0]}' failed to save.`);
        break;

      case "augment":
        logger.log("System", `Sending augmentation request...`);
        const augArgs = args.split(' ');
        if (augArgs.length < 2) {
          logger.log("System", `Please provide both a query and subject.`);
          break;
        }
        await manualRetrieveWebContext(augArgs[0], augArgs[1]);
        break;

      case "reindex":
        logger.log("System", "Issuing RAG rebuild...");
        if (!args) {
          logger.log("System", `Please specify a user ID.`);
          break;
        }
        await aiHelper.startIndexingVectors(args);
        break;

      case "infer":
        if (!args) {
          logger.log("System", "Please enter a search inference");
          break;
        }
        logger.log("LLM", `Generating inference optimized search for term ${args}`);
        await aiHelper.inferSearchParam(args);
        break;

      default:
        logger.log("System", `Invalid command '${firstWord}'. Try again.`);
        break;
    }
  } catch (error) {
    logger.error("System", `Error executing command: ${error.message}`);
  }

  logBox.focus();
});

// Handle confirmation dialog setup
const showConfirmationBox = (title, message) => {
  return new Promise((resolve) => {
    const boxWidth = Math.floor(screen.width * 0.8);

    const lines = message.split("\n").reduce((acc, line) => {
      const wrappedLines = Math.ceil(line.length / (boxWidth - 4));
      return acc + wrappedLines;
    }, 0);

    const boxHeight = Math.min(lines + 5, Math.floor(screen.height * 0.5));
    const buttonHeight = 3;
    const totalHeight = boxHeight + buttonHeight;

    const confirmBox = blessed.box({
      parent: screen,
      border: "line",
      height: totalHeight,
      width: boxWidth,
      top: Math.floor((screen.height - totalHeight) / 2),
      left: Math.floor((screen.width - boxWidth) / 2),
      label: ` {bold}${title}{/bold} `,
      tags: true,
      keys: true,
      vi: true,
      style: {
        border: {
          fg: "yellow",
        },
        focus: {
          border: {
            fg: "green",
          },
        },
      },
    });

    const messageText = blessed.text({
      parent: confirmBox,
      content: message,
      top: 1,
      left: 1,
      shrink: true,
      width: boxWidth - 4,
      style: {
        fg: "white",
      },
    });

    const yesButton = blessed.button({
      parent: confirmBox,
      mouse: true,
      keys: true,
      shrink: true,
      padding: {
        left: 1,
        right: 1,
      },
      left: Math.floor(boxWidth * 0.25),
      top: totalHeight - buttonHeight + 1,
      name: "yes",
      content: "Yes",
      style: {
        bg: "green",
        focus: {
          bg: "white",
          fg: "black",
        },
      },
    });

    const noButton = blessed.button({
      parent: confirmBox,
      mouse: true,
      keys: true,
      shrink: true,
      padding: {
        left: 1,
        right: 1,
      },
      left: Math.floor(boxWidth * 0.55),
      top: totalHeight - buttonHeight + 1,
      name: "no",
      content: "No",
      style: {
        bg: "red",
        focus: {
          bg: "white",
          fg: "black",
        },
      },
    });

    yesButton.on("press", () => {
      confirmBox.destroy();
      screen.render();
      resolve(true);
    });

    noButton.on("press", () => {
      confirmBox.destroy();
      screen.render();
      resolve(false);
    });

    yesButton.key(["tab"], () => {
      noButton.focus();
    });

    noButton.key(["tab"], () => {
      yesButton.focus();
    });

    confirmBox.key(["enter"], () => {
      if (yesButton.hasFocus()) {
        yesButton.emit("press");
      } else {
        noButton.emit("press");
      }
    });

    yesButton.focus();

    yesButton.on("focus", () => {
      yesButton.style.bg = "white";
      yesButton.style.fg = "black";
      noButton.style.bg = "red";
      noButton.style.fg = "white";
    });

    noButton.on("focus", () => {
      noButton.style.bg = "white";
      noButton.style.fg = "black";
      yesButton.style.bg = "green";
      yesButton.style.fg = "white";
    });

    screen.render();
  });
};

// Handle process shutdown gracefully
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Initialize and run the application
async function initializeApp() {
  try {
    // Log application startup
    logger.log("System", "Enspira application starting...");
    // Import and start the API server
    const { initializeApp: startApp } = await import('./index.js');

    // Start the application and get the server and status
    logger.log("System", "Starting REST server and initializing services...");
    const { server, status } = await startApp();

    // Process preflight status
    let failed = 0;
    let available = 0;
    Object.keys(status.llmStatuses).forEach(function (key) {
      if (status.llmStatuses[key] == true) {
        available += 1;
      } else {
        failed += 1;
      }
    });

    if (failed == available) {
      logger.log(
        "System",
        "Pre-flight checks failed for all LLM services. Check your URLs and API keys, and try again.",
      );
      updateStatusBar(status.restIsOnline, status.dbIsOnline, 0);
    } else if (failed < available && failed > 0) {
      logger.log(
        "System",
        "Some pre-flight checks failed for LLM services. Check your URLs and API keys, and try again.",
      );
      updateStatusBar(status.restIsOnline, status.dbIsOnline, 1);
    } else {
      logger.log("System", "All pre-flight checks for LLM services passed.");
      updateStatusBar(status.restIsOnline, status.dbIsOnline, 2);
    }
    const { registerAllUsersEventSub } = await import('./twitch-eventsub-manager.js');
    logger.log("System", "Registering Twitch EventSub subscriptions...");
    try {
      const eventSubResults = await registerAllUsersEventSub();
      logger.log("System", `EventSub registration complete: ${eventSubResults.success} successful, ${eventSubResults.failures} failed`);
    } catch (eventSubError) {
      logger.error("System", `Error registering EventSub: ${eventSubError.message}`);
    }
    logger.log("System", "Enspira is fully initialized and ready!");
    return { server, status };
  } catch (error) {
    logger.error("System", `Failed to initialize application: ${error.message}`);
    updateStatusBar(false, false, 0);
    throw error;
  }
}

// Start everything up
initializeApp();