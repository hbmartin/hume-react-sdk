/* eslint-env commonjs */
// @ts-check
/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  extends: [
    '@humeai/eslint-config/base',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  settings: {
    react: {
      version: 'detect',
    },
  },
  rules: {
    'no-console': 'off',
  },
};
