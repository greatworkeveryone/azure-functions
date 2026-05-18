// Jest configuration.
//
// The repo's primary `npm test` script uses Node's built-in test runner
// (see package.json — `tsc && node --test dist/__tests__/*.test.js`).
//
// We expose `npx jest` as a parallel entry point. Jest runs the **compiled**
// JavaScript in `dist/__tests__/`, which means we don't need `ts-jest`,
// `babel-jest`, or any other TS transformer — the existing `tsc` build is
// the only prerequisite. Run `npm run build` (or `npx tsc`) before `npx jest`.
//
// Source .ts files are ignored so Jest doesn't try to parse them without a
// transformer. The `dist/` directory contains exactly one .test.js file per
// source test, with no shadowed copies.

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  rootDir: __dirname,
  // Only execute compiled test files. Ignoring the TS sources avoids the
  // "Cannot use import statement outside a module" parse errors and also
  // prevents Jest from running the same test twice.
  testMatch: ["<rootDir>/dist/__tests__/**/*.test.js"],
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/src/"],
};
