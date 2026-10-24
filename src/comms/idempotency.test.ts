import { findJobByKey, stripKeyMarker, takeKeyLock, withKeyMarker } from "./idempotency";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const conn = {} as never;
const KEY = "0b9a7c5e-3f2d-4a61-9d1e-5c7b8a2f4e10";

beforeEach(() => jest.resetAllMocks());

describe("the key marker", () => {
  it("rides on the end of an event's detail and comes off again for the screen", () => {
    const stored = withKeyMarker("21 recipients, over 20: waits for a manager", KEY);
    expect(stored).toBe(`21 recipients, over 20: waits for a manager key=${KEY}`);
    expect(stripKeyMarker(stored)).toBe("21 recipients, over 20: waits for a manager");
  });

  it("adds nothing without a key and leaves other details and nulls alone", () => {
    expect(withKeyMarker("2 recipients", null)).toBe("2 recipients");
    expect(stripKeyMarker("2 recipients")).toBe("2 recipients");
    expect(stripKeyMarker(null)).toBeNull();
  });
});

describe("takeKeyLock", () => {
  it("takes a transaction-scoped lock named by a hash of the person and key, never the key itself", async () => {
    db.executeQuery.mockResolvedValue([{ Result: 0 }]);
    expect(await takeKeyLock(conn, "oid-1", KEY)).toBe(true);
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toContain("@LockOwner = 'Transaction'");
    expect(params[0].value).toMatch(/^queueCorrespondence:[0-9a-f]{64}$/);
    expect(params[0].value).not.toContain(KEY);
    await takeKeyLock(conn, "oid-2", KEY);
    expect(db.executeQuery.mock.calls[1][2][0].value).not.toBe(params[0].value);
  });

  it("says no when the lock times out", async () => {
    db.executeQuery.mockResolvedValue([{ Result: -1 }]);
    expect(await takeKeyLock(conn, "oid-1", KEY)).toBe(false);
  });
});

describe("findJobByKey", () => {
  it("looks only at this person's recent jobs, with the key compared exactly and as a parameter", async () => {
    db.executeQuery.mockResolvedValue([{ CorrespondenceId: 41 }]);
    expect(await findJobByKey(conn, "oid-1", KEY)).toBe(41);
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toContain("c.CreatedByOid = @Oid");
    expect(sql).toContain("COLLATE Latin1_General_100_BIN2");
    expect(sql).not.toContain(KEY);
    expect(Object.fromEntries(params.map((p: { name: string; value: unknown }) => [p.name, p.value]))).toMatchObject({ Oid: "oid-1", Tail: ` key=${KEY}`, Length: ` key=${KEY}`.length });
  });

  it("returns null when no job was made with it", async () => {
    db.executeQuery.mockResolvedValue([]);
    expect(await findJobByKey(conn, "oid-1", KEY)).toBeNull();
  });
});
