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
