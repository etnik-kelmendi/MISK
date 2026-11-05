import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'dist-admin', 'coverage', 'playwright-report', 'test-results'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },
  {
    files: ['src/**/*.tsx'],
    ignores: ['src/**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXText[value=/\\p{L}/u]',
          message: 'Use a translation key instead of hardcoded text.',
        },
        {
          selector:
            "JSXAttribute[name.name=/^(aria-label|aria-description|title|alt|placeholder|label)$/][value.type='Literal']",
          message: 'Use a translation key instead of a hardcoded attribute.',
        },
      ],
    },
  },
  {
    files: ['*.{js,ts}', 'e2e/**/*.ts', ],
    languageOptions: { globals: globals.node },
  },
);
