/// <reference types="jest" />
// The schedule change adapter (WP26c) and the helper that raises and ends the
// ratification escalation.
import { TYPES } from "tedious";
import { getAdapter, registeredSubjectTypes } from "./registry";
import { scheduleChangeAdapter } from "./scheduleChange";
import "./index";

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../../sentry", () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock("../engine", () => ({ ...jest.requireActual("../engine"), concludeForSubject: jest.fn(), raise: jest.fn() }));

const db = require("../../db") as { executeQuery: jest.Mock };
const engine = require("../engine") as { concludeForSubject: jest.Mock; raise: jest.Mock };
const { Sentry } = require("../../sentry") as { Sentry: { captureException: jest.Mock } };
const { EscalationError } = jest.requireActual("../errors") as typeof import("../errors");
const { raiseRatification, settleRatification } = require("../../scheduleChange/escalation") as typeof import("../../scheduleChange/escalation");

const row = (over: Record<string, unknown> = {}) => ({
  BuildingId: 5,
  BuildingName: "Tower A",
  Kind: "relief",
  LegalName: "Acme Pty Ltd",
  Payload: JSON.stringify({ from: "2026-11-01", kind: "percent", scope: ["rent"], to: "2027-01-31", value: 50 }),
  RequestId: "req-1",
  RequestedByName: "Ann Accounts",
  State: "pending",
  TenantId: 7,
  TradingName: null,
  ...over,
});
const connection = {} as never;
const actor = { kind: "user" as const, name: "Ann Accounts", role: "accounts", userId: 7 };

beforeEach(() => jest.clearAllMocks());

describe("the schedule change adapter", () => {
  it("is registered for schedule_change", () => {
    expect(registeredSubjectTypes()).toEqual(expect.arrayContaining(["schedule_change"]));
    expect(getAdapter("schedule_change")).toBe(scheduleChangeAdapter);
  });

  it("describes the request with its relief, tenancy and building", async () => {
    db.executeQuery.mockResolvedValueOnce([row()]);
    const summary = await scheduleChangeAdapter.loadSummary(connection, "req-1");
    expect(summary).toEqual({
      buildingId: 5,
      context: { buildingName: "Tower A", from: "2026-11-01", kind: "relief", requestedByName: "Ann Accounts", requestId: "req-1", tenantId: 7, tenantName: "Acme Pty Ltd", to: "2027-01-31" },
      summary: "Rent relief: 50% off the rent, 01/11/2026 to 31/01/2027 · Acme Pty Ltd · Tower A",
    });
    expect(db.executeQuery.mock.calls[0][2]).toEqual([{ name: "RequestId", type: TYPES.NVarChar, value: "req-1" }]);
  });

  it("knows no subject for a request that doesn't exist or an id that can't be one", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    expect(await scheduleChangeAdapter.loadSummary(connection, "req-1")).toBeNull();
    expect(await scheduleChangeAdapter.loadSummary(connection, "not an id!")).toBeNull();
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
  });

  it("holds only while the request waits for a director", async () => {
    db.executeQuery.mockResolvedValueOnce([row()]).mockResolvedValueOnce([row({ State: "ratified" })]);
    const ref = { policyKey: "schedule.change_ratification", subjectId: "req-1", subjectType: "schedule_change" };
    expect(await scheduleChangeAdapter.isConditionActive(connection, ref, new Date())).toBe(true);
    expect(await scheduleChangeAdapter.isConditionActive(connection, ref, new Date())).toBe(false);
  });

  it("links to the change, scopes the ledger to the tenancy, shows it to tenancy readers, and can't be withdrawn by hand", () => {
    expect(scheduleChangeAdapter.deepLink("req 1")).toBe("/tenancy/changes/req%201");
    expect(scheduleChangeAdapter.ledgerScope?.({ context: { tenantId: 7 }, subjectId: "req-1" })).toEqual({ tenantId: 7 });
    const viewer = (roles: string[]) => ({ name: "x", roles, userId: 1 });
    expect(scheduleChangeAdapter.visibleTo(viewer(["cfo"]), { policyKey: "", subjectId: "", subjectType: "" })).toBe(true);
    expect(scheduleChangeAdapter.visibleTo(viewer(["facilities_manager"]), { policyKey: "", subjectId: "", subjectType: "" })).toBe(false);
    expect(scheduleChangeAdapter.withdrawable?.({ kind: "authority", policyKey: "schedule.change_ratification" })).toBe(false);
  });
});

describe("raising and ending the ratification", () => {
  it("raises schedule.change_ratification on the request", async () => {
    engine.raise.mockResolvedValueOnce({ created: true, escalation: { escalationId: 3 } });
    expect(await raiseRatification(connection, { actor, headline: "Asked by Ann", requestId: "req-1" })).toEqual({ escalationId: 3 });
    expect(engine.raise).toHaveBeenCalledWith(connection, { actor, headline: "Asked by Ann", policyKey: "schedule.change_ratification", subjectId: "req-1", subjectType: "schedule_change" });
  });

  it("lets the request wait without it when the policy is off, and reports any other failure", async () => {
    const log = jest.fn();
    engine.raise.mockRejectedValueOnce(new EscalationError("policy_inactive", "off"));
    expect(await raiseRatification(connection, { actor, headline: "x", log, requestId: "req-1" })).toBeNull();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    engine.raise.mockRejectedValueOnce(new Error("db down"));
    expect(await raiseRatification(connection, { actor, headline: "x", log, requestId: "req-1" })).toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("raising the ratification on request req-1 failed: db down"));
  });

  it("ends it with the decision, withdrawing an unacknowledged one when the asker takes it back; never throws", async () => {
    engine.concludeForSubject.mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]).mockRejectedValueOnce(new Error("busy"));
    expect(await settleRatification(connection, { actor, code: "ratified", note: null, requestId: "req-1" })).toBe(1);
    expect(engine.concludeForSubject).toHaveBeenLastCalledWith(connection, expect.objectContaining({ code: "ratified", policyKeys: ["schedule.change_ratification"], subjectType: "schedule_change", withdrawOpen: false }));
    expect(await settleRatification(connection, { actor, code: "withdrawn", note: "found the money", requestId: "req-1", withdrawn: true })).toBe(1);
    expect(engine.concludeForSubject).toHaveBeenLastCalledWith(connection, expect.objectContaining({ note: "found the money", withdrawOpen: true }));
    expect(await settleRatification(connection, { actor, code: "rejected", note: "no", requestId: "req-1" })).toBe(0);
  });
});
