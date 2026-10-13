/// <reference types="jest" />
import type { HttpRequest } from "@azure/functions";
import type { Connection } from "tedious";
import { raiseCriticalJobEscalation, shouldRaiseCritical } from "./criticalJob";

jest.mock("./engine", () => ({ raise: jest.fn() }));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn() } }));

const { raise } = require("./engine") as { raise: jest.Mock };
const { resolveLedgerActor } = require("../ledger/actor") as { resolveLedgerActor: jest.Mock };
const { Sentry } = require("../sentry") as { Sentry: { captureException: jest.Mock } };

const connection = {} as Connection;
const request = {} as HttpRequest;
const ACTOR = { kind: "user", name: "Fay Staff", role: "facilities", userId: 8 };

beforeEach(() => {
  jest.clearAllMocks();
  resolveLedgerActor.mockResolvedValue(ACTOR);
  raise.mockResolvedValue({ created: true, escalation: {} });
});

describe("shouldRaiseCritical", () => {
  it("is true for a job that is Critical now and wasn't before", () => {
    expect(shouldRaiseCritical(null, "Critical")).toBe(true); // a new job
    expect(shouldRaiseCritical("Normal", "Critical")).toBe(true);
    expect(shouldRaiseCritical("High", "Critical")).toBe(true);
    expect(shouldRaiseCritical(undefined, "Critical")).toBe(true);
  });

  it("is false when nothing changed, or it isn't Critical", () => {
    expect(shouldRaiseCritical("Critical", "Critical")).toBe(false);
    expect(shouldRaiseCritical("Normal", "High")).toBe(false);
    expect(shouldRaiseCritical("Critical", "Low")).toBe(false);
    expect(shouldRaiseCritical("Normal", undefined)).toBe(false); // Priority wasn't in the save
    expect(shouldRaiseCritical(null, null)).toBe(false);
    expect(shouldRaiseCritical("Normal", "critical")).toBe(false); // the stored token is capitalised
  });
});

describe("raiseCriticalJobEscalation", () => {
  const args = (over: Partial<Parameters<typeof raiseCriticalJobEscalation>[0]> = {}) => ({
    connection,
    jobId: 12,
    previousPriority: "Normal",
    priority: "Critical",
    request,
    ...over,
  });

  it("raises job.critical at once, as the person who saved the job", async () => {
    await raiseCriticalJobEscalation(args());

    expect(resolveLedgerActor).toHaveBeenCalledWith(request, connection);
    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise).toHaveBeenCalledWith(connection, {
      actor: ACTOR,
      headline: "Marked Critical by Fay Staff",
      notify: { attempts: 1 },
      policyKey: "job.critical",
      subjectId: "12",
      subjectType: "job",
    });
  });

  it("raises for a newly created Critical job too", async () => {
    await raiseCriticalJobEscalation(args({ previousPriority: null }));
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it("does nothing, not even a lookup, when the job wasn't just made Critical", async () => {
    await raiseCriticalJobEscalation(args({ previousPriority: "Critical" }));
    await raiseCriticalJobEscalation(args({ priority: "High" }));
    await raiseCriticalJobEscalation(args({ priority: undefined }));

    expect(resolveLedgerActor).not.toHaveBeenCalled();
    expect(raise).not.toHaveBeenCalled();
  });

  it("can never fail the job save: errors go to the log and Sentry", async () => {
    const boom = new Error("database is busy");
    raise.mockRejectedValue(boom);
    const log = jest.fn();

    await expect(raiseCriticalJobEscalation(args({ log }))).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith("job.critical escalation for job #12 failed: database is busy");
    expect(Sentry.captureException).toHaveBeenCalledWith(boom, { extra: { jobId: 12 }, tags: { source: "job_critical_escalation" } });
  });

  it("does nothing when the caller can't be identified", async () => {
    resolveLedgerActor.mockResolvedValue(null);
    await raiseCriticalJobEscalation(args());
    expect(raise).not.toHaveBeenCalled();
  });
});
