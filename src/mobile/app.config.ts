import type { ExpoConfig } from 'expo/config';

const isDevelopment = process.env['APP_VARIANT'] === 'development';

const config: ExpoConfig = {
  name: 'BudgeDino',
  slug: 'budgedino',
  version: '0.1.0',
  scheme: 'budgedino',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  android: {
    package: 'app.budgedino',
    permissions: ['POST_NOTIFICATIONS', 'USE_BIOMETRIC'],
  },
  plugins: [
    'expo-router',
    'expo-dev-client',
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
    allowCleartext: isDevelopment,
    e2e: isDevelopment && process.env['BUDGEDINO_E2E'] === '1',
  },
  experiments: {
    typedRoutes: true,
  },
};

export default config;
