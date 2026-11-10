import { useNavigation, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { Button, HelperText, Text } from 'react-native-paper';
import QRCode from 'react-native-qrcode-svg';

import { createAuthApi } from '../../src/auth/api';
import { copySecretWithWipe } from '../../src/auth/clipboard';
import { AuthScreen } from '../../src/auth/AuthScreen';
import { confirmErrorMessage } from '../../src/auth/messages';
import { pendingRegistration } from '../../src/auth/pending-registration';
import { TotpField } from '../../src/auth/TotpField';
import { isCompleteTotp, parseTotpSecret } from '../../src/auth/validation';
import { useScreenProtection } from '../../src/security/useScreenProtection';
import { useSession } from '../../src/session/useSession';

/** expo-router's navigation type omits the stack events; `beforeRemove` exists on every navigator. */
interface BeforeRemoveEmitter {
  addListener: (event: 'beforeRemove', cb: () => void) => () => void;
}

const MAX_QR = 240;

export default function RegisterTotpScreen() {
  // Shows the TOTP secret and QR code: keep it out of screenshots and the recents thumbnail.
  useScreenProtection('budgedino-totp-setup');
  const router = useRouter();
  const session = useSession();
  const { width } = useWindowDimensions();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const navigation = useNavigation();
  const done = useRef(false);

  // The provisioning URI holds the TOTP secret: drop it when the screen is left. beforeRemove (not an
  // effect cleanup) so StrictMode's simulated unmount cannot clear it while the screen still renders.
  useEffect(() => {
    const off = (navigation as BeforeRemoveEmitter).addListener('beforeRemove', () => {
      pendingRegistration.clear();
    });
    return off;
  }, [navigation]);

  const pending = pendingRegistration.get();
  if (!pending) {
    if (done.current) return null; // confirmed: avoid a flash of the expired notice
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
      done.current = true;
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
              void copySecretWithWipe(secret).then(() => {
                setCopied(true);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy secret'}
          </Button>
          {copied ? (
            <Text variant="bodySmall">The clipboard is cleared in about a minute.</Text>
          ) : null}
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
