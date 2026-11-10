import * as Device from 'expo-device';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Button, HelperText, Text, TextInput } from 'react-native-paper';

import { createAuthApi } from '../../src/auth/api';
import { AuthScreen } from '../../src/auth/AuthScreen';
import { loginErrorMessage, SESSION_EXPIRED_MESSAGE } from '../../src/auth/messages';
import { TotpField } from '../../src/auth/TotpField';
import { isCompleteTotp } from '../../src/auth/validation';
import { useSession } from '../../src/session/useSession';

export default function LoginScreen() {
  const router = useRouter();
  const session = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = email.trim() !== '' && password !== '' && isCompleteTotp(code);

  async function submit() {
    if (!session.serverUrl) {
      router.replace('/(auth)/server');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await createAuthApi(session.serverUrl).login({
        email: email.trim(),
        password,
        totpCode: code,
        deviceName: session.deviceName ?? Device.modelName ?? 'Android device',
      });
      await session.signIn(res.sessionToken);
      setPassword('');
      router.replace('/');
    } catch (e) {
      setError(loginErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScreen>
      <Text variant="headlineMedium">Sign in</Text>
      {session.expired ? (
        <Text variant="bodyMedium" testID="expired-message">
          {SESSION_EXPIRED_MESSAGE}
        </Text>
      ) : null}
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
        testID="password"
        mode="outlined"
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="current-password"
      />
      <TotpField value={code} onChange={setCode} />
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
        Sign in
      </Button>
      <Button
        mode="text"
        onPress={() => {
          router.push('/(auth)/server');
        }}
      >
        Change server
      </Button>
    </AuthScreen>
  );
}
