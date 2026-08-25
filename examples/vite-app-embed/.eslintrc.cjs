module.exports = {
  root: true,
  env: { es2020: true },
  extends: ['@humeai/eslint-config/react'],
  ignorePatterns: ['dist'],
  parserOptions: {
    project: ['./tsconfig.json', './tsconfig.node.json'],
    tsconfigRootDir: __dirname,
  },
  plugins: ['react-refresh'],
  overrides: [
    {
      files: ['vite.config.ts'],
      rules: {
        'import/no-extraneous-dependencies': [
          'error',
          { devDependencies: true, optionalDependencies: false },
        ],
      },
    },
  ],
  rules: {
    'no-console': 'off',
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
};
