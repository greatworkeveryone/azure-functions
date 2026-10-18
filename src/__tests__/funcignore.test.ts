/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

// What the Function App package leaves out. The starting procedures (22 KB of JSON,
// loaded by hand with npm run seed:procedures) are for the operator's machine, not
// for the running app, so they stay out of the bundle; the SQL migrations the app
// checks at startup stay in.

const lines = readFileSync(join(__dirname, "..", "..", ".funcignore"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

describe(".funcignore", () => {
  it("keeps the seed data out of the deployed package", () => {
    expect(lines).toContain("migrations/seeding/");
  });

  it("does not drop the migrations folder itself: the app reads it at startup to warn about pending files", () => {
    expect(lines).not.toContain("migrations/");
    expect(lines).not.toContain("migrations");
    expect(lines).not.toContain("*.sql");
  });
});
