/**
 * AutocompleteBox component - displays command suggestions
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { CommandDef } from '../utils/commands.js';

// ==================== TYPES ====================

interface AutocompleteBoxProps {
  suggestions: CommandDef[];
  selectedIndex: number;
  visible: boolean;
  maxVisible?: number;
}

// ==================== COMPONENT ====================

export function AutocompleteBox({
  suggestions,
  selectedIndex,
  visible,
  maxVisible = 5,
}: AutocompleteBoxProps): React.ReactElement | null {
  if (!visible || suggestions.length === 0) {
    return null;
  }

  // Calculate visible window for scrolling
  const totalItems = suggestions.length;
  const halfWindow = Math.floor(maxVisible / 2);

  let startIndex = 0;
  if (totalItems > maxVisible) {
    startIndex = Math.max(0, selectedIndex - halfWindow);
    startIndex = Math.min(startIndex, totalItems - maxVisible);
  }

  const endIndex = Math.min(startIndex + maxVisible, totalItems);
  const visibleSuggestions = suggestions.slice(startIndex, endIndex);

  const showScrollUp = startIndex > 0;
  const showScrollDown = endIndex < totalItems;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginBottom={0}
    >
      {/* Header */}
      <Box marginBottom={0}>
        <Text color="cyan" bold>
          Suggestions
        </Text>
        <Text color="gray"> ({totalItems} matches)</Text>
      </Box>

      {/* Scroll up indicator */}
      {showScrollUp && (
        <Text color="gray" dimColor>
          ▲ more above
        </Text>
      )}

      {/* Suggestions list */}
      {visibleSuggestions.map((cmd, index) => {
        const actualIndex = startIndex + index;
        const isSelected = actualIndex === selectedIndex;

        return (
          <Box key={cmd.name} gap={1}>
            <Text color={isSelected ? 'cyan' : 'gray'}>
              {isSelected ? '▸' : ' '}
            </Text>
            <Text
              color={isSelected ? 'cyan' : 'white'}
              bold={isSelected}
              inverse={isSelected}
            >
              {' '}{cmd.name}{' '}
            </Text>
            {cmd.args && (
              <Text color="gray" dimColor>
                {cmd.args}
              </Text>
            )}
            <Text color="gray"> - </Text>
            <Text color={isSelected ? 'white' : 'gray'} dimColor={!isSelected}>
              {cmd.description}
            </Text>
          </Box>
        );
      })}

      {/* Scroll down indicator */}
      {showScrollDown && (
        <Text color="gray" dimColor>
          ▼ more below
        </Text>
      )}

      {/* Help text */}
      <Box marginTop={0}>
        <Text color="gray" dimColor>
          ↑↓ navigate • Tab accept • Esc dismiss
        </Text>
      </Box>
    </Box>
  );
}
