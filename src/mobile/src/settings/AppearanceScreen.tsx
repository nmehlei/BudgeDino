import { useSyncExternalStore } from 'react';
import { StyleSheet } from 'react-native';
import { RadioButton } from 'react-native-paper';

import { getThemeStore, THEME_PREFERENCES, type ThemePreference } from '../theme-store';
import { SettingsPage } from './SettingsPage';

const THEME_LABEL: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/** System / Light / Dark. A radio list (not segmented buttons) so labels wrap at large font scales. */
export function AppearanceScreen() {
  const themeStore = getThemeStore();
  const preference = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.getPreference,
    themeStore.getPreference,
  );
  return (
    <SettingsPage title="Appearance">
      <RadioButton.Group
        value={preference}
        onValueChange={(v) => {
          if ((THEME_PREFERENCES as readonly string[]).includes(v)) {
            themeStore.setPreference(v as ThemePreference);
          }
        }}
      >
        {THEME_PREFERENCES.map((value) => (
          <RadioButton.Item
            key={value}
            value={value}
            label={THEME_LABEL[value]}
            labelVariant="bodyLarge"
            labelStyle={styles.radioLabel}
            testID={`settings-theme-${value}`}
            accessibilityLabel={`Theme: ${THEME_LABEL[value]}`}
          />
        ))}
      </RadioButton.Group>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  radioLabel: { textAlign: 'left', flexShrink: 1 },
});
