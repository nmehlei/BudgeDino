import { useRouter } from 'expo-router';
import { Appbar } from 'react-native-paper';

/** Top bar with a back action for the stacked screens inside the tabs. */
export function ScreenHeader({ title }: { title: string }) {
  const router = useRouter();
  return (
    <Appbar.Header>
      <Appbar.BackAction onPress={() => router.back()} accessibilityLabel="Back" />
      <Appbar.Content title={title} />
    </Appbar.Header>
  );
}
