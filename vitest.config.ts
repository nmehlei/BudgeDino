import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Vitest 4+ replaced `vitest.workspace.ts` with `test.projects`.
const alias = {
  '@budgedino/shared': fileURLToPath(new URL('./src/shared/src/index.ts', import.meta.url)),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/**/*.int.test.ts', 'src/**/*.int.test.ts'],
        },
      },
    ],
  },
});
