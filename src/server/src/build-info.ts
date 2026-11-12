import { VERSION } from '@budgedino/shared';

/** Replaced by esbuild (`scripts/build.mjs`) with the GitVersion SemVer of the built commit. */
declare const __BUDGEDINO_VERSION__: string | undefined;

/**
 * The running server's version: the build-time GitVersion SemVer in `dist`, `BUDGEDINO_VERSION` when
 * run from source (tsx), otherwise the package placeholder.
 */
export const SERVER_VERSION: string =
  typeof __BUDGEDINO_VERSION__ === 'string'
    ? __BUDGEDINO_VERSION__
    : (process.env['BUDGEDINO_VERSION'] ?? VERSION);
