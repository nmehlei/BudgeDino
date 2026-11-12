import {
  CATEGORY_COLORS,
  CATEGORY_COLOR_KEYS,
  CATEGORY_ICONS,
  type CategoryColorKey,
  type CategoryIcon as CategoryIconName,
} from '@budgedino/shared';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

import { useAppTheme } from '../theme';

export interface CategoryStyleValue {
  icon: CategoryIconName;
  color: CategoryColorKey;
}

interface Props {
  value: CategoryStyleValue;
  onChange: (next: CategoryStyleValue) => void;
}

const label = (name: string) => name.replace(/-/g, ' ');

/** A 6-column icon grid and a wrapping row of colour swatches; the selected item gets a 2 dp primary outline. */
export function StylePicker({ value, onChange }: Props) {
  const theme = useAppTheme();
  const mode = theme.dark ? 'dark' : 'light';
  const tint = CATEGORY_COLORS[value.color][mode];
  const outline = (selected: boolean) => ({
    borderWidth: 2,
    borderColor: selected ? theme.colors.primary : 'transparent',
  });
  return (
    <View style={styles.root} testID="style-picker">
      <Text variant="labelLarge">Icon</Text>
      <View style={styles.grid}>
        {CATEGORY_ICONS.map((icon) => {
          const selected = icon === value.icon;
          return (
            <Pressable
              key={icon}
              onPress={() => onChange({ ...value, icon })}
              accessibilityRole="button"
              accessibilityLabel={label(icon)}
              accessibilityState={{ selected }}
              testID={`icon-option-${icon}`}
              style={[styles.cell, outline(selected)]}
            >
              <MaterialCommunityIcons
                name={icon as keyof typeof MaterialCommunityIcons.glyphMap}
                size={24}
                color={selected ? tint : theme.colors.onSurfaceVariant}
              />
            </Pressable>
          );
        })}
      </View>
      <Text variant="labelLarge">Colour</Text>
      <View style={styles.grid}>
        {CATEGORY_COLOR_KEYS.map((key) => {
          const selected = key === value.color;
          return (
            <Pressable
              key={key}
              onPress={() => onChange({ ...value, color: key })}
              accessibilityRole="button"
              accessibilityLabel={key}
              accessibilityState={{ selected }}
              testID={`color-option-${key}`}
              style={[styles.cell, outline(selected)]}
            >
              <View style={[styles.swatch, { backgroundColor: CATEGORY_COLORS[key][mode] }]} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  // Exactly six columns (a sixth of the row each, square), never below the 40 dp touch minimum.
  cell: {
    width: '16.66%',
    aspectRatio: 1,
    minWidth: 40,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatch: { width: 28, height: 28, borderRadius: 14 },
});
