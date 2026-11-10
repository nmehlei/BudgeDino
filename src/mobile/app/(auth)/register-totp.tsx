import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { Button, HelperText, Text } from 'react-native-paper';
import QRCode from 'react-native-qrcode-svg';

import { createAuthApi } from '../../src/auth/api';
import { AuthScreen } from '../../src/auth/AuthScreen';
import { confirmErrorMessage } from '../../src/auth/messages';
import { pendingRegistration } from '../../src/auth/pending-registration';
import { TotpField } from '../../src/auth/TotpField';
import { isCompleteTotp, parseTotpSecret } from '../../src/auth/validation';
import { useSession } from '../../src/session/useSession';

const MAX_QR = 240;

export default function RegisterTotpScreen() {
  const router = useRouter();
  const session = useSession();
  const { width } = useWindowDimensions();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const pending = pendingRegistration.get();
  if (!pending) {
    return (
      <AuthScreen>
        <Text variant="bodyMedium">This registration has expired. Please start again.</Text>
        <Button
          mode="contained"
          onPress={() => {
            router.replace('/(auth)/register');
          }}
        >
          Back to registration
        </Button>
      </AuthScreen>
    );
  }

  const secret = parseTotpSecret(pending.totpProvisioningUri);
  const qrSize = Math.min(MAX_QR, Math.max(120, width - 48));

  async function confirm() {
    if (!pending || !session.serverUrl) return;
    setError(null);
    setBusy(true);
    try {
      const res = await createAuthApi(session.serverUrl).registerConfirm({
        pendingId: pending.pendingId,
        totpCode: code,
      });
      await session.signIn(res.sessionToken);
      pendingRegistration.clear();
      router.replace('/');
    } catch (e) {
      setError(confirmErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScreen>
      <Text variant="headlineMedium">Set up two-factor sign-in</Text>
      <Text variant="bodyMedium">
        Scan this code with your authenticator app, then enter the 6-digit code it shows.
      </Text>
      <View style={styles.qr} accessibilityLabel="TOTP QR code">
        <QRCode value={pending.totpProvisioningUri} size={qrSize} backgroundColor="white" />
      </View>
      {secret ? (
        <>
          <Text variant="bodyMedium">Cannot scan? Enter this key manually:</Text>
          <Text variant="titleMedium" selectable style={styles.secret} testID="totp-secret">
            {secret}
          </Text>
          <Button
            mode="outlined"
            icon="content-copy"
            onPress={() => {
              void Clipboard.setStringAsync(secret).then(() => {
                setCopied(true);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy secret'}
          </Button>
        </>
      ) : null}
      <TotpField value={code} onChange={setCode} />
      {error ? (
        <HelperText type="error" visible>
          {error}
        </HelperText>
      ) : null}
      <Button
        mode="contained"
        onPress={() => void confirm()}
        loading={busy}
        disabled={!isCompleteTotp(code) || busy}
      >
        Confirm
      </Button>
    </AuthScreen>
  );
}

const styles = StyleSheet.create({
  qr: { alignSelf: 'center', padding: 12, backgroundColor: 'white', borderRadius: 8 },
  secret: { fontFamily: 'monospace', flexWrap: 'wrap' },
});
