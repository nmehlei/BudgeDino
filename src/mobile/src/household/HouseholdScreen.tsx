import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  Divider,
  IconButton,
  List,
  Snackbar,
  Text,
} from 'react-native-paper';

import { isApiClientError } from '../api/errors';
import { useApi } from '../api/useApi';
import { formatDateTime } from '../format/time';
import { useSession } from '../session/useSession';
import { SettingsPage } from '../settings/SettingsPage';
import { useAppTheme } from '../theme';
import { InviteSheet } from './InviteSheet';
import { invitesKey, useInvites, useMembers } from './queries';

const ROLE_LABEL = { admin: 'Admin', member: 'Member' } as const;

export function HouseholdScreen() {
  const theme = useAppTheme();
  const api = useApi();
  const client = useQueryClient();
  const session = useSession();
  const members = useMembers();
  const isAdmin = members.data?.find((m) => m.isSelf)?.role === 'admin';
  const invites = useInvites(isAdmin);
  const [inviting, setInviting] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const revoke = async (id: string) => {
    setRevoking(id);
    try {
      await api.revokeInvite(id);
      setToast('Invite revoked');
    } catch (error) {
      const status = isApiClientError(error) ? error.error : null;
      if (status?.kind === 'server' && status.status === 409) {
        setToast('This invite was already used');
      } else if (status?.kind === 'server' && status.status === 404) {
        setToast('This invite no longer exists');
      } else if (status?.kind === 'network') {
        setToast('No connection. Try again when you are online.');
      } else {
        setToast("Couldn't revoke the invite.");
      }
    } finally {
      setRevoking(null);
      void client.invalidateQueries({ queryKey: invitesKey });
      // A used invite means a new member.
      void client.invalidateQueries({ queryKey: ['household', 'members'] });
    }
  };

  const closeSheet = (created: boolean) => {
    setInviting(false);
    if (created) void client.invalidateQueries({ queryKey: invitesKey });
  };

  let body;
  if (members.data) {
    body = (
      <>
        {members.data.map((m, i) => (
          <View key={m.id}>
            {i > 0 ? <Divider /> : null}
            <List.Item
              testID={`member-${m.id}`}
              title={m.displayName}
              titleNumberOfLines={0}
              description={[
                ROLE_LABEL[m.role],
                m.isSelf ? 'You' : null,
                m.disabled ? 'Disabled' : null,
                m.email ?? null,
              ]
                .filter((p) => p !== null)
                .join(' · ')}
              descriptionNumberOfLines={0}
              descriptionStyle={{ color: theme.colors.onSurfaceVariant }}
              left={(p) => (
                <List.Icon {...p} icon={m.role === 'admin' ? 'shield-account' : 'account'} />
              )}
            />
          </View>
        ))}
        {isAdmin ? (
          <>
            <Button
              mode="contained"
              icon="account-plus"
              onPress={() => setInviting(true)}
              style={styles.inviteButton}
              testID="invite-someone"
            >
              Invite someone
            </Button>
            <Text variant="titleSmall" style={styles.pad}>
              Pending invites
            </Text>
            {invites.data ? (
              invites.data.length === 0 ? (
                <Text
                  variant="bodyMedium"
                  style={[styles.pad, { color: theme.colors.onSurfaceVariant }]}
                >
                  No pending invites.
                </Text>
              ) : (
                <View testID="pending-invites">
                  {invites.data.map((inv) => (
                    <List.Item
                      key={inv.id}
                      testID={`pending-invite-${inv.id}`}
                      title={`${ROLE_LABEL[inv.role]} invite`}
                      description={`Expires ${formatDateTime(Date.parse(inv.expiresAt))}`}
                      descriptionNumberOfLines={0}
                      descriptionStyle={{ color: theme.colors.onSurfaceVariant }}
                      right={() => (
                        <IconButton
                          icon="close-circle-outline"
                          accessibilityLabel={`Revoke ${ROLE_LABEL[inv.role]} invite`}
                          disabled={revoking === inv.id}
                          onPress={() => void revoke(inv.id)}
                          testID={`revoke-invite-${inv.id}`}
                        />
                      )}
                    />
                  ))}
                </View>
              )
            ) : invites.isError ? (
              <View style={[styles.message, styles.pad]} testID="invites-error">
                <Text variant="bodyMedium">The pending invites couldn&apos;t be loaded.</Text>
                <Button onPress={() => void invites.refetch()}>Retry</Button>
              </View>
            ) : (
              <ActivityIndicator animating accessibilityLabel="Loading invites" />
            )}
          </>
        ) : (
          <Text
            variant="bodySmall"
            style={[styles.pad, styles.hint, { color: theme.colors.onSurfaceVariant }]}
            testID="household-readonly"
          >
            Only admins can invite people.
          </Text>
        )}
      </>
    );
  } else if (members.isError) {
    // Never treat a failed lookup as "not an admin": say so and let the user retry.
    body = (
      <View style={[styles.message, styles.pad]} testID="household-error">
        <Text variant="bodyMedium">The household couldn&apos;t be loaded.</Text>
        <Button mode="contained" onPress={() => void members.refetch()}>
          Retry
        </Button>
      </View>
    );
  } else {
    body = <ActivityIndicator animating accessibilityLabel="Loading" />;
  }

  return (
    <SettingsPage
      title="Household"
      overlay={
        <>
          {inviting ? <InviteSheet serverUrl={session.serverUrl} onClose={closeSheet} /> : null}
          <Snackbar visible={toast !== null} onDismiss={() => setToast(null)} duration={5000}>
            {toast ?? ''}
          </Snackbar>
        </>
      }
    >
      {body}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: 16 },
  hint: { marginTop: 16 },
  inviteButton: { margin: 16, alignSelf: 'flex-start' },
  message: { gap: 12, alignItems: 'flex-start' },
});
