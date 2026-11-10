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
  },
  plugins: [
    'expo-router',
    'expo-dev-client',
    'expo-secure-store',
    // Cleartext HTTP (LAN dev server) only in development builds; release builds require HTTPS.
    ['expo-build-properties', { android: { usesCleartextTraffic: isDevelopment } }],
  ],
  experiments: {
    typedRoutes: true,
  },
};

export default config;
