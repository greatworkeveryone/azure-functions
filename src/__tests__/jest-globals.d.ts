// Ambient declarations for Jest globals used in this repo's test files.
//
// Most suites in __tests__/ use Node's built-in `assert` and only need the
// describe/it/beforeEach/afterEach globals declared below. Newer Jest-style
// suites (search.test.ts, searchUtils.test.ts) also reference `expect` and
// the `jest` mocking API — those types come in via `/// <reference>` to the
// installed `@types/jest` package, which we don't list in the tsconfig
// `types` array so it stays scoped to test files only.

/// <reference types="jest" />

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
