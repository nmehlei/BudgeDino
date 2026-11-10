import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { ScreenHeader } from '../transactions/ScreenHeader';
import { useAppTheme } from '../theme';

/** Frame of every settings sub-screen: themed background, back header, scrolling content. */
export function SettingsPage({
  title,
  children,
  overlay,
}: {
  title: string;
  children: ReactNode;
  overlay?: ReactNode;
}) {
  const theme = useAppTheme();
  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <ScreenHeader title={title} />
      <ScrollView contentContainerStyle={styles.content}>{children}</ScrollView>
      {overlay}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingBottom: 48 },
});
