/**
 * Category icon and colour allowlists. The server stores keys/names only (never hex), so dark mode
 * resolves correctly on the client. Every colour reaches 3:1 against the theme surface
 * (`#FBFDFB` light, `#151B18` dark); a unit test checks this.
 */
export const CATEGORY_COLOR_KEYS = [
  'green',
  'orange',
  'blue',
  'brown',
  'amber',
  'indigo',
  'violet',
  'pink',
  'rose',
  'apricot',
  'teal',
  'sky',
  'red',
  'slate',
  'olive',
  'gold',
  'accent',
  'grey',
] as const;
export type CategoryColorKey = (typeof CATEGORY_COLOR_KEYS)[number];

export const CATEGORY_COLORS: Record<CategoryColorKey, { light: string; dark: string }> = {
  green: { light: '#2F9E6B', dark: '#5FCB97' },
  orange: { light: '#D9703A', dark: '#F2A06E' },
  blue: { light: '#3E7BD6', dark: '#7EA9EE' },
  brown: { light: '#7A5C4A', dark: '#B99683' },
  amber: { light: '#B8860B', dark: '#E3B53F' },
  indigo: { light: '#4A6FA5', dark: '#8FAEDF' },
  violet: { light: '#8A5CD0', dark: '#B99BEA' },
  pink: { light: '#C2489A', dark: '#E888C6' },
  rose: { light: '#D6456B', dark: '#EE8AA5' },
  apricot: { light: '#D07A20', dark: '#EFA65A' },
  teal: { light: '#1F9BAA', dark: '#5CCBD8' },
  sky: { light: '#2D8FD5', dark: '#6CBBF0' },
  red: { light: '#D04848', dark: '#EE8585' },
  slate: { light: '#6B7A8F', dark: '#A4B1C2' },
  olive: { light: '#5E8C3A', dark: '#93C16D' },
  gold: { light: '#B7861A', dark: '#E3B84F' },
  accent: { light: '#2E7D6B', dark: '#6CC4AE' },
  grey: { light: '#7D8784', dark: '#A9B3B0' },
};

/** MaterialCommunityIcons glyph names a category may use (a test checks each exists). */
export const CATEGORY_ICONS = [
  // the 19 defaults
  'cart',
  'silverware-fork-knife',
  'bus',
  'home-variant',
  'lightning-bolt',
  'shield-check',
  'play-box-multiple',
  'shopping',
  'heart-pulse',
  'teddy-bear',
  'ticket',
  'airplane',
  'gift',
  'receipt-text',
  'cash',
  'piggy-bank',
  'cash-plus',
  'swap-horizontal',
  'help',
  // fallback and extras
  'tag',
  'dog',
  'school',
  'dumbbell',
  'car',
  'gas-station',
  'phone',
  'wifi',
  'tshirt-crew',
  'hammer-wrench',
  'flower',
  'baby-carriage',
  'glass-cocktail',
  'coffee',
  'book-open-variant',
  'music',
  'gamepad-variant',
  'briefcase',
  'hospital-box',
  'bank',
  'credit-card',
] as const;
export type CategoryIcon = (typeof CATEGORY_ICONS)[number];

export interface CategoryStyle {
  icon: CategoryIcon;
  color: CategoryColorKey;
}

/** 32-bit FNV-1a. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** `accent` (income) and `grey` (transfer/uncategorised) are reserved and never picked here. */
const FALLBACK_COLORS = CATEGORY_COLOR_KEYS.slice(0, CATEGORY_COLOR_KEYS.length - 2);

/** Style for a category without stored icon/colour: the `tag` icon and a colour derived from the id. */
export function fallbackCategoryStyle(id: string): CategoryStyle {
  return {
    icon: 'tag',
    color: FALLBACK_COLORS[fnv1a(id) % FALLBACK_COLORS.length] as CategoryColorKey,
  };
}

const isIcon = (v: string | null): v is CategoryIcon =>
  v !== null && (CATEGORY_ICONS as readonly string[]).includes(v);
const isColor = (v: string | null): v is CategoryColorKey =>
  v !== null && (CATEGORY_COLOR_KEYS as readonly string[]).includes(v);

/** Resolves stored values; null or unknown values fall back per field. */
export function resolveCategoryStyle(c: {
  id: string;
  icon: string | null;
  color: string | null;
}): CategoryStyle {
  const fb = fallbackCategoryStyle(c.id);
  return { icon: isIcon(c.icon) ? c.icon : fb.icon, color: isColor(c.color) ? c.color : fb.color };
}
