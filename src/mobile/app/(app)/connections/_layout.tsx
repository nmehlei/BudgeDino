import { Stack } from 'expo-router';

import { useAppTheme } from '../../../src/theme';

export default function ConnectionsLayout() {
  const theme = useAppTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    />
  );
}
