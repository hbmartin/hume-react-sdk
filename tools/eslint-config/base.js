/* eslint-env commonjs */
// @ts-check
// Resolve the plugins declared below from this package's own dependencies,
// so consumers only need eslint + this config (not every plugin).
require('@rushstack/eslint-patch/modern-module-resolution');

/** @type {import('eslint').Linter.Config} */
module.exports = {
  plugins: ['import', '@typescript-eslint', 'prettier', 'compat'],
  extends: ['eslint:recommended', 'prettier', 'plugin:compat/recommended'],
  parser: '@typescript-eslint/parser',
  env: {
    browser: true,
  },
  overrides: [
    {
      files: ['*.test.ts', '*.test.tsx'],
      rules: {
        'no-console': 'off',
        'no-restricted-syntax': [
          'error',
          {
            selector:
              "CallExpression[callee.object.name=/^(describe|it|test)$/][callee.property.name='only']",
            message: 'Remove `.only` before committing so the whole suite runs.',
          },
        ],
      },
    },
    {
      files: ['*.ts', '*.tsx'],
      extends: [
        'airbnb-typescript/base',
        'plugin:@typescript-eslint/recommended',
        'plugin:@typescript-eslint/recommended-requiring-type-checking',
        // re-apply prettier last so it disables the formatting rules that
        // airbnb/@typescript-eslint re-enabled inside this override
        'prettier',
      ],
      rules: {
        'no-unused-vars': 'off',
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/dot-notation': 'off',
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
            ignoreRestSiblings: true,
          },
        ],
        '@typescript-eslint/no-use-before-define': [2, { functions: false }],
        '@typescript-eslint/naming-convention': [
          'error',
          {
            selector: 'variable',
            format: ['PascalCase', 'camelCase', 'UPPER_CASE'],
            leadingUnderscore: 'allow',
            trailingUnderscore: 'allow',
          },
        ],
        '@typescript-eslint/no-non-null-assertion': 'error',
        'import/extensions': 'off',
      },
    },
  ],
  rules: {
    'arrow-body-style': 'off',
    eqeqeq: 'error',
    'no-console': 'warn',
    'no-debugger': 'error',
    'no-nested-ternary': 'error',
    'prettier/prettier': 'error',
    'import/no-unresolved': 'off',
    'no-void': 'off',
    'sort-imports': [
      'error',
      {
        ignoreCase: true,
        ignoreDeclarationSort: true,
      },
    ],
    'import/order': [
      'error',
      {
        alphabetize: {
          order: 'asc',
          caseInsensitive: true,
        },
        groups: [
          //
          ['external', 'builtin'],
          ['internal'],
          ['index', 'sibling', 'parent'],
        ],
        pathGroupsExcludedImportTypes: ['builtin'],
        'newlines-between': 'always',
      },
    ],
  },
};
