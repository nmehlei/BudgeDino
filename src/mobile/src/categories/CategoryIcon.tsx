import { CATEGORY_COLORS, type CategoryColorKey } from '@budgedino/shared';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import { useCategoryColor } from './useCategoryStyle';

const SIZES = { sm: 28, md: 36, lg: 44 } as const;

/** Hex colour with 13 % opacity (`0x21` of `0xFF`). */
const TINT_ALPHA = '21';

interface Props {
  /** MaterialCommunityIcons glyph name. */
  icon: string;
  /** A resolved hex colour, or a palette key (resolved for the current theme). */
  color: string;
  size?: keyof typeof SIZES;
  /** Decorative by default: the category name is always next to it. */
  accessibilityElementsHidden?: boolean;
}

function isKey(color: string): color is CategoryColorKey {
  return color in CATEGORY_COLORS;
}

/** A circle tinted with the category colour and the glyph in that colour. */
export function CategoryIcon({
  icon,
  color,
  size = 'md',
  accessibilityElementsHidden = true,
}: Props) {
  const fromKey = useCategoryColor(isKey(color) ? color : 'grey');
  const hex = isKey(color) ? fromKey : color;
  const dp = SIZES[size];
  return (
    <View
      testID="category-icon"
      accessibilityElementsHidden={accessibilityElementsHidden}
      importantForAccessibility={accessibilityElementsHidden ? 'no-hide-descendants' : 'auto'}
      style={[
        styles.circle,
        { width: dp, height: dp, borderRadius: dp / 2, backgroundColor: `${hex}${TINT_ALPHA}` },
      ]}
    >
      <MaterialCommunityIcons
        name={icon as keyof typeof MaterialCommunityIcons.glyphMap}
        size={Math.round(dp * 0.55)}
        color={hex}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
});
