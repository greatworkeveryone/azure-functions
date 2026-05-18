// Minimal ambient declarations for Jest globals used in this repo's test files.
//
// We avoid adding `@types/jest` as a dependency — only a tiny subset of the
// Jest API is referenced (describe / test / beforeEach / afterEach), and these
// are provided by Jest at runtime when `npx jest` runs the compiled suites.
//
// The npm `test` script still uses Node's built-in test runner; that runner
// also injects compatible globals when invoked with `node --test`.

declare function describe(name: string, fn: () => void): void;

interface TestFn {
  (name: string, fn?: () => void | Promise<void>): void;
  todo: (name: string) => void;
  skip: (name: string, fn?: () => void | Promise<void>) => void;
}
declare const test: TestFn;
declare const it: TestFn;

declare function beforeEach(fn: () => void | Promise<void>): void;
declare function afterEach(fn: () => void | Promise<void>): void;
declare function beforeAll(fn: () => void | Promise<void>): void;
declare function afterAll(fn: () => void | Promise<void>): void;
