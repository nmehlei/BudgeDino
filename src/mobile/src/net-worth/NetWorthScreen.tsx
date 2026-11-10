import type { NetWorthAccount, NetWorthGroup } from '@budgedino/shared';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Banner, Button, Divider, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isApiClientError } from '../api/errors';
import { formatMoney } from '../format/money';
import { formatDateTime } from '../format/time';
import { useAppTheme } from '../theme';
import { ScreenHeader } from '../transactions/ScreenHeader';
import { useNetWorth } from './queries';

const KIND_LABEL: Record<NetWorthGroup['kind'], string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit_card: 'Credit cards',
  depot: 'Depots',
  other: 'Other',
};

function AccountRow({ account, base }: { account: NetWorthAccount; base: string }) {
  const theme = useAppTheme();
  const foreign = account.balance !== null && account.balance.currency !== base;
  return (
    <View style={styles.row} testID={`nw-account-${account.id}`}>
      <View style={styles.rowMain}>
        <Text variant="bodyLarge">{account.name}</Text>
        {account.disconnected ? (
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Disconnected
          </Text>
        ) : null}
      </View>
      <View style={styles.amounts}>
        {account.balance === null ? (
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            No balance yet
          </Text>
        ) : (
          <>
            <Text variant="bodyLarge">{formatMoney(account.balance)}</Text>
            {foreign ? (
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {account.baseBalance
                  ? `≈ ${formatMoney(account.baseBalance)}`
                  : 'No rate available'}
              </Text>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}

export function NetWorthScreen() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const q = useNetWorth();
  const [refreshing, setRefreshing] = useState(false);
  const { data } = q;
  const offline = isApiClientError(q.error) && q.error.error.kind === 'network';

  let body;
  if (data) {
    body = (
      <>
        {q.isError ? (
          <Banner
            visible
            icon={offline ? 'wifi-off' : 'alert-circle-outline'}
            actions={[{ label: 'Retry', onPress: () => void q.refetch(), loading: q.isFetching }]}
            testID="offline-banner"
          >
            {offline
              ? `Offline — showing data from ${formatDateTime(q.dataUpdatedAt)}`
              : `Couldn't refresh — showing data from ${formatDateTime(q.dataUpdatedAt)}`}
          </Banner>
        ) : null}
        {data.groups.length === 0 ? (
          <View style={styles.empty} testID="net-worth-empty">
            <Text variant="titleMedium" style={styles.center}>
              Connect a bank to see your net worth
            </Text>
          </View>
        ) : (
          <View style={styles.content}>
            <View>
              <Text variant="labelLarge" style={{ color: theme.colors.onSurfaceVariant }}>
                Total
              </Text>
              <Text variant="displaySmall" testID="net-worth-total">
                {formatMoney(data.total)}
              </Text>
            </View>
            {data.fxMissing ? (
              <Text
                variant="bodySmall"
                style={{ color: theme.colors.onSurfaceVariant }}
                testID="fx-missing"
              >
                Some foreign amounts couldn&apos;t be converted and are not included.
              </Text>
            ) : null}
            {data.groups.map((g) => (
              <View key={g.kind} testID={`nw-group-${g.kind}`}>
                <View style={styles.groupHeader}>
                  <Text variant="titleMedium" style={styles.rowMain}>
                    {KIND_LABEL[g.kind]}
                  </Text>
                  <Text variant="titleMedium">{formatMoney(g.total)}</Text>
                </View>
                <Divider />
                {g.accounts.map((a) => (
                  <AccountRow key={a.id} account={a} base={data.baseCurrency} />
                ))}
              </View>
            ))}
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              History graph coming soon
            </Text>
          </View>
        )}
      </>
    );
  } else if (q.isError) {
    body = (
      <View style={styles.empty} testID="net-worth-error">
        <Text variant="titleMedium">{offline ? "You're offline" : 'Something went wrong'}</Text>
        <Text variant="bodyMedium" style={styles.center}>
          {offline
            ? "The server can't be reached and there is no saved data yet."
            : "The net worth couldn't be loaded."}
        </Text>
        <Button mode="contained" onPress={() => void q.refetch()} loading={q.isFetching}>
          Retry
        </Button>
      </View>
    );
  } else {
    body = (
      <View style={styles.empty}>
        <ActivityIndicator animating accessibilityLabel="Loading" />
      </View>
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <ScreenHeader title="Net worth" />
      <ScrollView
        testID="net-worth-scroll"
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void q.refetch().finally(() => setRefreshing(false));
            }}
            colors={[theme.colors.primary]}
            tintColor={theme.colors.primary}
            progressBackgroundColor={theme.colors.elevation.level3}
          />
        }
      >
        {body}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 16, gap: 20 },
  empty: { padding: 24, gap: 16, alignItems: 'center' },
  center: { textAlign: 'center' },
  groupHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingBottom: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 10 },
  rowMain: { flexShrink: 1, flexGrow: 1 },
  amounts: { alignItems: 'flex-end', flexShrink: 1 },
});
