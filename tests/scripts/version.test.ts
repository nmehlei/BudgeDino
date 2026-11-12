import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import type * as VersionModule from '../../scripts/version.cjs';

const { resolveVersion, MAX_VERSION_CODE } = createRequire(import.meta.url)(
  '../../scripts/version.cjs',
) as typeof VersionModule;

type Responses = Record<string, string | null>;

function fakeExec(responses: Responses) {
  const calls: string[] = [];
  const exec = (cmd: string, args: string[]) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    return responses[key] ?? null;
  };
  return { exec, calls };
}

const GIT = {
  'git rev-parse --short=7 HEAD': 'abc1234',
  'git rev-list --count HEAD': '94',
};

describe('resolveVersion', () => {
  it('uses GitVersion FullSemVer and the commit count as versionCode', () => {
    const { exec } = fakeExec({
      ...GIT,
      'dotnet-gitversion /output json': JSON.stringify({
        FullSemVer: '0.1.2-feat-x.92',
        ShortSha: '13e6798',
      }),
    });
    expect(resolveVersion({ env: {}, exec })).toEqual({
      version: '0.1.2-feat-x.92',
      versionCode: 94,
      commit: '13e6798',
      source: 'gitversion',
    });
  });

  it('falls back to the `gitversion` binary when the dotnet tool is missing', () => {
    const { exec } = fakeExec({
      ...GIT,
      'gitversion /output json': JSON.stringify({ FullSemVer: '1.0.0' }),
    });
    expect(resolveVersion({ env: {}, exec })).toMatchObject({
      version: '1.0.0',
      commit: 'abc1234',
    });
  });

  it('prefers CI-provided env values without running GitVersion', () => {
    const { exec, calls } = fakeExec(GIT);
    const v = resolveVersion({
      env: {
        BUDGEDINO_VERSION: '2.3.4',
        BUDGEDINO_VERSION_CODE: '1200',
        BUDGEDINO_COMMIT: 'deadbee',
      },
      exec,
    });
    expect(v).toEqual({ version: '2.3.4', versionCode: 1200, commit: 'deadbee', source: 'env' });
    expect(calls.some((c) => c.includes('gitversion'))).toBe(false);
  });

  it('ignores malformed env values and GitVersion output', () => {
    const { exec } = fakeExec({ ...GIT, 'dotnet-gitversion /output json': 'not json' });
    const v = resolveVersion({
      env: {
        BUDGEDINO_VERSION: 'latest; rm -rf /',
        BUDGEDINO_VERSION_CODE: String(MAX_VERSION_CODE + 1),
      },
      exec,
    });
    expect(v).toEqual({
      version: '0.0.0-local+abc1234',
      versionCode: 94,
      commit: 'abc1234',
      source: 'fallback',
    });
  });

  it('still produces a valid version without git or GitVersion', () => {
    const { exec } = fakeExec({});
    expect(resolveVersion({ env: {}, exec })).toEqual({
      version: '0.0.0-local+unknown',
      versionCode: 1,
      commit: 'unknown',
      source: 'fallback',
    });
  });
});
