/* eslint-env commonjs */
// @ts-check
/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  extends: ['@humeai/eslint-config/react'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  rules: {
    'no-console': 'off',
  },
};
