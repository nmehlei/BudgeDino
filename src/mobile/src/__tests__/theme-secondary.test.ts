import { darkTheme, lightTheme } from '../theme';

describe('segmented button container', () => {
  it('is the green family in both themes, not the Paper default', () => {
    expect(darkTheme.colors.secondaryContainer).toBe('#1F5F50');
    expect(darkTheme.colors.onSecondaryContainer).toBe('#BFEBDD');
    expect(lightTheme.colors.secondaryContainer).toBe('#CDE9DF');
  });
});
