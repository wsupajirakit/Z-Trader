// @ts-check
import js from '@eslint/js';
import pluginQuery from '@tanstack/eslint-plugin-query';
import pluginRouter from '@tanstack/eslint-plugin-router';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist', 'coverage']),
  {
    files: ['**/*.{ts,tsx,js}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      // TanStack Router's redirect() is thrown by design.
      '@typescript-eslint/only-throw-error': [
        'error',
        {
          allow: [
            {
              from: 'package',
              package: '@tanstack/router-core',
              name: 'Redirect',
            },
          ],
        },
      ],
      // Ported copy builds Thai sentences from numbers; string + number is intended.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
      // `text || fallback` deliberately treats '' as missing (as the original did).
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        { ignorePrimitives: { string: true } },
      ],
      '@typescript-eslint/restrict-plus-operands': [
        'error',
        { allowNumberAndString: true },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      pluginQuery.configs['flat/recommended'],
      pluginRouter.configs['flat/recommended'],
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/**/*.test.{ts,tsx}', 'src/test/**'],
    rules: {
      // Test doubles legitimately build partial objects and non-null fixtures.
      '@typescript-eslint/no-non-null-assertion': 'off',
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    files: ['eslint.config.js', 'vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // Plugin configs are untyped JS; type-aware rules add nothing for this file.
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
