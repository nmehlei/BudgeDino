import { CATEGORY_ICONS } from '@budgedino/shared';
import { SPLIT_ICON } from '../split-icon';
import glyphMap from '@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/MaterialCommunityIcons.json';

describe('CATEGORY_ICONS', () => {
  it('only names glyphs that exist in MaterialCommunityIcons', () => {
    const missing = CATEGORY_ICONS.filter((name) => !(name in glyphMap));
    expect(missing).toEqual([]);
  });

  it('the split glyph exists in MaterialCommunityIcons (and is not a pickable category icon)', () => {
    expect(SPLIT_ICON in glyphMap).toBe(true);
    expect((CATEGORY_ICONS as readonly string[]).includes(SPLIT_ICON)).toBe(false);
  });
});
