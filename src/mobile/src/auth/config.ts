import Constants from 'expo-constants';

/**
 * True only in a development (`__DEV__`) JS bundle whose `extra.allowCleartext` was set by the
 * development variant (app.config.ts, from the Metro process env). A release bundle is never
 * `__DEV__`, so release builds always require https.
 */
export function allowCleartext(): boolean {
  return __DEV__ && Constants.expoConfig?.extra?.['allowCleartext'] === true;
}
