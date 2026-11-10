import { List } from 'react-native-paper';

import { useSession } from '../session/useSession';
import { SettingsPage } from './SettingsPage';

/** The server this app is connected to. */
export function ServerScreen() {
  const { serverUrl } = useSession();
  return (
    <SettingsPage title="Server">
      <List.Item
        title="Server"
        description={serverUrl ?? 'Not set'}
        descriptionNumberOfLines={0}
        left={(p) => <List.Icon {...p} icon="server-outline" />}
        testID="settings-server"
      />
    </SettingsPage>
  );
}
