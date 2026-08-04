import * as path from 'node:path';

import type { Config } from 'jest';
import { pathsToModuleNameMapper } from 'ts-jest';
import * as ts from 'typescript';

/**
 * Aliases are derived from tsconfig rather than restated here, so there is
 * exactly one place to change them. See design.md decision 9.
 *
 * Read via the TypeScript API rather than `import ... from './tsconfig.json'`:
 * the config file is loaded as ESM, where a JSON import needs an import
 * attribute, and readConfigFile also tolerates comments in the tsconfig.
 *
 * ---------------------------------------------------------------------------
 * `NODE_OPTIONS=--experimental-vm-modules` in the `test*` package scripts is
 * LOAD-BEARING, not incidental. `better-auth` is ESM-only (`"type": "module"`,
 * no `require` condition in its exports), while ts-jest compiles our tests to
 * CommonJS. Node's own `require(esm)` would bridge that, but Jest's module
 * registry intercepts the require and never reaches it — so without the flag,
 * any test that imports the auth module fails at import time with
 * `SyntaxError: Cannot use import statement outside a module`.
 *
 * `src/modules/auth/better-auth-esm.spec.ts` is the regression guard. Do not
 * drop the flag from a `test*` script. See design.md decision 1.
 * ---------------------------------------------------------------------------
 */
const tsconfigPath = path.resolve(process.cwd(), 'tsconfig.json');
const { compilerOptions } = ts.readConfigFile(tsconfigPath, (filePath) =>
  ts.sys.readFile(filePath),
).config as { compilerOptions: { paths: Record<string, string[]> } };

const config: Config = {
  rootDir: '.',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/src/generated/'],
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, {
    prefix: '<rootDir>/',
  }),
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coveragePathIgnorePatterns: ['/node_modules/', '/src/generated/'],
  coverageDirectory: 'coverage',
  testEnvironment: 'node',
};

export default config;
