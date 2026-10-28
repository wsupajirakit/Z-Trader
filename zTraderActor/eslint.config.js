import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';

export default [
    { ignores: ['node_modules/', 'coverage/'] },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: globals.node,
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'prefer-const': 'error',
            'no-var': 'error',
            eqeqeq: ['error', 'always'],
        },
    },
    {
        files: ['public/**/*.js'],
        languageOptions: { globals: globals.browser },
    },
    prettier,
];
