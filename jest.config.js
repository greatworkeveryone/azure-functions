// Unit tests must not inherit the desktop shell's NODE_ENV=development.
process.env.NODE_ENV = "test";

/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  maxWorkers: 2,
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "js"],
  globals: {
    "ts-jest": {},
  },
};
