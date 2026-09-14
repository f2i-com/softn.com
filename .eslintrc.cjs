module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'prettier',
  ],
  ignorePatterns: [
    'dist',
    'dist-desktop',
    'node_modules',
    '*.config.js',
    '*.config.ts',
    'target',
    // wasm-bindgen output — generated, and its own eslint-disable header
    // trips `reportUnusedDisableDirectives`.
    'packages/@softn/core/wasm-zipp/**',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true,
    },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  settings: {
    react: {
      version: 'detect',
    },
  },
  rules: {
    // React
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',

    // TypeScript
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',

    // General
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'prefer-const': 'error',
    'no-var': 'error',
  },
  overrides: [
    {
      // Tests narrate what they do and poke at shapes a type would only get
      // in the way of; the two rules that make `lint` fail the tree were,
      // by count, mostly here (about 120 of 223 warnings).
      files: ['**/*.test.{ts,tsx,mjs}', '**/test/**', '**/tests/**', 'e2e/**'],
      rules: {
        'no-console': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
    {
      // A command-line tool talks through the console; that is its output.
      files: ['packages/@softn/core/src/bundle/cli.ts'],
      rules: { 'no-console': 'off' },
    },
  ],
};
