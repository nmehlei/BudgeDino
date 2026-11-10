export interface ResolvedVersion {
  /** GitVersion FullSemVer, e.g. `0.1.2` on main or `0.1.2-feat-x.5` on a branch. */
  version: string;
  /** Android versionCode: commit count of HEAD. */
  versionCode: number;
  /** Short commit SHA. */
  commit: string;
  source: 'env' | 'gitversion' | 'fallback';
}

export type Exec = (cmd: string, args: string[], cwd: string, timeout: number) => string | null;

export function resolveVersion(options?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  exec?: Exec;
}): ResolvedVersion;

export function getVersion(): ResolvedVersion;

export const MAX_VERSION_CODE: number;
