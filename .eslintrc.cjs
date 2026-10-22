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
    // ZIPP's model stack, vendored as released (scripts/vendor-zipp-models);
    // it is ZIPP's to lint, and WebGPU's globals are its own.
    'packages/@softn/core/vendor/**',
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
      // The scripts (.mjs): the build, release, bench and dev tools, and the
      // PHP host's Node runtime. They are command-line programs, so what they
      // print is their output; an empty catch is how they say "best effort";
      // a `while (true)` reads a stream until it ends; and the ones that log
      // or pass on text strip its control characters on purpose.
      files: ['**/*.mjs'],
      rules: {
        'no-console': 'off',
        'no-empty': ['error', { allowEmptyCatch: true }],
        'no-constant-condition': ['error', { checkLoops: false }],
        'no-control-regex': 'off',
      },
    },
    {
      // In the desktop Builder, Tauri's dialog plugin makes these async: they
      // return a Promise at once, which reads as yes, and asked nothing.
      // The Builder asks with utils/confirm.ts.
      files: ['apps/softn-builder/src/**/*.{ts,tsx}'],
      excludedFiles: ['**/*.test.{ts,tsx}'],
      rules: {
        'no-restricted-properties': [
          'error',
          ...['confirm', 'alert', 'prompt'].flatMap((property) => [
            { object: 'window', property, message: 'Ask with askConfirm (utils/confirm.ts): in the desktop app this is async and asks nothing.' },
            { object: 'globalThis', property, message: 'Ask with askConfirm (utils/confirm.ts): in the desktop app this is async and asks nothing.' },
          ]),
        ],
        'no-restricted-globals': [
          'error',
          ...['confirm', 'alert', 'prompt'].map((name) => ({ name, message: 'Ask with askConfirm (utils/confirm.ts): in the desktop app this is async and asks nothing.' })),
        ],
      },
    },
  ],
};
