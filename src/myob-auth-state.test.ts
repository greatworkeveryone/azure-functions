/// <reference types="jest" />

jest.mock("./db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
}));

import { createHash } from "crypto";
import { consumeAuthState, createAuthState, STATE_TTL_SECONDS } from "./myob-auth-state";

const db = require("./db") as { closeConnection: jest.Mock; executeQuery: jest.Mock };
const params = (call: unknown[]) =>
  Object.fromEntries((call[2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value]));

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockResolvedValue([]);
});

describe("createAuthState", () => {
  it("stores only a hash of the state, with the admin who started and a 10-minute expiry", async () => {
    const state = await createAuthState({ name: "Will Admin", oid: "admin-oid" });

    const [call] = db.executeQuery.mock.calls;
    const stored = params(call);
    expect(String(call[1])).toMatch(/INSERT INTO dbo\.MyobAuthStates/);
    expect(stored.StateHash).toBe(createHash("sha256").update(state).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(state);
    expect(stored).toMatchObject({ Name: "Will Admin", Oid: "admin-oid", TtlSeconds: STATE_TTL_SECONDS });
    expect(STATE_TTL_SECONDS).toBe(600);
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("makes a different, unguessable state each time", async () => {
    const a = await createAuthState({ name: "A", oid: "a" });
    const b = await createAuthState({ name: "A", oid: "a" });
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
  });
});

describe("consumeAuthState", () => {
  it("marks the state used in one statement and returns who started it", async () => {
    db.executeQuery.mockResolvedValueOnce([{ StartedByName: "Will Admin", StartedByOid: "admin-oid" }]);

    await expect(consumeAuthState("the-state")).resolves.toEqual({ name: "Will Admin", oid: "admin-oid" });

    const sql = String(db.executeQuery.mock.calls[0][1]);
    expect(sql).toMatch(/SET ConsumedAt = SYSUTCDATETIME\(\)/);
    expect(sql).toMatch(/ConsumedAt IS NULL AND ExpiresAt > SYSUTCDATETIME\(\)/);
    expect(params(db.executeQuery.mock.calls[0]).StateHash).toBe(createHash("sha256").update("the-state").digest("hex"));
  });

  it("returns null for a state that is reused, expired or unknown (the UPDATE matches nothing)", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    await expect(consumeAuthState("used-state")).resolves.toBeNull();
  });

  it("returns null without touching the database for an empty or oversized state", async () => {
    await expect(consumeAuthState("")).resolves.toBeNull();
    await expect(consumeAuthState("x".repeat(201))).resolves.toBeNull();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});
