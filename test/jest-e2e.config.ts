import * as path from 'node:path';

import type { Config } from 'jest';
import { pathsToModuleNameMapper } from 'ts-jest';
import * as ts from 'typescript';

const tsconfigPath = path.resolve(process.cwd(), 'tsconfig.json');
const { compilerOptions } = ts.readConfigFile(tsconfigPath, (filePath) =>
  ts.sys.readFile(filePath),
).config as { compilerOptions: { paths: Record<string, string[]> } };

const config: Config = {
  rootDir: '..',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.e2e-spec.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, {
    prefix: '<rootDir>/',
  }),
  testEnvironment: 'node',
  testTimeout: 30000,
  /**
   * Prisma 7's WASM query compiler keeps the event loop alive briefly after the
   * app closes. `--detectOpenHandles` reports nothing actionable and the suite
   * exits cleanly when run in band, so this is worker teardown rather than a
   * leak in application code. Without it, every run ends on a "did not exit"
   * warning — noise that teaches people to ignore warnings.
   */
  forceExit: true,
};

export default config;
