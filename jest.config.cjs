module.exports = {
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  transform: {
    // Compile TS sources and the ESM-only dependencies below to CommonJS
    // for the jest runtime.
    '^.+\\.(ts|tsx|js)$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
          allowJs: true,
          esModuleInterop: true,
          isolatedModules: true,
        },
        diagnostics: {
          // Library JS files are transpiled, not type-checked.
          exclude: ['**/node_modules/**'],
        },
      },
    ],
  },
  // jose ships ESM-only; let ts-jest transpile it instead of failing on
  // `import` statements under the CJS runtime.
  transformIgnorePatterns: ['node_modules/(?!jose/)'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // pg-boss ships ESM-only; unit tests fake the queue through the BossLike
    // seam, so the real module never needs to load under the CJS transform.
    '^pg-boss$': '<rootDir>/tests/mocks/pg-boss.ts',
  },
  testMatch: ['**/tests/**/*.test.(ts|tsx|js)'],
};
