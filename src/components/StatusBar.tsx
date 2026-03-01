/**
 * StatusBar component - displays service health status
 */

import React from 'react';
import { Box, Text } from 'ink';

// ==================== TYPES ====================

export interface ServiceStatus {
  rest: boolean | null;
  db: boolean | null;
  llm: 'up' | 'degraded' | 'down' | null;
  tts: boolean | null;
}

interface StatusBarProps {
  status: ServiceStatus;
}

// ==================== COMPONENT ====================

export function StatusBar({ status }: StatusBarProps): React.ReactElement {
  const getStatusIndicator = (
    label: string,
    value: boolean | null
  ): React.ReactElement => {
    if (value === null) {
      return (
        <Box gap={1}>
          <Text color="gray">◯</Text>
          <Text color="gray">{label}</Text>
        </Box>
      );
    }
    return (
      <Box gap={1}>
        <Text color={value ? 'green' : 'red'}>{value ? '◉' : '◯'}</Text>
        <Text color={value ? 'white' : 'red'}>{label}</Text>
      </Box>
    );
  };

  const getLLMIndicator = (): React.ReactElement => {
    if (status.llm === null) {
      return (
        <Box gap={1}>
          <Text color="gray">◯</Text>
          <Text color="gray">LLM</Text>
        </Box>
      );
    }

    const indicators = {
      up: { symbol: '◉', color: 'green' as const, text: 'LLM' },
      degraded: { symbol: '◎', color: 'yellow' as const, text: 'LLM (Degraded)' },
      down: { symbol: '◯', color: 'red' as const, text: 'LLM' },
    };

    const { symbol, color, text } = indicators[status.llm];

    return (
      <Box gap={1}>
        <Text color={color}>{symbol}</Text>
        <Text color={color === 'green' ? 'white' : color}>{text}</Text>
      </Box>
    );
  };

  const getOverallStatus = (): { label: string; color: string } => {
    if (
      status.rest === null ||
      status.db === null ||
      status.llm === null
    ) {
      return { label: 'Initializing...', color: 'gray' };
    }

    if (!status.rest || !status.db || status.llm === 'down') {
      return { label: 'Offline', color: 'red' };
    }

    if (status.llm === 'degraded') {
      return { label: 'Degraded', color: 'yellow' };
    }

    return { label: 'All Online', color: 'green' };
  };

  const overall = getOverallStatus();

  return (
    <Box
      borderStyle="round"
      borderColor="green"
      paddingX={1}
      width="100%"
      justifyContent="space-between"
    >
      <Box gap={1}>
        <Text bold color="cyan">Enspira</Text>
        <Text color="gray">│</Text>
        <Text color={overall.color}>{overall.label}</Text>
      </Box>
      <Box gap={3}>
        {getStatusIndicator('REST', status.rest)}
        {getStatusIndicator('DB', status.db)}
        {getLLMIndicator()}
        {getStatusIndicator('TTS', status.tts)}
        <Text color="gray">│</Text>
        <Text color="gray">v2.0.0</Text>
      </Box>
    </Box>
  );
}
