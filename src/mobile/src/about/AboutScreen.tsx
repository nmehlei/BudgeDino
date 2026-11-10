import { useQuery } from '@tanstack/react-query';
import { Image, StyleSheet, View } from 'react-native';
import { Divider, List, Text } from 'react-native-paper';

import { createAuthApi } from '../auth/api';
import {
  commitUrl,
  ISSUES_URL,
  LICENSE_URL,
  openExternal,
  REPO_URL,
  SELF_HOSTING_URL,
} from '../links';
import { useSession } from '../session/useSession';
import { SettingsPage } from '../settings/SettingsPage';
import { useAppTheme } from '../theme';
import { getBuildInfo, type BuildInfo } from './build-info';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- static asset for Metro
const LOGO = require('../../assets/splash-icon.png') as number;

function useServerVersion(serverUrl: string | null) {
  return useQuery({
    queryKey: ['about', 'server-version', serverUrl],
    queryFn: async () => (await createAuthApi(serverUrl ?? '').health()).version,
    enabled: serverUrl !== null,
    staleTime: 5 * 60_000,
  });
}

/** App version, server version and the open-source links (More → About). */
export function AboutScreen({ build = getBuildInfo() }: { build?: BuildInfo }) {
  const theme = useAppTheme();
  const { serverUrl } = useSession();
  const server = useServerVersion(serverUrl);
  const commitLink = commitUrl(build.commit);

  let serverVersion = 'Not connected';
  if (serverUrl !== null) {
    if (server.data) serverVersion = server.data;
    else if (server.isError) serverVersion = 'Unreachable';
    else serverVersion = 'Checking…';
  }

  return (
    <SettingsPage title="About">
      <View style={styles.hero}>
        <View style={[styles.logoWrap, { backgroundColor: theme.colors.primary }]}>
          <Image source={LOGO} style={styles.logo} accessibilityIgnoresInvertColors />
        </View>
        <Text variant="headlineSmall">BudgeDino</Text>
        <Text
          variant="bodyMedium"
          style={[styles.tagline, { color: theme.colors.onSurfaceVariant }]}
        >
          Your household budget, on your own server.
        </Text>
      </View>

      <List.Subheader>Version</List.Subheader>
      <List.Item
        title="App version"
        description={build.version}
        descriptionNumberOfLines={0}
        left={(p) => <List.Icon {...p} icon="cellphone" />}
        testID="about-version"
      />
      {build.versionCode !== null ? (
        <List.Item
          title="Build"
          description={String(build.versionCode)}
          left={(p) => <List.Icon {...p} icon="counter" />}
          testID="about-build"
        />
      ) : null}
      {build.commit !== null ? (
        <List.Item
          title="Commit"
          description={build.commit}
          left={(p) => <List.Icon {...p} icon="source-commit" />}
          right={commitLink ? (p) => <List.Icon {...p} icon="open-in-new" /> : undefined}
          onPress={commitLink ? () => openExternal(commitLink) : undefined}
          testID="about-commit"
        />
      ) : null}
      <List.Item
        title="Server version"
        description={serverVersion}
        descriptionNumberOfLines={0}
        left={(p) => <List.Icon {...p} icon="server-outline" />}
        testID="about-server-version"
      />

      <Divider style={styles.divider} />
      <List.Subheader>Open source</List.Subheader>
      <List.Item
        title="Source code"
        description="github.com/nmehlei/BudgeDino"
        descriptionNumberOfLines={0}
        left={(p) => <List.Icon {...p} icon="github" />}
        right={(p) => <List.Icon {...p} icon="open-in-new" />}
        onPress={() => openExternal(REPO_URL)}
        testID="about-source"
      />
      <List.Item
        title="Report a problem or suggest an idea"
        titleNumberOfLines={0}
        description="GitHub issues"
        left={(p) => <List.Icon {...p} icon="bug-outline" />}
        right={(p) => <List.Icon {...p} icon="open-in-new" />}
        onPress={() => openExternal(ISSUES_URL)}
        testID="about-issues"
      />
      <List.Item
        title="Host your own server"
        description="Setup and self-hosting docs"
        descriptionNumberOfLines={0}
        left={(p) => <List.Icon {...p} icon="home-group" />}
        right={(p) => <List.Icon {...p} icon="open-in-new" />}
        onPress={() => openExternal(SELF_HOSTING_URL)}
        testID="about-self-hosting"
      />
      <List.Item
        title="License"
        description="GNU Affero General Public License v3.0"
        descriptionNumberOfLines={0}
        left={(p) => <List.Icon {...p} icon="scale-balance" />}
        right={(p) => <List.Icon {...p} icon="open-in-new" />}
        onPress={() => openExternal(LICENSE_URL)}
        testID="about-license"
      />
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingVertical: 24, paddingHorizontal: 16, gap: 4 },
  logoWrap: {
    width: 112,
    height: 112,
    borderRadius: 56,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    overflow: 'hidden',
  },
  logo: { width: 140, height: 140 },
  tagline: { textAlign: 'center' },
  divider: { marginTop: 8 },
});
