import type { ExpoConfig } from 'expo/config';

import { getVersion } from '../../scripts/version.cjs';

const isDevelopment = process.env['APP_VARIANT'] === 'development';

// GitVersion 5.x Mainline: every commit has its own version; versionCode is the commit count.
const build = getVersion();

/** Brand colours of the splash screen (light = accent, dark = the dark theme background). */
const SPLASH_LIGHT = '#2E7D6B';
const SPLASH_DARK = '#0E1311';

const config: ExpoConfig = {
  name: 'BudgeDino',
  slug: 'budgedino',
  version: build.version,
  scheme: 'budgedino',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  icon: './assets/icon.png',
  android: {
    package: 'app.budgedino',
    versionCode: build.versionCode,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      monochromeImage: './assets/adaptive-icon-monochrome.png',
      backgroundColor: SPLASH_LIGHT,
    },
    permissions: ['POST_NOTIFICATIONS', 'USE_BIOMETRIC'],
  },
  plugins: [
    'expo-router',
    './plugins/with-no-force-dark',
    'expo-dev-client',
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 220,
        resizeMode: 'contain',
        backgroundColor: SPLASH_LIGHT,
        dark: { image: './assets/splash-icon.png', backgroundColor: SPLASH_DARK },
      },
    ],
    'expo-secure-store',
    'expo-background-task',
    'expo-notifications',
    ['expo-local-authentication', { faceIDPermission: false }],
    // Cleartext HTTP (LAN dev server) only in development builds; release builds require HTTPS.
    ['expo-build-properties', { android: { usesCleartextTraffic: isDevelopment } }],
  ],
  // Read by src/auth/config.ts: http:// server URLs are accepted only when this is true.
  // `e2e` only has effect in the development variant (see src/security/e2e.ts); release builds ignore it.
  extra: {
    commit: build.commit,
    allowCleartext: isDevelopment,
    e2e: isDevelopment && process.env['BUDGEDINO_E2E'] === '1',
  },
  experiments: {
    typedRoutes: true,
  },
};

export default config;
