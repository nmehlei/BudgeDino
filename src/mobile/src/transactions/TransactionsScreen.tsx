import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, SectionList, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Banner, Button, Chip, Menu, Searchbar, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isApiClientError } from '../api/errors';
import { useCategories as usePickableCategories } from '../budgets/queries';
import { formatDateRange, formatIsoDate } from '../format/time';
import { useAppTheme } from '../theme';
import { groupByBookingDate } from './group';
import {
  categoryNameMap,
  flattenPages,
  useAccounts,
  useCategories,
  useTransactionsList,
  type TransactionFilters,
} from './queries';
import { TransactionRow } from './TransactionRow';

export const SEARCH_DEBOUNCE_MS = 300;
const MIN_SEARCH_LENGTH = 2;

/** Route params of the Transactions tab (a Home drill-down sets them). */
export interface TransactionsParams {
  categoryId?: string | string[];
  uncategorized?: string | string[];
  from?: string | string[];
  to?: string | string[];
  /** Changes on every drill-down so repeating the same one re-applies its filters. */
  n?: string | string[];
}

type ChipFilters = Omit<TransactionFilters, 'q'>;

function omit<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
  return Object.fromEntries(
    Object.entries(obj).filter(([k]) => !(keys as string[]).includes(k)),
  ) as Omit<T, K>;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

function filtersFromParams(params: TransactionsParams | undefined): ChipFilters {
  const u = first(params?.uncategorized);
  const categoryId = first(params?.categoryId);
  const out: ChipFilters = {};
  if (u === '1' || u === 'true') out.uncategorized = true;
  else if (categoryId) out.categoryId = categoryId;
  const from = first(params?.from);
  const to = first(params?.to);
  if (from) out.from = from;
  if (to) out.to = to;
  return out;
}

