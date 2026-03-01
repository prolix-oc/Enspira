/**
 * LogEntry component - displays a single log entry
 * Uses simple ASCII characters to avoid terminal width issues with emojis
 */

import React from 'react';
import { Text } from 'ink';

// ==================== TYPES ====================

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';
export type LogSource = 'system' | 'event';

export interface LogEntryData {
  id: number;
  timestamp: Date;
  category: string;
  message: string;
  level: LogLevel;
  source: LogSource;
}

interface LogEntryProps {
  entry: LogEntryData;
}

// ==================== CONSTANTS ====================

// Use ASCII symbols instead of emojis to avoid width issues
const LEVEL_PREFIXES: Record<LogLevel, string> = {
  log: ' ',
  info: '*',
  warn: '!',
  error: 'X',
  debug: '~',
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  log: 'white',
  info: 'cyan',
  warn: 'yellow',
  error: 'red',
  debug: 'gray',
};

// ==================== COMPONENT ====================

interface LogEntryPropsWithWidth extends LogEntryProps {
  maxWidth?: number;
}

export function LogEntry({ entry, maxWidth }: LogEntryPropsWithWidth): React.ReactElement {
  const timestamp = entry.timestamp.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const levelPrefix = LEVEL_PREFIXES[entry.level];
  const levelColor = LEVEL_COLORS[entry.level];

  // Pad category for alignment (max 10 chars)
  const paddedCategory = entry.category.slice(0, 10).padEnd(10);

  // Build prefix: "HH:MM:SS | Category   | X "
  // Length: 8 + 3 + 10 + 3 + 2 = 26
  const prefix = `${timestamp} | ${paddedCategory} | ${levelPrefix} `;
  const prefixLength = 26;

  // Calculate available width for message
  const availableWidth = maxWidth ? maxWidth - prefixLength : 50;

  // Truncate and pad message to exact width
  let displayMessage = entry.message;
  if (displayMessage.length > availableWidth) {
    displayMessage = displayMessage.slice(0, availableWidth - 1) + '~';
  }
  // Pad to exact width to prevent layout shifts
  displayMessage = displayMessage.padEnd(availableWidth);

  return (
    <Text>
      <Text color="gray">{timestamp}</Text>
      <Text color="gray"> | </Text>
      <Text>{paddedCategory}</Text>
      <Text color="gray"> | </Text>
      <Text color={levelColor}>{levelPrefix} {displayMessage}</Text>
    </Text>
  );
}

/**
 * Determine log source based on category
 */
export function getLogSource(category: string): LogSource {
  const eventCategories = ['Twitch', 'EventSub', 'Follow', 'Sub', 'Raid', 'Bits', 'HypeTrain'];
  const lowerCategory = category.toLowerCase();

  for (const eventCat of eventCategories) {
    if (lowerCategory.includes(eventCat.toLowerCase())) {
      return 'event';
    }
  }

  return 'system';
}
