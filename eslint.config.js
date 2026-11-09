import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '.superpowers/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // Node build/maintenance scripts
    files: ['**/*.mjs'],
    languageOptions: { globals: { URL: 'readonly', console: 'readonly' } },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
