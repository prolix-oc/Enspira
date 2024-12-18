// cluster.js
import cluster from "node:cluster";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { join } from "path";
import blessed from "neo-blessed";
import { createLogger } from "./logger.js";
import * as aiHelper from "./ai-logic.js";
import { saveAuthToDisk } from "./api-helper.js";
import {  
  saveConfigToDisk,
  retrieveConfigValue,
  saveConfigValue
} from "./config-helper.js";
import levenshtein from "fast-levenshtein";

if (cluster.isPrimary) {
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  console.debug = () => {};
  const screen = blessed.screen({
    fastCSR: true,
    terminal: "xterm-256color",
    fullUnicode: true,
    dockBorders: true,
    autoPadding: true,
    ignoreDockContrast: false,
  });
  var tput = blessed.tput({
    terminal: "xterm-256color",
    extended: true,
  });
  screen.title = "🌟 Enspira";
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
    left: 1, // Adjust left position for padding
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

  function updateStatusBar(
    apiActive = false,
    dbConnected = false,
    llmStackConnected = 0,
  ) {
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
        servicesText.setContent(
          `{bold}Services: {yellow-fg}Degraded{/yellow-fg}{/bold}`,
        );
        llmStackStatus.setContent("");
        llmStackStatus.setContent(
          `{left}LLM: {yellow-fg}⚠{/yellow-fg}{/left}`,
        );
        break;
      case 2:
        screen.title = "🌟 [HEALTHY] Enspira";
        servicesText.setContent("");
        servicesText.setContent(
          `{bold}Services: {green-fg}All Online{/green-fg}{/bold}`,
        );
        llmStackStatus.setContent("");
        llmStackStatus.setContent(
          `{left}LLM: {green-fg}✓{/green-fg} Up{/left}`,
        );
        break;
      default:
        break;
    }
    apiStatusText.setContent("");
    apiStatusText.setContent(apiStatus);
    screen.render();
  }

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
  const logBox = blessed.log({
    top: 3,
    left: 0,
    bottom: 6,
    width: "100%",
    height: `97%-${statusBar.height + inputBar.height}`,
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

  // Create input bar

  logBox.focusable = true;

  screen.append(logBox);
  screen.append(inputBar);
  screen.append(statusBar);

  // Event handlers
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

  screen.key(["p"], () => {
    screen.focusNext();
    screen.render();
  });

  screen.key(["o"], () => {
    screen.focusPrevious();
    screen.render();
  });

  let worker = cluster.fork();
  let isShuttingDown = false;

  const restartWorker = async () => {
    const oldWorker = worker;
    worker = cluster.fork();

    await new Promise((resolve) => {
      worker.once("online", () => {
        oldWorker.kill();
        resolve();
      });
    });
  };

  inputBar.on("submit", async (text) => {
    var firstWord = text.replace(/ .*/, "");
    inputBar.clearValue();
    screen.render();
    switch (firstWord.toLowerCase()) {
      case "exit":
        shutdown();
        break;
      case "reload_db":
        var query = text
          .toLowerCase()
          .replace("reload_db ", "")
          .replace("reload_db", "");

        if (query === "") {
          logger.log("System", `Please specify a database to reload.`);
          break;
        }

        const items = query.split(" ");
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
      case "restart":
        logger.log("System", "Restarting framework...");
        restartWorker();
        break;
      case "get":
        var query = text.replace("get ", "").replace("get", "");
        if (query === "") {
          logger.log("System", `Please specify a setting to retrieve.`);
          break;
        }
        const getSetValue = await retrieveConfigValue(query);
        logger.log("System", `"${query}" is set to: ${getSetValue}`);
        break;
      case "set":
        var query = text.replace("set ", "").replace("set", "");
        var choices = query.split(' ')
        const didSave = await saveConfigValue(choices[0], choices[1])
        didSave ?
        logger.log("Config", `Value '${choices[1]}' for parameter ${choices[0]} saved.`) 
        :
        logger.log("Config", `Value '${choices[1]}' for parameter ${choices[0]} failed to save.`)
        break;
      case "augment":
        logger.log("System", `Sending augmentation request...`);
        var query = splitString(text);
        await manualRetrieveWebContext(query[1], query[2]);
        break;
      case "reindex":
        logger.log("System", "Issuing RAG rebuild...");
        var query = text.toLowerCase().replace("reindex ", "");
        await aiHelper.startIndexingVectors(query);
        break;
      case "infer":
        var inferQuery = text
          .toLowerCase()
          .replace("infer  ", "")
          .replace("infer", "");
        if (inferQuery === "") {
          logger.log("System", "Please enter a search inference");
        }
        logger.log(
          "LLM",
          `Generating inference optimized search for term ${inferQuery}`,
        );
        await aiHelper.inferSearchParam(inferQuery);
        break;
      default:
        logger.log("System", `Invalid command '${firstWord}'. Try again.`);
        break;
    }
    logBox.focus();
  });

  const showConfirmationBox = (screen) => async (title, message) => {
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
  screen.on("error", (err) => {
    console.error("Screen error:", err);
  });
  screen.render();
  const logger = createLogger(true, logBox, screen);

  const shutdown = async () => {
    isShuttingDown = true;
    logger.log("System", "Committing all data back to disk...");
    await saveAuthToDisk();
    await saveConfigToDisk();
    logger.log("System", "Stopping all services gracefully. Goodbye!");
    worker.send("shutdown");
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        worker.kill("SIGTERM");
        resolve();
      }, 1000);

      worker.once("exit", () => {
        clearTimeout(timeout);
        resolve();
        process.exit(0);
      });
    });
  };

  function clearLogBox() {
    logBox.setContent("");
    screen.render();
  }

  worker.on("message", async (msg) => {
    if (typeof msg === "object") {
      switch (msg.type) {
        case "restart":
          if (!isShuttingDown) restartWorker();
          break;
        case "shutdown":
          shutdown();
          break;
        case "confirm":
          const result = await confirmBox(msg.title, msg.message);
          worker.send({
            type: "confirm_response",
            id: msg.id,
            result: result,
          });
          break;
      }
    }
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  cluster.on("exit", (deadWorker, code, signal) => {
    if (!isShuttingDown && signal !== "SIGTERM") {
      worker = cluster.fork();
    }
  });
  cluster.on("message", (worker, message) => {
    if (message.type === "log") {
      logger.log(message.source, message.message);
    }
    if (message.type === "preflight") {
      let failed = 0;
      let available = 0;
      let inputData = message.data;
      Object.keys(inputData.llmStatuses).forEach(function (key) {
        if (inputData.llmStatuses[key] == true) {
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
        servicesText;
        updateStatusBar(inputData.restIsOnline, inputData.dbIsOnline, 0);
        screen.render();
      } else if (failed < available && failed > 0) {
        logger.log(
          "System",
          "Some pre-flight checks failed for LLM services. Check your URLs and API keys, and try again.",
        );
        updateStatusBar(inputData.restIsOnline, inputData.dbIsOnline, 1);
        screen.render();
      } else {
        logger.log("System", "All pre-flight checks for LLM services passed.");
        updateStatusBar(inputData.restIsOnline, inputData.dbIsOnline, 2);
        screen.render();
      }
    }
  });
  cluster.on("fork", (worker, message) => {
    clearLogBox();
    const logger = createLogger(false);
    global.logger = logger;
    console.log = function () {};
    console.debug = function () {};
    console.warn = function () {};
    console.info = function () {};
  });
} else {
  const logger = createLogger(false);
  global.logger = logger;
  console.log = function () {};
  console.debug = function () {};
  console.warn = function () {};
  console.info = function () {};

  // Export the logging function globally for the worker process
  const appPath = join(process.cwd(), "index.js");

  process.on("message", (msg) => {
    if (msg === "shutdown") {
      process.emit("cleanup");
    }
  });

  await import(pathToFileURL(appPath));
}
