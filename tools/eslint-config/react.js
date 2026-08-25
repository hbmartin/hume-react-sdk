/* eslint-env commonjs */
// @ts-check
// Resolve the plugins declared below from this package's own dependencies,
// so consumers only need eslint + this config (not every plugin).
require('@rushstack/eslint-patch/modern-module-resolution');

/** @type {import('eslint').Linter.Config} */
module.exports = {
  plugins: ['react', 'react-hooks'],
  extends: [
    require.resolve('./base.js'),
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  settings: {
    react: {
      version: 'detect',
    },
  },
  rules: {
    'react-hooks/exhaustive-deps': 'error',
  },
};
