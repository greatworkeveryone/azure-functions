import { recentRecipientCount } from "./store";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
const db = jest.requireMock("../db") as { executeQuery: jest.Mock };

describe("recentRecipientCount", () => {
  it("counts the creator's own jobs in the window, leaving out cancelled jobs and tests to oneself (kind system)", async () => {
    db.executeQuery.mockResolvedValue([{ N: 7 }]);
    expect(await recentRecipientCount({} as never, "oid-1")).toBe(7);
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toContain("CreatedByOid = @Oid");
    expect(sql).toContain("Status <> 'cancelled'");
    expect(sql).toContain("Kind <> 'system'");
    expect(sql).toContain("UPDLOCK, HOLDLOCK");
    expect(params).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Oid", value: "oid-1" })]));
  });

  it("can be read without the lock, for showing the figure before a send", async () => {
    db.executeQuery.mockResolvedValue([{ N: 3 }]);
    expect(await recentRecipientCount({} as never, "oid-1", false)).toBe(3);
    expect(db.executeQuery.mock.calls.at(-1)[1]).not.toContain("UPDLOCK");
  });

  it("is zero when nothing is stored", async () => {
    db.executeQuery.mockResolvedValue([{ N: 0 }]);
    expect(await recentRecipientCount({} as never, "oid-1")).toBe(0);
  });
});
