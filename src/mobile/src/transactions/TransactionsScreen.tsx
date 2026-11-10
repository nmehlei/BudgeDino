import { useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { RefreshControl, SectionList, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Banner, Button, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isApiClientError } from '../api/errors';
import { useAppTheme } from '../theme';
import { groupByBookingDate } from './group';
import { categoryNameMap, flattenPages, useCategories, useTransactionsList } from './queries';
import { TransactionRow } from './TransactionRow';

export function TransactionsScreen() {
  const theme = useAppTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const list = useTransactionsList();
  const categories = useCategories();
  const names = useMemo(() => categoryNameMap(categories.data), [categories.data]);
  const sections = useMemo(() => groupByBookingDate(flattenPages(list.data)), [list.data]);

  const open = useCallback((id: string) => router.push(`/transaction/${id}`), [router]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const offline = isApiClientError(list.error) && list.error.error.kind === 'network';

  if (!list.data) {
    return (
      <View
        style={[
          styles.center,
          { backgroundColor: theme.colors.background, paddingTop: insets.top },
        ]}
      >
        {list.isError ? (
          <View style={styles.message} testID="transactions-error">
            <Text variant="titleMedium">{offline ? "You're offline" : 'Something went wrong'}</Text>
            <Text variant="bodyMedium" style={styles.centerText}>
              The transactions couldn&apos;t be loaded.
            </Text>
            <Button mode="contained" onPress={() => void list.refetch()} loading={list.isFetching}>
              Retry
            </Button>
          </View>
        ) : (
          <ActivityIndicator animating accessibilityLabel="Loading" />
        )}
      </View>
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <SectionList
        testID="transactions-list"
        sections={sections}
        keyExtractor={(t) => t.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={list.isRefetching && !isFetchingNextPage}
            onRefresh={() => void list.refetch()}
            colors={[theme.colors.primary]}
            tintColor={theme.colors.primary}
            progressBackgroundColor={theme.colors.elevation.level3}
          />
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          list.isError ? (
            <Banner
              visible
              icon={offline ? 'wifi-off' : 'alert-circle-outline'}
              actions={[{ label: 'Retry', onPress: () => void list.refetch() }]}
              testID="transactions-banner"
            >
              {offline
                ? 'Offline, showing saved transactions'
                : "Couldn't refresh, showing saved data"}
            </Banner>
          ) : undefined
        }
        renderSectionHeader={({ section }) => (
          <Text
            variant="labelLarge"
            style={[styles.header, { color: theme.colors.onSurfaceVariant }]}
            accessibilityRole="header"
          >
            {section.title}
          </Text>
        )}
        renderItem={({ item }) => (
          <TransactionRow
            transaction={item}
            categoryName={item.categoryId ? (names.get(item.categoryId) ?? null) : null}
            onPress={open}
          />
        )}
        ListEmptyComponent={
          <View style={styles.message} testID="transactions-empty">
            <Text variant="bodyMedium">No transactions yet.</Text>
          </View>
        }
        ListFooterComponent={
          isFetchingNextPage ? (
            <ActivityIndicator animating accessibilityLabel="Loading more" style={styles.footer} />
          ) : undefined
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', padding: 24 },
  message: { padding: 24, gap: 16, alignItems: 'center' },
  centerText: { textAlign: 'center' },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
  footer: { paddingVertical: 16 },
});
