import Constants from 'expo-constants';

/** True only in the development variant (baked in by app.config.ts); release builds require https. */
export function allowCleartext(): boolean {
  return Constants.expoConfig?.extra?.['allowCleartext'] === true;
}
