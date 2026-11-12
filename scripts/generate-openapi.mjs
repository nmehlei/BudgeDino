// Writes docs/api/openapi.json from the built server (run `pnpm openapi`, which builds first).
// CI fails when the committed file differs from the generated one (ci/check.sh).
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { generateOpenApi } = await import(
  fileURLToPath(new URL('../src/server/dist/openapi.js', import.meta.url))
);
const target = new URL('../docs/api/openapi.json', import.meta.url);
mkdirSync(new URL('./', target), { recursive: true });
writeFileSync(target, `${JSON.stringify(await generateOpenApi(), null, 2)}\n`);
console.log('wrote docs/api/openapi.json');
