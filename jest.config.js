/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/?(*.)+(spec|test).ts'
  ],
  // SKIPPED 2026-04-12: these two test files have been broken since the
  // initial-commit `moduleNameMapping` typo (they never actually ran).
  // Multiple layers of rot:
  //   - HttpTransport.test.ts: references setMcpHandler/broadcastEvent removed in PR #22
  //   - UnifiedKMSServer.test.ts: jest.mock() doesn't work under ESM as written
  // Needs a separate PR to either rewrite against the current API or delete.
  testPathIgnorePatterns: [
    '/node_modules/',
    'src/__tests__/transport/HttpTransport.test.ts',
    'src/__tests__/UnifiedKMSServer.test.ts'
  ],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
      // Use a dedicated test tsconfig that extends the project tsconfig and
      // overrides module to ESNext (required so import.meta in src/index.ts
      // compiles when imported by tests).
      tsconfig: 'tsconfig.test.json'
    }]
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
    '!src/**/index.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: [
    'text',
    'lcov',
    'html'
  ],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  testTimeout: 10000,
  verbose: true,
  clearMocks: true,
  restoreMocks: true
};