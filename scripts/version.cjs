'use strict';
// Single source of the build version for the app (app.config.ts) and the server bundle (build.mjs).
// GitVersion 5.x (Mainline, see GitVersion.yml) gives every commit its own SemVer; the Android
// versionCode is the commit count, which grows with every commit on main.
//
// Order: BUDGEDINO_VERSION / BUDGEDINO_VERSION_CODE / BUDGEDINO_COMMIT (CI), then `dotnet-gitversion`
// (or `gitversion`), then a `0.0.0-local+<sha>` fallback so a machine without GitVersion still builds.
//
// CLI: `node scripts/version.cjs` prints the resolved version as JSON.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** Google Play's upper bound for versionCode. */
const MAX_VERSION_CODE = 2100000000;

/** @returns {string | null} trimmed stdout, or null when the command is missing or fails */
function defaultExec(cmd, args, cwd, timeout) {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
    });
    return out.trim();
  } catch {
    return null;
  }
}

function parseVersionCode(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n > 0 && n <= MAX_VERSION_CODE ? n : null;
}

function fromGitVersion(exec, cwd) {
  for (const cmd of ['dotnet-gitversion', 'gitversion']) {
    const json = exec(cmd, ['/output', 'json'], cwd, 60000);
    if (!json) continue;
    try {
      const data = JSON.parse(json);
      if (typeof data.FullSemVer === 'string' && SEMVER.test(data.FullSemVer)) {
        return {
          version: data.FullSemVer,
          commit: typeof data.ShortSha === 'string' ? data.ShortSha : null,
        };
      }
    } catch {
      // not JSON (e.g. an error page): try the next command, then fall back
    }
  }
  return null;
}

/**
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, exec?: typeof defaultExec }} [options]
 * @returns {{ version: string, versionCode: number, commit: string, source: 'env' | 'gitversion' | 'fallback' }}
 */
function resolveVersion(options = {}) {
  const cwd = options.cwd ?? path.join(__dirname, '..');
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;

  const gitSha = () => exec('git', ['rev-parse', '--short=7', 'HEAD'], cwd, 10000);
  const versionCode =
    parseVersionCode(env.BUDGEDINO_VERSION_CODE) ??
    parseVersionCode(exec('git', ['rev-list', '--count', 'HEAD'], cwd, 10000)) ??
    1;

  const envVersion = env.BUDGEDINO_VERSION;
  if (envVersion && SEMVER.test(envVersion)) {
    return {
      version: envVersion,
      versionCode,
      commit: env.BUDGEDINO_COMMIT || gitSha() || 'unknown',
      source: 'env',
    };
  }
  const gv = fromGitVersion(exec, cwd);
  if (gv) {
    return {
      version: gv.version,
      versionCode,
      commit: env.BUDGEDINO_COMMIT || gv.commit || gitSha() || 'unknown',
      source: 'gitversion',
    };
  }
  const commit = env.BUDGEDINO_COMMIT || gitSha() || 'unknown';
  return { version: `0.0.0-local+${commit}`, versionCode, commit, source: 'fallback' };
}

let cached = null;
/** Memoised for the default repo: app.config.ts is evaluated several times per Expo command. */
function getVersion() {
  cached ??= resolveVersion();
  return cached;
}

module.exports = { resolveVersion, getVersion, MAX_VERSION_CODE };

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(getVersion())}\n`);
}
