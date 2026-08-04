// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'eslint.config.mjs',
      'dist/**',
      'coverage/**',
      // Prisma-generated client. Not ours to lint.
      'src/generated/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  {
    // Configuration is read through the typed namespaces in src/config/, never
    // directly. Keeps a single validated, coerced source of truth for env vars.
    // See openspec/changes/add-platform-foundation/design.md, decision 1.
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Do not read process.env directly. Add the variable to src/config/env.schema.ts and read it from a typed config namespace.',
        },
      ],
    },
  },
  {
    // The config layer is where env parsing lives, and the standalone tooling
    // (Prisma CLI config, seed, scripts) runs outside the Nest container.
    files: [
      'src/config/**/*.ts',
      'prisma/**/*.ts',
      'prisma.config.ts',
      'scripts/**/*.ts',
    ],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
  {
    // Test doubles and HTTP assertion helpers are `any` by nature — supertest's
    // `res.body` chief among them. Enforcing type-safety rules here produces
    // noise, not safety.
    files: ['test/**/*.ts', 'src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
