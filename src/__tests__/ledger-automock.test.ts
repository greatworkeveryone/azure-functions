/// <reference types="jest" />
// Packages that ledger a decision test their handlers with jest.mock("../ledger")
// instead of asserting on storage (PLAN §5), and their tests must keep passing
// now that record() writes to the database. Jest builds the automock by loading
// the real module, so this also proves loading it needs no database or config.
import type { Connection } from "tedious";
import { record } from "../ledger";

jest.mock("../ledger");

describe("jest.mock('../ledger')", () => {
  it("replaces record() and leaves the caller's handler free of any database", async () => {
    expect(jest.isMockFunction(record)).toBe(true);

    // An automocked async function returns undefined, which `await` accepts.
    const result = await record({} as Connection, {
      action: "user.role_change",
      actor: { kind: "user", name: "Ada Admin", role: "admin", userId: 3 },
      subject: { id: 7, type: "app_user" },
    });

    expect(result).toBeUndefined();
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("lets a test make the ledger fail, to prove its decision rolls back", async () => {
    jest.mocked(record).mockRejectedValueOnce(new Error("ledger unavailable"));

    await expect(
      record({} as Connection, {
        action: "approval_limit.change",
        actor: { kind: "system", name: "test" },
        subject: { id: "accounts", type: "approval_limit" },
      }),
    ).rejects.toThrow("ledger unavailable");
  });
});
