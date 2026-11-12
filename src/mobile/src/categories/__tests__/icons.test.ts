import { CATEGORY_ICONS } from '@budgedino/shared';
import glyphMap from '@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/MaterialCommunityIcons.json';

describe('CATEGORY_ICONS', () => {
  it('only names glyphs that exist in MaterialCommunityIcons', () => {
    const missing = CATEGORY_ICONS.filter((name) => !(name in glyphMap));
    expect(missing).toEqual([]);
  });
});
