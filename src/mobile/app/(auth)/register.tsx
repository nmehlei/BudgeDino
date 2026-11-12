import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Device from 'expo-device';
import { useEffect, useState } from 'react';
import { Button, HelperText, Text, TextInput } from 'react-native-paper';

import { createAuthApi } from '../../src/auth/api';
import { AuthScreen } from '../../src/auth/AuthScreen';
import { allowCleartext } from '../../src/auth/config';
import { registerErrorMessage } from '../../src/auth/messages';
import { pendingRegistration } from '../../src/auth/pending-registration';
import { passwordHint, validateServerUrl } from '../../src/auth/validation';
import { useSession } from '../../src/session/useSession';

const firstParam = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** "budget.example.com" from a normalized server URL. */
const hostOf = (url: string) => url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');

export default function RegisterScreen() {
  const router = useRouter();
  const session = useSession();
  const params = useLocalSearchParams<{ server?: string | string[]; invite?: string | string[] }>();
  const linkServer = firstParam(params.server);
  const [inviteToken, setInviteToken] = useState(firstParam(params.invite) ?? '');
  // Set only when opened through a join link whose server passed validation.
  const [joinHost, setJoinHost] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [deviceName, setDeviceName] = useState(
    session.deviceName ?? Device.modelName ?? 'Android device',
  );
  const [busy, setBusy] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // A join link (D5) names the server. Validate it like the server screen does, store it, and show the host
  // prominently so a link pointing at a foreign host is visible before a password is typed.
  const { setServerUrl } = session;
  useEffect(() => {
    if (!linkServer) return;
    const parsed = validateServerUrl(linkServer, allowCleartext());
    if (parsed.ok) {
      setServerUrl(parsed.url);
      setJoinHost(hostOf(parsed.url));
      setError(null);
    } else {
      setJoinHost(null);
      setError(parsed.message);
    }
  }, [linkServer, setServerUrl]);

  const hint = passwordHint(password);
  const ready =
    inviteToken.trim() !== '' &&
    email.trim() !== '' &&
    displayName.trim() !== '' &&
    deviceName.trim() !== '' &&
    hint.level !== 'short';

  async function submit() {
    if (!session.serverUrl) {
      router.replace('/(auth)/server');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await createAuthApi(session.serverUrl).register({
        inviteToken: inviteToken.trim(),
        email: email.trim(),
        displayName: displayName.trim(),
        password,
        deviceName: deviceName.trim(),
      });
      session.setDeviceName(deviceName.trim());
      pendingRegistration.set(res);
      setPassword('');
      router.push('/(auth)/register-totp');
    } catch (e) {
      setError(registerErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScreen>
      <Text variant="headlineMedium">Join with an invite</Text>
      {joinHost ? (
        <Text variant="titleMedium" testID="join-host">
          {`Joining a household on ${joinHost}`}
        </Text>
      ) : null}
      <TextInput
        testID="invite-token"
        mode="outlined"
        label="Invite token"
        value={inviteToken}
        onChangeText={setInviteToken}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        testID="email"
        mode="outlined"
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        autoComplete="email"
      />
      <TextInput
        testID="display-name"
        mode="outlined"
        label="Display name"
        value={displayName}
        onChangeText={setDisplayName}
        autoComplete="name"
      />
      <TextInput
        testID="password"
        mode="outlined"
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="new-password"
      />
      <HelperText type={hint.level === 'short' ? 'error' : 'info'} visible testID="password-hint">
        {hint.text}
      </HelperText>
      <TextInput
        testID="device-name"
        mode="outlined"
        label="Device name"
        value={deviceName}
        onChangeText={setDeviceName}
      />
      {error ? (
        <HelperText type="error" visible>
          {error}
        </HelperText>
      ) : null}
      <Button
        mode="contained"
        onPress={() => void submit()}
        loading={busy}
        disabled={!ready || busy}
      >
        Continue
      </Button>
    </AuthScreen>
  );
}
