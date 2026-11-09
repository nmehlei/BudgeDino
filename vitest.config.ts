import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Vitest 4+ replaced `vitest.workspace.ts` with `test.projects`.
const alias = {
  '@budgedino/shared': fileURLToPath(new URL('./src/shared/src/index.ts', import.meta.url)),
  '@budgedino/server': fileURLToPath(new URL('./src/server/src', import.meta.url)),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
          exclude: [
            '**/*.int.test.ts',
            '**/*.e2e.test.ts',
            '**/*.build.test.ts',
            '**/node_modules/**',
          ],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'e2e',
          include: ['tests/**/*.e2e.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        // Runs against `pnpm build` output (src/server/dist), with plain Node.
        resolve: { alias },
        test: { name: 'build', include: ['tests/**/*.build.test.ts'], testTimeout: 30_000 },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          maxWorkers: 3,
          include: ['tests/**/*.int.test.ts', 'src/**/*.int.test.ts'],
        },
      },
    ],
  },
});