export function TransactionsScreen({ params }: { params?: TransactionsParams }) {
  const theme = useAppTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Chip filters start from the route params and are replaced when a new drill-down arrives.
  const [filters, setFilters] = useState<ChipFilters>(() => filtersFromParams(params));
  const paramKey = JSON.stringify(filtersFromParams(params));
  const nonce = first(params?.n);
  useEffect(() => {
    const incoming = JSON.parse(paramKey) as ChipFilters;
    setFilters((prev) => ({
      ...(prev.accountId ? { accountId: prev.accountId } : {}),
      ...incoming,
    }));
    // `nonce` is a dependency only to force a re-apply of an identical drill-down.
  }, [paramKey, nonce]);

  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebounced(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [text]);
  const q = debounced.length >= MIN_SEARCH_LENGTH ? debounced : undefined;
  const searching = q !== undefined;

  const list = useTransactionsList({ ...filters, q });
  const categories = useCategories();
  const pickable = usePickableCategories();
  const accounts = useAccounts();
  const names = useMemo(() => categoryNameMap(categories.data), [categories.data]);
  const transactions = useMemo(() => flattenPages(list.data), [list.data]);
  const sections = useMemo(() => groupByBookingDate(transactions), [transactions]);

  const [menu, setMenu] = useState<'category' | 'account' | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const open = useCallback((id: string) => router.push(`/transaction/${id}`), [router]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isPlaceholderData } = list;
  const empty = transactions.length === 0;
  const loadMore = useCallback(() => {
    // With nothing to show, continuing a long scan is the user's call ("Search further").
    // Never page the previous query's kept (placeholder) data while a new search or filter loads.
    if (!empty && hasNextPage && !isFetchingNextPage && !isPlaceholderData) void fetchNextPage();
  }, [empty, hasNextPage, isFetchingNextPage, isPlaceholderData, fetchNextPage]);

  const offline = isApiClientError(list.error) && list.error.error.kind === 'network';
  const lastEmpty = (list.data?.pages.at(-1)?.transactions.length ?? 0) === 0;
  const scannedUntil = list.data?.pages.at(-1)?.scannedUntil ?? null;
  const filtered = Object.keys(filters).length > 0;

  const searchMore = (
    <View style={styles.message} testID="transactions-search-more">
      <Text variant="bodyMedium" style={styles.centerText}>
        {scannedUntil ? `Searched back to ${formatIsoDate(scannedUntil)}` : 'No matches so far'}
      </Text>
      <Button
        mode="outlined"
        onPress={() => void fetchNextPage()}
        loading={isFetchingNextPage}
        disabled={isFetchingNextPage}
      >
        Search further
      </Button>
    </View>
  );

  const hasCategory = filters.uncategorized === true || filters.categoryId !== undefined;
  const categoryLabel = filters.uncategorized
    ? 'Uncategorised'
    : filters.categoryId
      ? (names.get(filters.categoryId) ?? 'Category')
      : 'Category';
  const account = accounts.data?.find((a) => a.id === filters.accountId);
  const dateLabel = formatDateRange(filters.from, filters.to);

  const setCategory = (patch: { categoryId?: string; uncategorized?: true }) => {
    setFilters((prev) => ({ ...omit(prev, 'categoryId', 'uncategorized'), ...patch }));
    closeMenu();
  };

  const controls = (
    <View style={{ paddingTop: insets.top + 8 }}>
      <Searchbar
        testID="transactions-search"
        placeholder="Search payee or purpose"
        value={text}
        onChangeText={setText}
        autoCorrect={false}
        autoCapitalize="none"
        maxLength={64}
        style={styles.search}
      />
      <View style={styles.chips}>
        <Menu
          visible={menu === 'category'}
          onDismiss={closeMenu}
          anchor={
            <Chip
              icon="tag-outline"
              selected={hasCategory}
              onPress={() => setMenu('category')}
              onClose={hasCategory ? () => setCategory({}) : undefined}
              closeIconAccessibilityLabel={
                filters.uncategorized ? 'Remove uncategorised filter' : 'Remove category filter'
              }
            >
              {categoryLabel}
            </Chip>
          }
        >
          <Menu.Item
            testID="category-option-uncategorized"
            title="Uncategorised"
            onPress={() => setCategory({ uncategorized: true })}
          />
          {(pickable.data ?? []).map((c) => (
            <Menu.Item
              key={c.id}
              testID={`category-option-${c.id}`}
              title={c.name}
              onPress={() => setCategory({ categoryId: c.id })}
            />
          ))}
        </Menu>
        <Menu
          visible={menu === 'account'}
          onDismiss={closeMenu}
          anchor={
            <Chip
              icon="bank-outline"
              selected={filters.accountId !== undefined}
              onPress={() => setMenu('account')}
              onClose={
                filters.accountId ? () => setFilters((prev) => omit(prev, 'accountId')) : undefined
              }
              closeIconAccessibilityLabel="Remove account filter"
            >
              {account?.name ?? 'Account'}
            </Chip>
          }
        >
          {(accounts.data ?? []).map((a) => (
            <Menu.Item
              key={a.id}
              testID={`account-option-${a.id}`}
              title={a.name}
              onPress={() => {
                setFilters((f) => ({ ...f, accountId: a.id }));
                closeMenu();
              }}
            />
          ))}
        </Menu>
        {dateLabel ? (
          <Chip
            icon="calendar-range"
            selected
            onClose={() => setFilters((prev) => omit(prev, 'from', 'to'))}
            closeIconAccessibilityLabel="Remove date filter"
          >
            {dateLabel}
          </Chip>
        ) : null}
      </View>
    </View>
  );

  if (!list.data) {
    return (
      <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
        {controls}
        <View style={styles.center}>
          {list.isError ? (
            <View style={styles.message} testID="transactions-error">
              <Text variant="titleMedium">
                {offline ? "You're offline" : 'Something went wrong'}
              </Text>
              <Text variant="bodyMedium" style={styles.centerText}>
                The transactions couldn&apos;t be loaded.
              </Text>
              <Button
                mode="contained"
                onPress={() => void list.refetch()}
                loading={list.isFetching}
              >
                Retry
              </Button>
            </View>
          ) : (
            <ActivityIndicator animating accessibilityLabel="Loading" />
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      {controls}
      <SectionList
        testID="transactions-list"
        sections={sections}
        keyExtractor={(t) => t.id}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 32 }}
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
          searching && hasNextPage ? (
            searchMore
          ) : (
            <View style={styles.message} testID="transactions-empty">
              <Text variant="bodyMedium">
                {searching
                  ? 'No results'
                  : filtered
                    ? 'No matching transactions.'
                    : 'No transactions yet.'}
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          !empty && searching && hasNextPage && lastEmpty ? (
            searchMore
          ) : isFetchingNextPage && !empty ? (
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
  search: { marginHorizontal: 16, marginBottom: 8 },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
    alignItems: 'center',
  },
});
