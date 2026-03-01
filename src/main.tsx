/**
 * Main application entry point with Ink-based Terminal UI
 * Features: Command autocomplete, tabbed logs, styled components
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import { Spinner } from '@inkjs/ui';
import { fork } from 'child_process';

// Import TUI components
import {
  StatusBar,
  ServiceStatus,
  LogBox,
  TabBar,
  AutocompleteBox,
  CommandInput,
  getLogSource,
  getLogCounts,
} from './components/index.js';
import type { LogEntryData, TabType } from './components/index.js';

// Import command definitions
import { filterCommands } from './utils/commands.js';
import type { CommandDef } from './utils/commands.js';

// Import core modules
import * as vectorDb from './core/vector-db.js';
import * as ragContext from './core/rag-context.js';
import { saveAuthToDisk, updateUserParameter } from './core/api-helper.js';
import {
  saveConfigToDisk,
  retrieveConfigValue,
  saveConfigValue,
} from './core/config.js';

// Import extension system
import {
  getExtensionLoader,
  getExtensionRegistry,
  getExtensionInstaller,
} from './core/index.js';

// ==================== TYPES ====================

interface AutocompleteState {
  visible: boolean;
  selectedIndex: number;
  suggestions: CommandDef[];
}

interface AppState {
  logs: LogEntryData[];
  status: ServiceStatus;
  isInitialized: boolean;
  isShuttingDown: boolean;
  inputFocused: boolean;
  activeTab: TabType;
  inputValue: string;
  completedValue: string | undefined; // Value from autocomplete to set in input
  autocomplete: AutocompleteState;
}

// ==================== MAIN APP COMPONENT ====================

function App(): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [state, setState] = useState<AppState>({
    logs: [],
    status: {
      rest: null,
      db: null,
      llm: null,
      tts: null,
    },
    isInitialized: false,
    isShuttingDown: false,
    inputFocused: false,
    activeTab: 'all',
    inputValue: '',
    completedValue: undefined,
    autocomplete: {
      visible: false,
      selectedIndex: 0,
      suggestions: [],
    },
  });

  // Add log entry helper
  const addLog = useCallback(
    (
      category: string,
      message: string,
      level: LogEntryData['level'] = 'log'
    ) => {
      const source = getLogSource(category);
      setState((prev) => ({
        ...prev,
        logs: [
          ...prev.logs,
          {
            id: prev.logs.length,
            timestamp: new Date(),
            category,
            message,
            level,
            source,
          },
        ],
      }));
    },
    []
  );

  // Create logger interface compatible with existing code
  const tuiLogger = useMemo(
    () => ({
      log: (category: string, message: string) => addLog(category, message, 'log'),
      info: (message: string) => addLog('Info', message, 'info'),
      warn: (category: string, message: string) => addLog(category, message, 'warn'),
      error: (category: string, message: string) => addLog(category, message, 'error'),
      debug: (message: string) => addLog('Debug', message, 'debug'),
    }),
    [addLog]
  );

  // Set global logger
  useEffect(() => {
    (global as Record<string, unknown>).logger = tuiLogger;

    // Override console methods
    console.log = (...args: unknown[]) =>
      tuiLogger.log('Console', args.join(' '));
    console.info = (...args: unknown[]) => tuiLogger.info(args.join(' '));
    console.warn = (...args: unknown[]) =>
      tuiLogger.warn('Console', args.join(' '));
    console.error = (...args: unknown[]) =>
      tuiLogger.error('Console', args.join(' '));
    console.debug = (...args: unknown[]) => tuiLogger.debug(args.join(' '));
  }, [tuiLogger]);

  // Update status helper
  const updateStatus = useCallback((updates: Partial<ServiceStatus>) => {
    setState((prev) => ({
      ...prev,
      status: { ...prev.status, ...updates },
    }));
  }, []);

  // Update input value and autocomplete suggestions
  const updateInput = useCallback((value: string) => {
    const suggestions = filterCommands(value);
    setState((prev) => ({
      ...prev,
      inputValue: value,
      autocomplete: {
        visible: suggestions.length > 0 && value.trim().length > 0,
        selectedIndex: 0,
        suggestions,
      },
    }));
  }, []);

  // Clear input
  const clearInput = useCallback(() => {
    setState((prev) => ({
      ...prev,
      inputValue: '',
      completedValue: '',
      autocomplete: {
        visible: false,
        selectedIndex: 0,
        suggestions: [],
      },
    }));
  }, []);

  // Shutdown handler
  const shutdown = useCallback(async () => {
    if (state.isShuttingDown) return;

    setState((prev) => ({ ...prev, isShuttingDown: true }));
    addLog('System', 'Saving data before shutdown...');

    try {
      // Save with timeout to prevent hanging
      await Promise.race([
        Promise.all([saveAuthToDisk(), saveConfigToDisk()]),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Save timeout')), 5000)
        ),
      ]);
      addLog('System', 'All data saved. Shutting down...');
    } catch (error) {
      const err = error as Error;
      addLog('System', `Shutdown warning: ${err.message}`, 'warn');
    }

    // Force exit after a brief delay to show final messages
    setTimeout(() => {
      process.exit(0);
    }, 300);
  }, [state.isShuttingDown, addLog]);

  // Restart handler
  const restartApplication = useCallback(async () => {
    addLog('System', 'Restarting application...');

    await saveAuthToDisk();
    await saveConfigToDisk();

    // Use process.execPath for Bun compatibility
    const restartProcess = fork('./src/restart-helper.ts', [], {
      detached: true,
      stdio: 'ignore',
      execPath: process.execPath,
    });

    restartProcess.unref();
    process.exit(0);
  }, [addLog]);

  // Extension command handler
  const handleExtCommand = useCallback(
    async (args: string) => {
      const parts = args.split(/\s+/);
      const subCmd = parts[0]?.toLowerCase() || '';
      const subArgs = parts.slice(1);

      const loader = getExtensionLoader();
      const registry = getExtensionRegistry();
      const installer = getExtensionInstaller();

      switch (subCmd) {
        case 'list': {
          const extensions = registry.getAll();
          if (extensions.length === 0) {
            addLog('Extensions', 'No extensions installed.', 'info');
          } else {
            addLog('Extensions', `─── Installed Extensions (${extensions.length}) ───`, 'info');
            for (const ext of extensions) {
              const state = ext.state === 'enabled' ? '✓' : '○';
              addLog(
                'Extensions',
                `  ${state} ${ext.extension.manifest.id} v${ext.extension.manifest.version} [${ext.state}]`
              );
            }
          }
          break;
        }

        case 'load': {
          if (!subArgs[0]) {
            addLog('Extensions', 'Usage: ext load <path>', 'warn');
            break;
          }
          addLog('Extensions', `Loading extension from ${subArgs[0]}...`, 'info');
          const result = await loader.load(subArgs[0]);
          if (result.success) {
            addLog('Extensions', `Loaded extension: ${result.extensionId}`, 'info');
          } else {
            addLog('Extensions', `Failed to load: ${result.error}`, 'error');
          }
          break;
        }

        case 'unload': {
          if (!subArgs[0]) {
            addLog('Extensions', 'Usage: ext unload <id>', 'warn');
            break;
          }
          try {
            await registry.unregister(subArgs[0]);
            addLog('Extensions', `Unloaded extension: ${subArgs[0]}`, 'info');
          } catch (error) {
            addLog('Extensions', `Failed to unload: ${error}`, 'error');
          }
          break;
        }

        case 'reload': {
          if (!subArgs[0]) {
            addLog('Extensions', 'Usage: ext reload <id>', 'warn');
            break;
          }
          addLog('Extensions', `Reloading extension ${subArgs[0]}...`, 'info');
          const result = await loader.reload(subArgs[0]);
          if (result.success) {
            addLog('Extensions', `Reloaded extension: ${result.extensionId}`, 'info');
          } else {
            addLog('Extensions', `Failed to reload: ${result.error}`, 'error');
          }
          break;
        }

        case 'install': {
          if (!subArgs[0]) {
            addLog('Extensions', 'Usage: ext install <git-url>', 'warn');
            break;
          }
          addLog('Extensions', `Installing extension from ${subArgs[0]}...`, 'info');
          const result = await installer.installFromGit(subArgs[0]);
          if (result.success) {
            addLog('Extensions', `Installed extension: ${result.extensionId}`, 'info');
          } else {
            addLog('Extensions', `Failed to install: ${result.error}`, 'error');
          }
          break;
        }

        case 'enable': {
          if (!subArgs[0]) {
            addLog('Extensions', 'Usage: ext enable <id>', 'warn');
            break;
          }
          try {
            await registry.enable(subArgs[0]);
            addLog('Extensions', `Enabled extension: ${subArgs[0]}`, 'info');
          } catch (error) {
            addLog('Extensions', `Failed to enable: ${error}`, 'error');
          }
          break;
        }

        case 'disable': {
          if (!subArgs[0]) {
            addLog('Extensions', 'Usage: ext disable <id>', 'warn');
            break;
          }
          try {
            await registry.disable(subArgs[0]);
            addLog('Extensions', `Disabled extension: ${subArgs[0]}`, 'info');
          } catch (error) {
            addLog('Extensions', `Failed to disable: ${error}`, 'error');
          }
          break;
        }

        case 'uninstall': {
          if (!subArgs[0]) {
            addLog('Extensions', 'Usage: ext uninstall <id>', 'warn');
            break;
          }
          addLog('Extensions', `Uninstalling extension ${subArgs[0]}...`, 'info');
          const result = await installer.uninstall(subArgs[0]);
          if (result.success) {
            addLog('Extensions', `Uninstalled extension: ${subArgs[0]}`, 'info');
          } else {
            addLog('Extensions', `Failed to uninstall: ${result.error}`, 'error');
          }
          break;
        }

        case 'info': {
          if (!subArgs[0]) {
            addLog('Extensions', 'Usage: ext info <id>', 'warn');
            break;
          }
          const loaded = registry.get(subArgs[0]);
          if (!loaded) {
            addLog('Extensions', `Extension not found: ${subArgs[0]}`, 'error');
            break;
          }
          const m = loaded.extension.manifest;
          addLog('Extensions', `─── ${m.name} ───`, 'info');
          addLog('Extensions', `  ID: ${m.id}`);
          addLog('Extensions', `  Version: ${m.version}`);
          addLog('Extensions', `  Author: ${m.author}`);
          addLog('Extensions', `  Description: ${m.description}`);
          addLog('Extensions', `  State: ${loaded.state}`);
          addLog('Extensions', `  Path: ${loaded.path}`);
          if (m.permissions?.length) {
            addLog('Extensions', `  Permissions: ${m.permissions.join(', ')}`);
          }
          if (m.events?.length) {
            addLog('Extensions', `  Events: ${m.events.join(', ')}`);
          }
          break;
        }

        default:
          addLog(
            'Extensions',
            `Unknown subcommand '${subCmd}'. Use 'help' to see available commands.`,
            'warn'
          );
          break;
      }
    },
    [addLog]
  );

  // Command handler
  const handleCommand = useCallback(
    async (command: string) => {
      clearInput();

      const parts = command.split(/\s+/);
      const cmd = parts[0]?.toLowerCase() || '';
      const args = parts.slice(1).join(' ');

      try {
        switch (cmd) {
          case 'exit':
            await shutdown();
            break;

          case 'restart':
            addLog('System', 'Restarting framework...');
            await restartApplication();
            break;

          case 'get':
            if (!args) {
              addLog('System', 'Please specify a setting to retrieve.', 'warn');
              break;
            }
            const getValue = await retrieveConfigValue(args);
            const displayValue =
              typeof getValue === 'object'
                ? JSON.stringify(getValue, null, 2)
                : String(getValue);
            addLog('System', `'${args}' is set to: ${displayValue}`, 'info');
            break;

          case 'set':
            if (!args) {
              addLog('System', 'Please specify a setting and value to set.', 'warn');
              break;
            }
            const setArgs = args.split(' ');
            if (setArgs.length < 2) {
              addLog('System', 'Please provide both a setting name and value.', 'warn');
              break;
            }
            const didSave = await saveConfigValue(setArgs[0]!, setArgs[1]!);
            addLog(
              'Config',
              didSave
                ? `Value '${setArgs[1]}' for parameter '${setArgs[0]}' saved.`
                : `Value '${setArgs[1]}' for parameter '${setArgs[0]}' failed to save.`,
              didSave ? 'info' : 'error'
            );
            break;

          case 'setuser':
            if (!args) {
              addLog('System', 'Please specify a user, setting, and value.', 'warn');
              break;
            }
            const userArgs = args.split(' ');
            if (userArgs.length < 3) {
              addLog(
                'System',
                'Please provide a user ID, setting name, and value.',
                'warn'
              );
              break;
            }
            const updated = await updateUserParameter(
              userArgs[0]!,
              userArgs[1]!,
              userArgs[2]!
            );
            addLog(
              'Config',
              updated
                ? `Value '${userArgs[2]}' for parameter '${userArgs[1]}' for user '${userArgs[0]}' saved.`
                : `Value '${userArgs[2]}' for parameter '${userArgs[1]}' for user '${userArgs[0]}' failed to save.`,
              updated ? 'info' : 'error'
            );
            break;

          case 'setpass':
            if (!args) {
              addLog('System', 'Please specify a user ID and password.', 'warn');
              break;
            }
            const passArgs = args.split(' ');
            if (passArgs.length < 2) {
              addLog('System', 'Please provide both a user ID and password.', 'warn');
              break;
            }
            try {
              const { hashPassword } = await import('./routes/v1.js');
              const passwordData = await hashPassword(
                passArgs.slice(1).join(' ')
              );

              const hashUpdate = await updateUserParameter(
                passArgs[0]!,
                'webPasswordHash',
                passwordData.hash
              );
              const saltUpdate = await updateUserParameter(
                passArgs[0]!,
                'webPasswordSalt',
                passwordData.salt
              );
              const iterUpdate = await updateUserParameter(
                passArgs[0]!,
                'webPasswordIterations',
                passwordData.iterations
              );

              if (hashUpdate && saltUpdate && iterUpdate) {
                addLog(
                  'System',
                  `Password updated successfully for user ${passArgs[0]}`,
                  'info'
                );
              } else {
                addLog(
                  'System',
                  `Failed to update password for user ${passArgs[0]}`,
                  'error'
                );
              }
            } catch (passError) {
              const err = passError as Error;
              addLog('System', `Error setting password: ${err.message}`, 'error');
            }
            break;

          case 'reindex':
            if (!args) {
              addLog('System', 'Please specify a user ID.', 'warn');
              break;
            }
            addLog('System', 'Issuing RAG rebuild...', 'info');
            await ragContext.startIndexingVectors(args);
            break;

          case 'reload_db':
            if (!args) {
              addLog('System', 'Please specify a database to reload.', 'warn');
              break;
            }
            const dbArgs = args.split(' ');
            if (dbArgs.length < 2) {
              addLog('System', 'Please provide collection name and user ID.', 'warn');
              break;
            }
            addLog('System', 'Issuing reload DB command...', 'info');
            const done = await vectorDb.weGottaGoBald(dbArgs[0]!, dbArgs[1]!);
            addLog(
              'System',
              done ? 'Database reload initiated.' : 'Database reload failed.',
              done ? 'info' : 'error'
            );
            break;

          case 'test_chats':
            const testChats = (await ragContext.returnRecentChats(args, true)) as {
              chatList: string;
              executionTime: number;
            };
            addLog(
              'Milvus',
              `Got content: ${JSON.stringify(testChats.chatList)} in ${testChats.executionTime}s.`,
              'info'
            );
            break;

          case 'infer':
            if (!args) {
              addLog('System', 'Please enter a search inference', 'warn');
              break;
            }
            addLog('LLM', `Generating inference optimized search for term ${args}`, 'info');
            await ragContext.inferSearchParam(args, '');
            break;

          case 'help':
            addLog('System', '─── Available Commands ───', 'info');
            addLog('System', '  exit              Shutdown the application');
            addLog('System', '  restart           Restart the application');
            addLog('System', '  get <setting>     Get a config value');
            addLog('System', '  set <s> <v>       Set a config value');
            addLog('System', '  setuser <u> <s> <v>  Set user param');
            addLog('System', '  setpass <u> <p>   Set user password');
            addLog('System', '  reindex <userId>  Rebuild RAG index');
            addLog('System', '  reload_db <c> <u> Reload database');
            addLog('System', '  test_chats <u>    Test chat retrieval');
            addLog('System', '  infer <term>      Generate search inference');
            addLog('System', '─── Extension Commands ───', 'info');
            addLog('System', '  ext list          List installed extensions');
            addLog('System', '  ext load <path>   Load extension from path');
            addLog('System', '  ext unload <id>   Unload extension by ID');
            addLog('System', '  ext reload <id>   Reload extension (hot reload)');
            addLog('System', '  ext install <url> Install from git URL');
            addLog('System', '  ext enable <id>   Enable a disabled extension');
            addLog('System', '  ext disable <id>  Disable extension');
            addLog('System', '  ext uninstall <id> Uninstall extension');
            addLog('System', '  ext info <id>     Show extension details');
            break;

          case 'ext':
            await handleExtCommand(args);
            break;

          default:
            addLog(
              'System',
              `Invalid command '${cmd}'. Type 'help' for available commands.`,
              'warn'
            );
            break;
        }
      } catch (error) {
        const err = error as Error;
        addLog('System', `Error executing command: ${err.message}`, 'error');
      }
    },
    [addLog, shutdown, restartApplication, clearInput, handleExtCommand]
  );

  // Keyboard shortcuts
  useInput((input, key) => {
    // Ctrl+C to exit
    if (input === 'c' && key.ctrl) {
      shutdown();
      return;
    }

    // Tab switching with 1/2/3 - only when input is empty
    if (state.inputValue === '') {
      if (input === '1') {
        setState((prev) => ({ ...prev, activeTab: 'all' }));
        return;
      }
      if (input === '2') {
        setState((prev) => ({ ...prev, activeTab: 'system' }));
        return;
      }
      if (input === '3') {
        setState((prev) => ({ ...prev, activeTab: 'events' }));
        return;
      }
    }

    // Autocomplete navigation
    if (state.autocomplete.visible) {
      if (key.upArrow) {
        setState((prev) => ({
          ...prev,
          autocomplete: {
            ...prev.autocomplete,
            selectedIndex: Math.max(0, prev.autocomplete.selectedIndex - 1),
          },
        }));
        return;
      }

      if (key.downArrow) {
        setState((prev) => ({
          ...prev,
          autocomplete: {
            ...prev.autocomplete,
            selectedIndex: Math.min(
              prev.autocomplete.suggestions.length - 1,
              prev.autocomplete.selectedIndex + 1
            ),
          },
        }));
        return;
      }

      if (key.tab) {
        // Accept selected suggestion
        const selected = state.autocomplete.suggestions[state.autocomplete.selectedIndex];
        if (selected) {
          const newValue = selected.args ? `${selected.name} ` : selected.name;
          setState((prev) => ({
            ...prev,
            inputValue: newValue,
            completedValue: newValue,
            autocomplete: {
              visible: false,
              selectedIndex: 0,
              suggestions: [],
            },
          }));
        }
        return;
      }

      if (key.escape) {
        setState((prev) => ({
          ...prev,
          autocomplete: {
            ...prev.autocomplete,
            visible: false,
          },
        }));
        return;
      }
    }

    // Escape to unfocus input
    if (key.escape && state.inputFocused) {
      setState((prev) => ({ ...prev, inputFocused: false }));
      return;
    }

    // Focus input with: 'i', '/', or Enter (when not already focused)
    if (!state.inputFocused) {
      if (input === 'i' || input === '/' || key.return) {
        setState((prev) => ({ ...prev, inputFocused: true }));
        return;
      }
    }
  });

  // Initialize application
  useEffect(() => {
    const initialize = async () => {
      try {
        addLog('System', 'Enspira application starting...', 'info');

        // Import and start the API server
        const { initializeApp: startApp } = await import('./index.js');

        addLog('System', 'Starting REST server and initializing services...');
        const { status } = await startApp();

        // Process preflight status
        let failed = 0;
        let available = 0;
        Object.values(status.llmStatuses).forEach((isUp) => {
          if (isUp === true) {
            available += 1;
          } else {
            failed += 1;
          }
        });

        // Determine LLM status
        let llmStatus: 'up' | 'degraded' | 'down';
        if (failed === available + failed && failed > 0) {
          llmStatus = 'down';
          addLog(
            'System',
            'Pre-flight checks failed for all LLM services.',
            'error'
          );
        } else if (failed > 0) {
          llmStatus = 'degraded';
          addLog(
            'System',
            'Some pre-flight checks failed for LLM services.',
            'warn'
          );
        } else {
          llmStatus = 'up';
          addLog('System', 'All pre-flight checks for LLM services passed.', 'info');
        }

        updateStatus({
          rest: status.restIsOnline,
          db: status.dbIsOnline,
          llm: llmStatus,
          tts: status.llmStatuses.allTalkIsOnline,
        });

        // Register Twitch EventSub
        try {
          addLog('System', 'Importing Twitch EventSub manager...');
          const { registerAllUsersEventSub } = await import(
            './integrations/twitch/eventsub.js'
          );

          addLog('System', 'Registering Twitch EventSub subscriptions...');
          const eventSubResults = await registerAllUsersEventSub();
          addLog(
            'Twitch',
            `EventSub registration complete: ${eventSubResults.success} successful, ${eventSubResults.failures} failed`,
            eventSubResults.failures > 0 ? 'warn' : 'info'
          );
        } catch (eventSubError) {
          const err = eventSubError as Error;
          addLog('Twitch', `Error with Twitch EventSub: ${err.message}`, 'error');
        }

        addLog('System', 'Enspira is fully initialized and ready!', 'info');
        setState((prev) => ({ ...prev, isInitialized: true }));
      } catch (error) {
        const err = error as Error;
        addLog('System', `Failed to initialize application: ${err.message}`, 'error');
        updateStatus({
          rest: false,
          db: false,
          llm: 'down',
          tts: false,
        });
      }
    };

    initialize();
  }, [addLog, updateStatus]);

  // Handle process signals
  useEffect(() => {
    const handleSignal = () => {
      shutdown();
    };

    process.on('SIGTERM', handleSignal);
    process.on('SIGINT', handleSignal);

    return () => {
      process.off('SIGTERM', handleSignal);
      process.off('SIGINT', handleSignal);
    };
  }, [shutdown]);

  // Handle terminal resize - clear and force redraw
  useEffect(() => {
    const handleResize = () => {
      // Clear screen and move cursor to home
      process.stdout.write('\x1b[2J\x1b[H');
      // Force state update to trigger re-render
      setState((prev) => ({ ...prev }));
    };

    process.stdout.on('resize', handleResize);

    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, []);

  // Calculate layout dimensions - use fixed heights to prevent layout shifts
  const terminalHeight = stdout?.rows || 24;
  const statusHeight = 3;
  const tabBarHeight = 1;
  const footerHeight = 4; // Fixed footer: input (3) + status line (1)
  const autocompleteHeight = state.autocomplete.visible
    ? Math.min(state.autocomplete.suggestions.length + 4, 9)
    : 0;
  const logHeight = Math.max(
    5,
    terminalHeight - statusHeight - tabBarHeight - footerHeight - autocompleteHeight
  );

  // Get log counts for tabs
  const logCounts = useMemo(() => getLogCounts(state.logs), [state.logs]);

  return (
    <Box flexDirection="column" height={terminalHeight}>
      {/* Status Bar */}
      <Box height={statusHeight}>
        <StatusBar status={state.status} />
      </Box>

      {/* Tab Bar */}
      <Box height={tabBarHeight}>
        <TabBar
          activeTab={state.activeTab}
          onTabChange={(tab) => setState((prev) => ({ ...prev, activeTab: tab }))}
          counts={logCounts}
        />
      </Box>

      {/* Log Box */}
      <Box height={logHeight} flexGrow={1}>
        <LogBox logs={state.logs} activeTab={state.activeTab} />
      </Box>

      {/* Autocomplete Box */}
      {state.autocomplete.visible && (
        <Box height={autocompleteHeight}>
          <AutocompleteBox
            suggestions={state.autocomplete.suggestions}
            selectedIndex={state.autocomplete.selectedIndex}
            visible={state.autocomplete.visible}
          />
        </Box>
      )}

      {/* Fixed footer area */}
      <Box height={footerHeight} flexDirection="column">
        {/* Command Input */}
        <Box height={3}>
          <CommandInput
            externalValue={state.completedValue}
            onChange={updateInput}
            onSubmit={handleCommand}
            disabled={state.isShuttingDown}
            isFocused={state.inputFocused}
          />
        </Box>

        {/* Status line - shows spinner or ready state */}
        <Box height={1} paddingX={1}>
          {!state.isInitialized ? (
            <Spinner label="Initializing services..." />
          ) : (
            <Text color="gray" dimColor>
              Ready • Ctrl+C to exit
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}

// ==================== TERMINAL HELPERS ====================

function enterAlternateScreen(): void {
  process.stdout.write('\x1b[?1049h'); // Enter alternate screen
  process.stdout.write('\x1b[?25h');   // Ensure cursor visible
}

function exitAlternateScreen(): void {
  process.stdout.write('\x1b[?1049l'); // Exit alternate screen
  process.stdout.write('\x1b[?25h');   // Show cursor
}

// ==================== ENTRY POINT ====================

// Enter alternate screen for clean TUI
enterAlternateScreen();

// Ensure we exit alternate screen on any termination
process.on('exit', exitAlternateScreen);
process.on('uncaughtException', (err) => {
  exitAlternateScreen();
  console.error('Uncaught exception:', err);
  process.exit(1);
});

const instance = render(<App />, {
  exitOnCtrlC: false, // We handle this ourselves
  patchConsole: false, // We override console ourselves
});

instance.waitUntilExit().then(() => {
  exitAlternateScreen();
});
