/* eslint-env commonjs */
// @ts-check
// Resolve the plugins declared below from this package's own dependencies,
// so consumers only need eslint + this config (not every plugin).
require('@rushstack/eslint-patch/modern-module-resolution');

/** @type {import('eslint').Linter.Config} */
module.exports = {
  plugins: ['react', 'react-hooks', 'jsx-a11y'],
  extends: [
    require.resolve('./base.js'),
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
    'plugin:jsx-a11y/strict',
    'plugin:@next/next/core-web-vitals',
    'plugin:tailwindcss/recommended',
  ],
  settings: {
    react: {
      version: 'detect',
    },
    'import/resolver': {
      node: {
        extensions: ['.mjs', '.js', '.jsx', '.json', '.ts', '.tsx', '.d.ts'],
      },
    },
    tailwindcss: {
      config: 'tailwind.config.ts',
      callees: ['classnames', 'cn', 'cva'],
      cssFiles: [
        // load valid classnames from css files
        '**/*.css',
        '!**/node_modules',
      ],
    },
  },
  overrides: [
    // Next.js route files (and config files) must use default exports;
    // ban default exports everywhere else.
    {
      files: ['*.ts', '*.tsx'],
      excludedFiles: [
        'app/**',
        'src/app/**',
        'pages/**',
        'src/pages/**',
        'middleware.ts',
        '*.config.ts',
        'next-env.d.ts',
      ],
      rules: {
        'import/no-default-export': 'error',
      },
    },
  ],
  rules: {
    'react/jsx-filename-extension': ['error', { extensions: ['.jsx', '.tsx'] }],
    'react/jsx-key': [
      'error',
      {
        checkFragmentShorthand: true,
      },
    ],
    'react/prop-types': 'off',
    'react/jsx-props-no-spreading': 'off',
    'react/hook-use-state': 'error',
    'react/jsx-no-leaked-render': 'error',
    'jsx-a11y/label-has-associated-control': [
      2,
      {
        labelComponents: ['Label'],
        labelAttributes: ['label', 'aria-label'],
        controlComponents: [
          'Input',
          'Select',
          'Textarea',
          'Checkbox',
          'Radio',
          'Switch',
        ],
        depth: 3,
      },
    ],
    // cspell:ignore classname
    'tailwindcss/no-custom-classname': 'error',
  },
};
