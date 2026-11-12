// Bundles the server for plain Node: `node dist/main.js`, `node dist/cli.js`, `node --import ./dist/instrument.js ...`.
// Why a bundler and not tsc: the sources use bundler-style resolution (extensionless imports in
// @budgedino/shared, TypeScript path aliases), which Node cannot run unbundled. Workspace packages are
// bundled; every third-party dependency stays external and is resolved from node_modules at runtime.
import { readFileSync, rmSync, cpSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
// Every commit gets its own GitVersion SemVer (scripts/version.cjs); /health reports it.
const { getVersion } = createRequire(import.meta.url)('../../../scripts/version.cjs');
const { version } = getVersion();
const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith('@budgedino/'));

rmSync(`${root}dist`, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/main.ts', 'src/cli.ts', 'src/instrument.ts', 'src/openapi.ts'],
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  // Subpath imports such as `drizzle-orm/node-postgres` must stay external too.
  external: external.flatMap((name) => [name, `${name}/*`]),
  define: { __BUDGEDINO_VERSION__: JSON.stringify(version) },
  logLevel: 'info',
});
console.log(`server version ${version}`);
// Migrations are read from disk at startup (see db/migrate.ts).
cpSync(`${root}drizzle`, `${root}dist/drizzle`, { recursive: true });
