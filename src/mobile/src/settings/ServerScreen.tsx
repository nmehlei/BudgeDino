import { List } from 'react-native-paper';

import { openExternal, SELF_HOSTING_URL } from '../links';
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
      <List.Item
        title="Self-hosting docs"
        description="Run, update and back up your BudgeDino server"
        descriptionNumberOfLines={0}
        left={(p) => <List.Icon {...p} icon="book-open-outline" />}
        right={(p) => <List.Icon {...p} icon="open-in-new" />}
        onPress={() => openExternal(SELF_HOSTING_URL)}
        testID="settings-server-docs"
      />
    </SettingsPage>
  );
}
