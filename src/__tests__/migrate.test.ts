/// <reference types="jest" />
import { pendingFrom, startupMigrationMode } from "../migrate";

describe("startupMigrationMode", () => {
  it("only checks in production by default — the app principal has no DDL rights", () => {
    expect(startupMigrationMode({ AZURE_FUNCTIONS_ENVIRONMENT: "Production" })).toBe("check");
  });

  it("applies in production only when explicitly opted in", () => {
    expect(
      startupMigrationMode({ AZURE_FUNCTIONS_ENVIRONMENT: "Production", RUN_MIGRATIONS_ON_STARTUP: "true" }),
    ).toBe("apply");
    expect(
      startupMigrationMode({ AZURE_FUNCTIONS_ENVIRONMENT: "Production", RUN_MIGRATIONS_ON_STARTUP: "yes" }),
    ).toBe("check");
  });

  it("applies against the local Docker DB", () => {
    expect(startupMigrationMode({ LOCAL_SQL: "true" })).toBe("apply");
  });

  it("skips everywhere else", () => {
    expect(startupMigrationMode({})).toBe("skip");
    expect(startupMigrationMode({ AZURE_FUNCTIONS_ENVIRONMENT: "Development" })).toBe("skip");
  });
});

describe("pendingFrom", () => {
  it("returns files not yet recorded, in file order", () => {
    const files = ["071_a.sql", "072_b.sql", "073_c.sql", "074_d.sql"];
    expect(pendingFrom(files, new Set(["071_a.sql", "073_c.sql"]))).toEqual(["072_b.sql", "074_d.sql"]);
  });

  it("returns nothing when everything is recorded", () => {
    expect(pendingFrom(["001_a.sql"], new Set(["001_a.sql"]))).toEqual([]);
  });
});
