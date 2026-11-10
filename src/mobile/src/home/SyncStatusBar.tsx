import type { ConnectorInfo } from '@budgedino/shared';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { formatRelative } from '../format/time';
import { useAppTheme } from '../theme';

const STATUS_LABEL: Record<ConnectorInfo['status'], string> = {
  ok: 'OK',
  needs_attention: 'Needs attention',
  error: 'Error',
  disabled: 'Disabled',
};

interface Props {
  connectors: ConnectorInfo[];
  onNeedsAttention: () => void;
  now?: number;
}

/** One chip per connector with its status and last successful sync. Needs-attention chips open Connections. */
export function SyncStatusBar({ connectors, onNeedsAttention, now }: Props) {
  const theme = useAppTheme();
  if (connectors.length === 0) return null;
  return (
    <View style={styles.container} testID="sync-status">
      {connectors.map((c) => {
        const last = c.lastSuccessAt ? formatRelative(c.lastSuccessAt, now) : 'never synced';
        // Only the owner can fix a connector, so only their chip navigates.
        const actionable = c.status === 'needs_attention' && c.isOwner;
        const bad = c.status === 'needs_attention' || c.status === 'error';
        const fg = bad ? theme.colors.onErrorContainer : theme.colors.onSecondaryContainer;
        return (
          <View key={c.id} style={styles.item}>
            <Pressable
              testID={`connector-chip-${c.id}`}
              disabled={!actionable}
              onPress={onNeedsAttention}
              accessibilityRole={actionable ? 'button' : 'text'}
              accessibilityLabel={`${c.type}: ${STATUS_LABEL[c.status]}, ${last}`}
              style={[
                styles.chip,
                {
                  backgroundColor: bad
                    ? theme.colors.errorContainer
                    : theme.colors.secondaryContainer,
                },
              ]}
            >
              <Icon
                source={
                  bad
                    ? 'alert-circle-outline'
                    : c.status === 'ok'
                      ? 'check-circle-outline'
                      : 'minus-circle-outline'
                }
                size={18}
                color={fg}
              />
              {/* No numberOfLines: at large font scales the label wraps instead of truncating. */}
              <Text variant="labelLarge" style={[styles.chipText, { color: fg }]}>
                {`${c.type}: ${STATUS_LABEL[c.status]}`}
              </Text>
            </Pressable>
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {last}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  item: { gap: 2, maxWidth: '100%' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    alignSelf: 'flex-start',
  },
  chipText: { flexShrink: 1 },
});
