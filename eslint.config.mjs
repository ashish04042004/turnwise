import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', 'docs/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true, caughtErrors: 'none' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
    },
  },
  {
    files: ['server/**/*.js', 'e2e/**/*.mjs', '*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['web/**/*.{js,jsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    ...reactHooks.configs.flat['recommended-latest'],
  },
];
