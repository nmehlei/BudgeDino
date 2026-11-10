import { useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { List, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '../../../src/theme';

export default function Settings() {
  const theme = useAppTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 16 }}>
        <Text variant="headlineSmall" style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          Settings
        </Text>
        <List.Item
          title="Accounts"
          description="Privacy and budget settings of your accounts"
          descriptionNumberOfLines={0}
          left={(p) => <List.Icon {...p} icon="bank-outline" />}
          right={(p) => <List.Icon {...p} icon="chevron-right" />}
          onPress={() => router.push('/settings/accounts')}
          testID="settings-accounts"
        />
      </ScrollView>
    </View>
  );
}
