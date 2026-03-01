/**
 * LogBox component - displays log entries in a bounded area
 */

import React, { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import { LogEntry, LogEntryData, LogSource } from './LogEntry.js';

// ==================== TYPES ====================

export type TabType = 'all' | 'system' | 'events';

interface LogBoxProps {
  logs: LogEntryData[];
  activeTab: TabType;
  maxVisible?: number;
}

// ==================== COMPONENT ====================

export function LogBox({
  logs,
  activeTab,
  maxVisible = 50,
}: LogBoxProps): React.ReactElement {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || 80;
  // Account for border (2) and padding (2)
  const contentWidth = terminalWidth - 4;

  // Filter and slice logs based on active tab
  const visibleLogs = useMemo(() => {
    let filtered = logs;

    if (activeTab === 'system') {
      filtered = logs.filter((log) => log.source === 'system');
    } else if (activeTab === 'events') {
      filtered = logs.filter((log) => log.source === 'event');
    }

    // Take the most recent logs
    return filtered.slice(-maxVisible);
  }, [logs, activeTab, maxVisible]);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="cyan"
      paddingX={1}
      width={terminalWidth}
      height="100%"
    >
      {visibleLogs.length === 0 ? (
        <Text color="gray" dimColor>
          No logs to display
        </Text>
      ) : (
        visibleLogs.map((entry) => (
          <LogEntry key={entry.id} entry={entry} maxWidth={contentWidth} />
        ))
      )}
    </Box>
  );
}

/**
 * Get log counts for each tab
 */
export function getLogCounts(logs: LogEntryData[]): Record<TabType, number> {
  const systemCount = logs.filter((log) => log.source === 'system').length;
  const eventCount = logs.filter((log) => log.source === 'event').length;

  return {
    all: logs.length,
    system: systemCount,
    events: eventCount,
  };
}
