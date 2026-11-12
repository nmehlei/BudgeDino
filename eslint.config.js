import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '.superpowers/**',
      'src/mobile/android/**',
      'src/mobile/ios/**',
      'src/mobile/.expo/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // Node build/maintenance scripts
    files: ['**/*.mjs'],
    languageOptions: { globals: { URL: 'readonly', console: 'readonly' } },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Expo app (React Native)
    files: ['src/mobile/**/*.ts', 'src/mobile/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { __DEV__: 'readonly' } },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Expo/Metro/Babel/Jest config files are CommonJS
    files: ['src/mobile/*.js', '**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
