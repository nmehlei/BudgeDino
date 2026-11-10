import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { List, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '../theme';

/** The last tab: a plain list of everything that is not a main tab. Add future entries here. */
export function MoreScreen() {
  const theme = useAppTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: 48 }}>
        <Text variant="headlineSmall" style={styles.title}>
          More
        </Text>
        <List.Item
          title="Net worth"
          description="Balances of all your accounts"
          descriptionNumberOfLines={0}
          left={(p) => <List.Icon {...p} icon="chart-line" />}
          right={(p) => <List.Icon {...p} icon="chevron-right" />}
          onPress={() => router.push('/more/net-worth')}
          testID="more-net-worth"
        />
        <List.Item
          title="Settings"
          description="Appearance, security, devices, accounts, server"
          descriptionNumberOfLines={0}
          left={(p) => <List.Icon {...p} icon="cog-outline" />}
          right={(p) => <List.Icon {...p} icon="chevron-right" />}
          onPress={() => router.push('/more/settings')}
          testID="more-settings"
        />
        <List.Item
          title="About"
          description="Version, source code, license"
          descriptionNumberOfLines={0}
          left={(p) => <List.Icon {...p} icon="information-outline" />}
          right={(p) => <List.Icon {...p} icon="chevron-right" />}
          onPress={() => router.push('/more/about')}
          testID="more-about"
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  title: { paddingHorizontal: 16, paddingBottom: 8 },
});
