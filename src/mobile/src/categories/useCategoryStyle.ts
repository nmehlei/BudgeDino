import {
  CATEGORY_COLORS,
  fallbackCategoryStyle,
  resolveCategoryStyle,
  type CategoryColorKey,
  type CategoryIcon,
} from '@budgedino/shared';
import { useCallback } from 'react';

import { useAppTheme } from '../theme';
import { SPLIT_ICON } from './split-icon';
import { useCategories } from '../transactions/queries';

/** The theme-aware hex for a palette key. */
export function useCategoryColor(key: CategoryColorKey): string {
  const dark = useAppTheme().dark;
  return CATEGORY_COLORS[key][dark ? 'dark' : 'light'];
}

/**
 * Resolves a category id to its icon and theme-aware colour. Built from the cached categories query
 * (archived ones included, so old transactions resolve); `null` is uncategorised, an unknown id gets
 * the deterministic fallback.
 */
export function useCategoryStyleById(): (categoryId: string | null) => {
  icon: CategoryIcon;
  color: string;
} {
  const dark = useAppTheme().dark;
  const { data } = useCategories();
  return useCallback(
    (categoryId) => {
      const mode = dark ? 'dark' : 'light';
      if (categoryId === null) return { icon: 'help', color: CATEGORY_COLORS.grey[mode] };
      const found = data?.find((c) => c.id === categoryId);
      const style = found ? resolveCategoryStyle(found) : fallbackCategoryStyle(categoryId);
      return { icon: style.icon, color: CATEGORY_COLORS[style.color][mode] };
    },
    [data, dark],
  );
}

/**
 * The icon and colour a transaction shows: its category's, the uncategorised `help` when it has none, or
 * the grey `call-split` glyph when it is split across several categories.
 */
export function useTransactionStyleOf(): (tx: {
  categoryId: string | null;
  splits: readonly unknown[];
}) => {
  icon: string;
  color: string;
} {
  const styleOf = useCategoryStyleById();
  return useCallback(
    (tx) =>
      tx.splits.length > 0
        ? { icon: SPLIT_ICON, color: styleOf(null).color }
        : styleOf(tx.categoryId),
    [styleOf],
  );
}
