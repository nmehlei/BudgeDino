import type { CreateConnectorRequest } from '@budgedino/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from 'react-native';
import { Button, RadioButton, Snackbar, Switch, Text, TextInput } from 'react-native-paper';

import { useApi } from '../api/useApi';
import { ScreenHeader } from '../transactions/ScreenHeader';
import { useAppTheme } from '../theme';
import { FINTS_BANK_CHOICES } from './banks';
import { challengeStore } from './challenge-store';
import { connectorsKey, describeActionError, useConnectorTypes } from './queries';

const DEMO = 'demo';
type Choice = (typeof FINTS_BANK_CHOICES)[number]['id'] | typeof DEMO;

export function AddConnectionScreen() {
  const theme = useAppTheme();
  const router = useRouter();
  const api = useApi();
  const client = useQueryClient();
  const types = useConnectorTypes();
  const [choice, setChoice] = useState<Choice>('dkb');
  // Credentials live in component state only until the request is sent; never in a query/mutation,
  // the cache or storage.
  const [userId, setUserId] = useState('');
  const [pin, setPin] = useState('');
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const demo = choice === DEMO;
  const showDemo = types.data?.includes('fake') === true;
  const canSubmit = !busy && (demo || (userId.trim() !== '' && pin !== ''));

  const submit = async () => {
    if (!canSubmit) return;
    const body: CreateConnectorRequest = demo
      ? { type: 'fake', config: { scenario: 'decoupled' } }
      : { type: 'fints', config: { bank: choice, userId: userId.trim(), pin } };
    if (priv) body.accountDefaults = { visibility: 'owner_only' };
    // Wipe the credentials from state before the request is awaited.
    setUserId('');
    setPin('');
    setBusy(true);
    try {
      const res = await api.createConnector(body);
      void client.invalidateQueries({ queryKey: connectorsKey });
      if (res.challenge) {
        challengeStore.set({ view: res.challenge, connectorId: res.connectorId });
        router.replace(`/connections/challenge/${res.challenge.id}`);
      } else {
        router.replace('/connections');
      }
    } catch (error) {
      setToast(describeActionError(error, "Couldn't connect the bank."));
      setBusy(false);
    }
  };

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <ScreenHeader title="Add bank" />
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text variant="titleMedium">Bank</Text>
          <RadioButton.Group value={choice} onValueChange={(v) => setChoice(v as Choice)}>
            {FINTS_BANK_CHOICES.map((b) => (
              <RadioButton.Item
                key={b.id}
                label={b.name}
                value={b.id}
                testID={`bank-${b.id}`}
                labelVariant="bodyLarge"
              />
            ))}
            {showDemo ? (
              <RadioButton.Item
                label="Demo bank"
                value={DEMO}
                testID="bank-demo"
                labelVariant="bodyLarge"
              />
            ) : null}
          </RadioButton.Group>

          {demo ? null : (
            <>
              <TextInput
                label="User ID"
                value={userId}
                onChangeText={setUserId}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                importantForAutofill="no"
                textContentType="none"
                testID="userid-input"
              />
              <TextInput
                label="PIN"
                value={pin}
                onChangeText={setPin}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                importantForAutofill="no"
                textContentType="none"
                contextMenuHidden
                testID="pin-input"
              />
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                The PIN is sent to your own server to log in to the bank (read-only) and is stored
                encrypted there. It is never kept in the app.
              </Text>
            </>
          )}

          <View style={styles.toggle}>
            <Text variant="bodyLarge" style={styles.toggleLabel}>
              Keep these accounts private
            </Text>
            <Switch
              value={priv}
              onValueChange={setPriv}
              testID="private-switch"
              accessibilityLabel="Keep these accounts private"
            />
          </View>

          <Button
            mode="contained"
            onPress={() => void submit()}
            disabled={!canSubmit}
            loading={busy}
            testID="connect-submit"
          >
            Connect
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
      <Snackbar visible={toast !== null} onDismiss={() => setToast(null)} duration={6000}>
        {toast ?? ''}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  toggleLabel: { flex: 1 },
});
