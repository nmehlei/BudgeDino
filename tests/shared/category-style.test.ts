import { describe, expect, it } from 'vitest';
import {
  CATEGORY_COLOR_KEYS,
  CATEGORY_COLORS,
  CATEGORY_ICONS,
  fallbackCategoryStyle,
  resolveCategoryStyle,
} from '@budgedino/shared';

const SURFACE = { light: '#FBFDFB', dark: '#151B18' } as const;

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('category palette', () => {
  it('has the 18 documented keys and 40 unique icons', () => {
    expect(CATEGORY_COLOR_KEYS).toHaveLength(18);
    expect(Object.keys(CATEGORY_COLORS).sort()).toEqual([...CATEGORY_COLOR_KEYS].sort());
    expect(CATEGORY_ICONS).toHaveLength(40);
    expect(new Set(CATEGORY_ICONS).size).toBe(40);
  });

  it.each(CATEGORY_COLOR_KEYS.flatMap((k) => [[k, 'light'] as const, [k, 'dark'] as const]))(
    'every colour reaches 3:1 against the surface in both themes (%s, %s)',
    (key, theme) => {
      expect(contrast(CATEGORY_COLORS[key][theme], SURFACE[theme])).toBeGreaterThanOrEqual(3);
    },
  );
});

describe('fallbackCategoryStyle', () => {
  it('is deterministic and never accent/grey', () => {
    for (let i = 0; i < 200; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const s = fallbackCategoryStyle(id);
      expect(s).toEqual(fallbackCategoryStyle(id));
      expect(s.icon).toBe('tag');
      expect(s.color).not.toBe('accent');
      expect(s.color).not.toBe('grey');
      expect(CATEGORY_COLOR_KEYS).toContain(s.color);
    }
  });

  it('spreads ids over several colours', () => {
    const colors = new Set(
      Array.from({ length: 100 }, (_, i) => fallbackCategoryStyle(`id-${i}`).color),
    );
    expect(colors.size).toBeGreaterThan(5);
  });
});

describe('resolveCategoryStyle', () => {
  const id = 'abc';
  const fb = fallbackCategoryStyle(id);
  it('keeps valid values', () => {
    expect(resolveCategoryStyle({ id, icon: 'cart', color: 'green' })).toEqual({
      icon: 'cart',
      color: 'green',
    });
  });
  it('falls back per field for null and unknown values', () => {
    expect(resolveCategoryStyle({ id, icon: null, color: null })).toEqual(fb);
    expect(resolveCategoryStyle({ id, icon: 'cart', color: null })).toEqual({
      icon: 'cart',
      color: fb.color,
    });
    expect(resolveCategoryStyle({ id, icon: 'nope', color: 'green' })).toEqual({
      icon: fb.icon,
      color: 'green',
    });
    expect(resolveCategoryStyle({ id, icon: 'cart', color: '#fff' })).toEqual({
      icon: 'cart',
      color: fb.color,
    });
  });
});
