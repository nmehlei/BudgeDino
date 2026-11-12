import {
  CATEGORY_COLORS,
  fallbackCategoryStyle,
  resolveCategoryStyle,
  type CategoryColorKey,
  type CategoryIcon,
} from '@budgedino/shared';
import { useCallback } from 'react';

import { useAppTheme } from '../theme';
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
