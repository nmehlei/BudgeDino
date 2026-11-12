import Constants from 'expo-constants';

export interface BuildInfo {
  /** GitVersion SemVer of the commit this build was made from (scripts/version.cjs). */
  version: string;
  /** Android versionCode (commit count), null when unknown. */
  versionCode: number | null;
  /** Short commit SHA, null when unknown. */
  commit: string | null;
}

type ExpoConfigLike =
  | {
      version?: string;
      android?: { versionCode?: number };
      extra?: Record<string, unknown>;
    }
  | null
  | undefined;

export function buildInfoFrom(config: ExpoConfigLike): BuildInfo {
  const commit = config?.extra?.['commit'];
  return {
    version: config?.version ?? 'unknown',
    versionCode: config?.android?.versionCode ?? null,
    commit: typeof commit === 'string' && commit !== 'unknown' ? commit : null,
  };
}

export function getBuildInfo(): BuildInfo {
  return buildInfoFrom(Constants.expoConfig);
}
