module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // pg-boss ships ESM-only; unit tests fake the queue through the BossLike
    // seam, so the real module never needs to load under the CJS transform.
    '^pg-boss$': '<rootDir>/tests/mocks/pg-boss.ts',
  },
  testMatch: ['**/tests/**/*.test.(ts|tsx|js)'],
};
