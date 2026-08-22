/* eslint-env commonjs */
// @ts-check
/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  extends: ['@humeai/eslint-config/nextjs'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
};
