/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- Expo config plugin (CommonJS, runs in Node) */
const { withAndroidStyles, AndroidConfig } = require('expo/config-plugins');

/**
 * Opts the Android app theme out of OS force-dark (Samsung One UI, Android 10+ "force dark"), so
 * the app's own light/dark theme is the only one applied. Re-applied on every `expo prebuild`.
 */
module.exports = function withNoForceDark(config) {
  return withAndroidStyles(config, (cfg) => {
    cfg.modResults = AndroidConfig.Styles.assignStylesValue(cfg.modResults, {
      add: true,
      parent: AndroidConfig.Styles.getAppThemeGroup(),
      name: 'android:forceDarkAllowed',
      value: 'false',
    });
    return cfg;
  });
};
