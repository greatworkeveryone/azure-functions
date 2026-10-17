/// <reference types="jest" />
// The parts of the request store that are not just SQL text: what is read back
// from a row, and what an insert sends. The SQL itself is checked against the
// migration (migration-137-job-decision-requests.test.ts) and against a real
// SQL Server before it merged.
import { TYPES, type Connection } from "tedious";
import { insertRequest, toRequestRow, type NewRequest } from "./store";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));

const db = require("../db") as { executeQuery: jest.Mock };

const NEW: NewRequest = {
  assignmentMode: "named",
  autoEscalate: true,
  decisionMakers: { role: null, userIds: [3] },
  jobId: 12,
  question: "Pay it?",
  requestedBy: "Alana",
  requestedByUserId: 9,
  respondBy: new Date("2026-10-13T07:30:00Z"),
  routineWeeks: null,
  sourceAttachmentId: null,
  tier: "urgent",
};

describe("insertRequest", () => {
  beforeEach(() => {
    db.executeQuery.mockReset();
    db.executeQuery.mockResolvedValue([{ RequestId: 7 }]);
  });

  it.each([true, false])("sends AutoEscalate = %s as a bit, in the column the table has", async (autoEscalate) => {
    const id = await insertRequest({} as Connection, { ...NEW, autoEscalate });

    expect(id).toBe(7);
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toMatch(/RoutineWeeks, AutoEscalate, SourceAttachmentId/);
    expect(sql).toContain("@AutoEscalate");
    expect(params).toContainEqual({ name: "AutoEscalate", type: TYPES.Bit, value: autoEscalate });
  });

  it("sends a parameter for every placeholder in the statement, and no more", async () => {
    await insertRequest({} as Connection, NEW);

    const [, sql, params] = db.executeQuery.mock.calls[0];
    const placeholders = [...String(sql).matchAll(/@(\w+)/g)].map((m) => m[1]).sort();
    expect((params as { name: string }[]).map((p) => p.name).sort()).toEqual(placeholders);
  });
});

describe("toRequestRow", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    AssignmentMode: "named",
    AutoEscalate: true,
    DecisionMakers: '{"role":null,"userIds":[3]}',
    JobId: 12,
    Question: "Pay it?",
    RequestId: 7,
    RequestedAt: new Date("2026-10-12T00:30:00Z"),
    RequestedBy: "Alana",
    RequestedByUserId: 9,
    RespondBy: new Date("2026-10-13T07:30:00Z"),
    RoutineWeeks: null,
    RowVersion: Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]),
    SourceAttachmentId: null,
    State: "pending",
    Tier: "urgent",
    WithdrawnAt: null,
    WithdrawnBy: null,
    WithdrawnByUserId: null,
    WithdrawnReason: null,
    ...over,
  });

  it("reads AutoEscalate as a boolean", () => {
    expect(toRequestRow(raw({ AutoEscalate: true })).autoEscalate).toBe(true);
    expect(toRequestRow(raw({ AutoEscalate: false })).autoEscalate).toBe(false);
  });

  it("reads a missing or null AutoEscalate as not moving up, never as moving up", () => {
    expect(toRequestRow(raw({ AutoEscalate: null })).autoEscalate).toBe(false);
    expect(toRequestRow(raw({ AutoEscalate: undefined })).autoEscalate).toBe(false);
  });
});
