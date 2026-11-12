import type { Role } from '@budgedino/shared';
import { useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';
import { Button, HelperText, Modal, Portal, SegmentedButtons, Text } from 'react-native-paper';
import QRCode from 'react-native-qrcode-svg';

import { useApi } from '../api/useApi';
import { formatDateTime } from '../format/time';
import { useAppTheme } from '../theme';
import { buildJoinLink } from './join-link';

interface Created {
  link: string;
  expiresAt: string;
}

/**
 * Creates an invite and shows it as QR code and share text. The token exists only in this component's state:
 * not in the query cache (no `useMutation`), not in storage, not logged. Mount it only while open, so closing
 * drops the state.
 */
export function InviteSheet({
  serverUrl,
  onClose,
}: {
  serverUrl: string | null;
  /** Called on every way out; `created` tells the caller to refresh the pending list. */
  onClose: (created: boolean) => void;
}) {
  const theme = useAppTheme();
  const api = useApi();
  const [role, setRole] = useState<Role>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const create = async () => {
    if (!serverUrl) {
      setError('No server is configured.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.createInvite({ role });
      setCreated({ link: buildJoinLink(serverUrl, res.inviteToken), expiresAt: res.expiresAt });
    } catch {
      setError("Couldn't create the invite. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const share = () => {
    if (!created) return;
    void Share.share({ message: `Join my household on BudgeDino: ${created.link}` }).catch(() => {
      setError("Couldn't open the share dialog.");
    });
  };

  return (
    <Portal>
      <Modal
        visible
        onDismiss={() => !busy && onClose(created !== null)}
        contentContainerStyle={[styles.sheet, { backgroundColor: theme.colors.surface }]}
      >
        <Text variant="titleLarge">Invite someone</Text>
        {created ? (
          <View style={styles.body}>
            <View style={styles.qr} accessibilityLabel="Invite QR code">
              <QRCode value={created.link} size={200} backgroundColor="white" color="black" />
            </View>
            <Text variant="bodyMedium">
              {`Scan this code on the new member's phone or share the link. It works once and expires ${formatDateTime(Date.parse(created.expiresAt))}.`}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              This code is shown only now. Anyone with it can join, so share it privately.
            </Text>
            {error ? <HelperText type="error">{error}</HelperText> : null}
            <View style={styles.actions}>
              <Button mode="contained" icon="share-variant" onPress={share} testID="invite-share">
                Share link
              </Button>
              <Button onPress={() => onClose(true)} testID="invite-done">
                Done
              </Button>
            </View>
          </View>
        ) : (
          <View style={styles.body}>
            <Text variant="bodyMedium">What role should the new member get?</Text>
            <SegmentedButtons
              value={role}
              onValueChange={(v) => setRole(v as Role)}
              buttons={[
                { value: 'member', label: 'Member', testID: 'invite-role-member' },
                { value: 'admin', label: 'Admin', testID: 'invite-role-admin' },
              ]}
            />
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Admins can also manage budgets and invite others.
            </Text>
            {error ? <HelperText type="error">{error}</HelperText> : null}
            <View style={styles.actions}>
              <Button
                mode="contained"
                onPress={() => void create()}
                loading={busy}
                disabled={busy}
                testID="invite-create"
              >
                Create invite
              </Button>
              <Button onPress={() => onClose(false)} disabled={busy} testID="invite-cancel">
                Cancel
              </Button>
            </View>
          </View>
        )}
      </Modal>
    </Portal>
  );
}

const styles = StyleSheet.create({
  sheet: { margin: 16, padding: 20, borderRadius: 16, gap: 12 },
  body: { gap: 12 },
  qr: { alignSelf: 'center', padding: 12, backgroundColor: 'white', borderRadius: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' },
});
