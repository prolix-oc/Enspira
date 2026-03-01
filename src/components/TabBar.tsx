/**
 * TabBar component - displays tab buttons for log filtering
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { TabType } from './LogBox.js';

// ==================== TYPES ====================

interface TabBarProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  counts: Record<TabType, number>;
}

interface TabButtonProps {
  label: string;
  shortcut: string;
  count: number;
  isActive: boolean;
  onClick: () => void;
}

// ==================== TAB BUTTON COMPONENT ====================

function TabButton({
  label,
  shortcut,
  count,
  isActive,
}: TabButtonProps): React.ReactElement {
  return (
    <Box>
      <Text
        color={isActive ? 'cyan' : 'gray'}
        bold={isActive}
        inverse={isActive}
      >
        {' '}
        {shortcut}:{label} ({count}){' '}
      </Text>
    </Box>
  );
}

// ==================== COMPONENT ====================

export function TabBar({
  activeTab,
  onTabChange,
  counts,
}: TabBarProps): React.ReactElement {
  return (
    <Box paddingX={1} gap={1}>
      <TabButton
        label="All"
        shortcut="1"
        count={counts.all}
        isActive={activeTab === 'all'}
        onClick={() => onTabChange('all')}
      />
      <TabButton
        label="System"
        shortcut="2"
        count={counts.system}
        isActive={activeTab === 'system'}
        onClick={() => onTabChange('system')}
      />
      <TabButton
        label="Events"
        shortcut="3"
        count={counts.events}
        isActive={activeTab === 'events'}
        onClick={() => onTabChange('events')}
      />
      <Box flexGrow={1} />
      <Text color="gray" dimColor>
        1/2/3 to switch (when empty)
      </Text>
    </Box>
  );
}
