/**
 * CommandInput component - text input with prompt symbol
 * Uses uncontrolled TextInput with onChange tracking for autocomplete
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { TextInput } from '@inkjs/ui';

// ==================== TYPES ====================

interface CommandInputProps {
  onSubmit: (command: string) => void;
  onChange: (value: string) => void;
  externalValue?: string; // Value set externally (e.g., from autocomplete)
  disabled?: boolean;
  isFocused?: boolean;
}

// ==================== COMPONENT ====================

export function CommandInput({
  onSubmit,
  onChange,
  externalValue,
  disabled = false,
  isFocused = true,
}: CommandInputProps): React.ReactElement {
  // Key to force re-render and reset input
  const [inputKey, setInputKey] = useState(0);

  // When externalValue changes, force re-render with new default
  useEffect(() => {
    if (externalValue !== undefined) {
      setInputKey((prev) => prev + 1);
    }
  }, [externalValue]);

  const handleSubmit = (submittedValue: string) => {
    if (submittedValue.trim()) {
      onSubmit(submittedValue.trim());
      setInputKey((prev) => prev + 1); // Clear input after submit
    }
  };

  // Show hint based on focus state
  const placeholder = isFocused
    ? 'Type a command... (Esc to cancel)'
    : 'Press Enter, /, or i to type a command';

  return (
    <Box
      borderStyle="round"
      borderColor={isFocused ? 'magenta' : 'gray'}
      paddingX={1}
      width="100%"
    >
      <Text color={isFocused ? 'magenta' : 'gray'} bold={isFocused}>
        ❯{' '}
      </Text>
      <TextInput
        key={inputKey}
        defaultValue={externalValue || ''}
        onChange={onChange}
        onSubmit={handleSubmit}
        placeholder={placeholder}
        isDisabled={disabled || !isFocused}
      />
    </Box>
  );
}
