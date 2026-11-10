import { VERSION } from '@budgedino/shared';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

import { useAppTheme } from '../src/theme';

export default function Home() {
  const theme = useAppTheme();
  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="displaySmall">BudgeDino</Text>
      <Text variant="bodySmall">shared v{VERSION}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
