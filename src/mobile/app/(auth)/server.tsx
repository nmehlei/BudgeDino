import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Button, HelperText, Text, TextInput } from 'react-native-paper';

import { createAuthApi } from '../../src/auth/api';
import { AuthScreen } from '../../src/auth/AuthScreen';
import { allowCleartext } from '../../src/auth/config';
import { healthErrorMessage } from '../../src/auth/messages';
import { validateServerUrl } from '../../src/auth/validation';
import { openExternal, SELF_HOSTING_URL } from '../../src/links';
import { useSession } from '../../src/session/useSession';

export default function ServerScreen() {
  const router = useRouter();
  const session = useSession();
  const [url, setUrl] = useState(session.serverUrl ?? '');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [connected, setConnected] = useState<string | null>(null);

  async function check() {
    setError(null);
    setConnected(null);
    const parsed = validateServerUrl(url, allowCleartext());
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setChecking(true);
    try {
      const health = await createAuthApi(parsed.url).health();
      session.setServerUrl(parsed.url);
      setUrl(parsed.url);
      setConnected(health.version);
    } catch (e) {
      setError(healthErrorMessage(e));
    } finally {
      setChecking(false);
    }
  }

  return (
    <AuthScreen>
      <Text variant="headlineMedium">Connect to your server</Text>
      <Text variant="bodyMedium">
        Enter the address of your BudgeDino server. Your data stays on that server.
      </Text>
      <TextInput
        testID="server-url"
        mode="outlined"
        label="Server address"
        placeholder="https://budget.example.com"
        value={url}
        onChangeText={(t) => {
          setUrl(t);
          setConnected(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        error={error !== null}
      />
      {error ? (
        <HelperText type="error" visible>
          {error}
        </HelperText>
      ) : null}
      <Button mode="contained" onPress={() => void check()} loading={checking} disabled={checking}>
        Check
      </Button>
      {connected === null ? (
        <Button
          mode="text"
          icon="open-in-new"
          onPress={() => openExternal(SELF_HOSTING_URL)}
          testID="server-self-hosting"
        >
          No server yet? Host your own
        </Button>
      ) : null}
      {connected !== null ? (
        <>
          <Text variant="bodyMedium">{`Connected (server ${connected}).`}</Text>
          <Button
            mode="contained"
            onPress={() => {
              router.push('/(auth)/login');
            }}
          >
            Sign in
          </Button>
          <Button
            mode="outlined"
            onPress={() => {
              router.push('/(auth)/register');
            }}
          >
            I have an invite
          </Button>
        </>
      ) : null}
    </AuthScreen>
  );
}
