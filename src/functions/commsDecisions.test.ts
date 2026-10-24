import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import * as events from "../comms/events";
import * as userStore from "../comms/userSignatureStore";
import * as jobStore from "../comms/store";
import type { JobRow } from "../comms/types";
import { record } from "../ledger";
import { approveCorrespondence } from "./approveCorrespondence";
import { cancelCorrespondence } from "./cancelCorrespondence";
import { getCorrespondence } from "./getCorrespondence";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [AppRole.ACCOUNTS_APPROVAL];
let token: string | null = "token";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) => (jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 }),
  rolesForRequest: async () => roles,
  verifiedIdentityFromRequest: async () => (token ? { email: "mo@randazzo.properties", name: "Mo Manager", oid: "mo-oid" } : null),
}));
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn(async () => ({})),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../ledger", () => ({ record: jest.fn() }));
jest.mock("../comms/events", () => ({ appendEvent: jest.fn(), readEvents: jest.fn() }));
jest.mock("../comms/store", () => ({ cancelWaitingRecipients: jest.fn(), moveJob: jest.fn(), readJob: jest.fn(), readRecipients: jest.fn() }));
jest.mock("../comms/userSignatureStore", () => ({ findUserByOid: jest.fn() }));

const jobs = jest.mocked(jobStore);
const context = { error: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => new HttpRequest({ body: { string: typeof body === "string" ? body : JSON.stringify(body) }, headers: { "Content-Type": "application/json" }, method: "POST", url: "http://localhost/api/x" });
const get = (id: string | null) => new HttpRequest({ method: "GET", query: id === null ? {} : { id }, url: `http://localhost/api/getCorrespondence${id === null ? "" : `?id=${id}`}` });

const job = (over: Partial<JobRow> = {}): JobRow => ({
  approvedAt: null, approvedByName: null, approvedByOid: null, blockedCount: 0, bodyMarkdown: "Dear {{tenant.name}}", cancelledAt: null, cancelledByName: null, completedAt: null,
  correspondenceId: 41, createdAt: "2026-10-24T00:00:00.000Z", createdByEmail: "fay@randazzo.properties", createdByName: "Fay Facilities", createdByOid: "fay-oid", createdByRole: "facilities",
  failedCount: 0, fromAddress: "notices@randazzo.properties", fromName: "Randazzo Properties", kind: "broadcast", queuedAt: null, recipientCount: 30,
  replyToAddress: "facilities@randazzo.properties", replyToIdentityId: 3, replyToName: "Randazzo Facilities", requiresApproval: true, rowVersion: "00", sentCount: 0,
  signature: { email: null, lines: ["Facilities team"], phone: null }, signatureMode: "role", status: "awaiting_approval", subject: "Water shut-off", templateId: null, templateVersion: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.ACCOUNTS_APPROVAL];
  token = "token";
  jobs.readJob.mockResolvedValue(job());
  jobs.moveJob.mockResolvedValue(true);
  jobs.cancelWaitingRecipients.mockResolvedValue(30);
  jest.mocked(userStore.findUserByOid).mockResolvedValue({ displayName: "Mo Manager", email: "mo@randazzo.properties", userId: 3 });
});

describe("approveCorrespondence", () => {
  it.each([AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL, AppRole.CFO, AppRole.DIRECTOR])("lets %s approve a send someone else queued", async (role) => {
    roles = [role];
    const response = await approveCorrespondence(post({ correspondenceId: 41 }), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ correspondenceId: 41, status: "queued" });
  });

  it("moves it to queued only from awaiting approval, stamped with the approver, with an event and a ledger row", async () => {
    await approveCorrespondence(post({ correspondenceId: 41 }), context);
    expect(jobs.moveJob).toHaveBeenCalledWith(expect.anything(), 41, ["awaiting_approval"], "queued", { approvedBy: { name: "Mo Manager", oid: "mo-oid" } });
    expect(jest.mocked(events.appendEvent)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fromStatus: "awaiting_approval", toStatus: "queued", type: "job" }));
    expect(jest.mocked(record)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "correspondence.approve", actor: expect.objectContaining({ name: "Mo Manager", role: "accounts_manager", userId: 3 }), subject: { id: 41, type: "correspondence" } }));
  });

  it("is never the person who queued it, even a director", async () => {
    roles = [AppRole.DIRECTOR];
    jobs.readJob.mockResolvedValue(job({ createdByOid: "mo-oid" }));
    const response = await approveCorrespondence(post({ correspondenceId: 41 }), context);
    expect(response.status).toBe(403);
    expect(jobs.moveJob).not.toHaveBeenCalled();
  });

  it("refuses admin: it approves nothing real", async () => {
    roles = [AppRole.ADMIN];
    expect((await approveCorrespondence(post({ correspondenceId: 41 }), context)).status).toBe(403);
    expect(jobs.readJob).not.toHaveBeenCalled();
  });

  it.each([AppRole.ACCOUNTS, AppRole.FACILITIES, AppRole.USER])("refuses %s, who is not a manager", async (role) => {
    roles = [role];
    expect((await approveCorrespondence(post({ correspondenceId: 41 }), context)).status).toBe(403);
    expect(jobs.moveJob).not.toHaveBeenCalled();
  });

  it("answers 409 for a send that is not waiting, and when another approver got there first", async () => {
    jobs.readJob.mockResolvedValue(job({ status: "queued" }));
    expect((await approveCorrespondence(post({ correspondenceId: 41 }), context)).status).toBe(409);
    jobs.readJob.mockResolvedValue(job());
    jobs.moveJob.mockResolvedValue(false);
    const response = await approveCorrespondence(post({ correspondenceId: 41 }), context);
    expect(response.status).toBe(409);
    expect(jest.mocked(record)).not.toHaveBeenCalled();
  });

  it("404s a send that doesn't exist and refuses bad input and no token", async () => {
    jobs.readJob.mockResolvedValue(null);
    expect((await approveCorrespondence(post({ correspondenceId: 41 }), context)).status).toBe(404);
    expect((await approveCorrespondence(post({ correspondenceId: "x" }), context)).status).toBe(400);
    expect((await approveCorrespondence(post({ correspondenceId: 41, approvedBy: "me" }), context)).status).toBe(400);
    expect((await approveCorrespondence(post("nope"), context)).status).toBe(400);
    token = null;
    expect((await approveCorrespondence(post({ correspondenceId: 41 }), context)).status).toBe(401);
  });
});

describe("cancelCorrespondence", () => {
  beforeEach(() => {
    roles = [AppRole.FACILITIES];
    jobs.readJob.mockResolvedValue(job({ createdByOid: "mo-oid", status: "queued" }));
  });

  it("lets the person who queued a send cancel it, and every waiting recipient with it", async () => {
    const response = await cancelCorrespondence(post({ correspondenceId: 41 }), context);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ correspondenceId: 41, status: "cancelled" });
    expect(jobs.moveJob).toHaveBeenCalledWith(expect.anything(), 41, ["draft", "awaiting_approval", "queued"], "cancelled", { cancelledBy: "Mo Manager" });
    expect(jobs.cancelWaitingRecipients).toHaveBeenCalledWith(expect.anything(), 41);
    expect(jest.mocked(events.appendEvent)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fromStatus: "queued", toStatus: "cancelled", type: "job" }));
    expect(jest.mocked(record)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "correspondence.cancel", before: { status: "queued" } }));
  });

  it("lets a manager cancel someone else's, and refuses a colleague who is not the creator or a manager", async () => {
    jobs.readJob.mockResolvedValue(job({ createdByOid: "fay-oid", status: "awaiting_approval" }));
    expect((await cancelCorrespondence(post({ correspondenceId: 41 }), context)).status).toBe(403);
    expect(jobs.moveJob).not.toHaveBeenCalled();
    roles = [AppRole.FACILITIES_APPROVAL];
    expect((await cancelCorrespondence(post({ correspondenceId: 41 }), context)).status).toBe(200);
  });

  it("answers 409 once the send has started or finished, writing nothing", async () => {
    for (const status of ["sending", "sent", "failed", "cancelled"] as const) {
      jobs.readJob.mockResolvedValue(job({ createdByOid: "mo-oid", status }));
      jobs.moveJob.mockResolvedValue(false);
      expect((await cancelCorrespondence(post({ correspondenceId: 41 }), context)).status).toBe(409);
    }
    expect(jobs.cancelWaitingRecipients).not.toHaveBeenCalled();
    expect(jest.mocked(record)).not.toHaveBeenCalled();
  });

  it("refuses admin and a baseline user, bad input and no token", async () => {
    roles = [AppRole.ADMIN];
    expect((await cancelCorrespondence(post({ correspondenceId: 41 }), context)).status).toBe(403);
    roles = [AppRole.USER];
    expect((await cancelCorrespondence(post({ correspondenceId: 41 }), context)).status).toBe(403);
    roles = [AppRole.FACILITIES];
    expect((await cancelCorrespondence(post({ correspondenceId: 0 }), context)).status).toBe(400);
    token = null;
    expect((await cancelCorrespondence(post({ correspondenceId: 41 }), context)).status).toBe(401);
  });

  it("404s a send that doesn't exist", async () => {
    jobs.readJob.mockResolvedValue(null);
    expect((await cancelCorrespondence(post({ correspondenceId: 41 }), context)).status).toBe(404);
  });
});

describe("getCorrespondence", () => {
  const recipientRow = { address: "pat@example.com", attempts: 1, correspondenceId: 41, detail: null, graphMessageId: "g1", internetMessageId: "<a@b>", lastAttemptAt: null, lastErrorCode: null, mergeValues: { "tenant.name": "Acme" }, name: "Pat", nextAttemptAt: null, recipientId: 9, recipientRefId: "1", recipientType: "tenancy" as const, sentAt: "2026-10-24T01:00:00.000Z", sentToAddress: "pat@example.com", status: "sent" as const };

  beforeEach(() => {
    roles = [AppRole.FACILITIES];
    jobs.readJob.mockResolvedValue(job({ createdByOid: "mo-oid" }));
    jobs.readRecipients.mockResolvedValue([recipientRow]);
    jest.mocked(events.readEvents).mockResolvedValue([{ actorName: "Mo Manager", createdAt: "x", detail: null, errorCode: null, fromStatus: null, recipientId: null, toStatus: "queued", type: "job" }]);
  });

  it("returns the job, its recipients with their outcomes and message ids, and its events, without merge values", async () => {
    const response = await getCorrespondence(get("41"), context);
    expect(response.status).toBe(200);
    const body = response.jsonBody as { correspondence: { correspondenceId: number }; events: unknown[]; recipients: Record<string, unknown>[] };
    expect(body.correspondence.correspondenceId).toBe(41);
    expect(body.recipients[0]).toMatchObject({ graphMessageId: "g1", internetMessageId: "<a@b>", recipientId: 9, status: "sent" });
    expect(body.recipients[0]).not.toHaveProperty("mergeValues");
    expect(body.events).toHaveLength(1);
  });

  it("is for the creator, a manager and admin only", async () => {
    jobs.readJob.mockResolvedValue(job({ createdByOid: "fay-oid" }));
    expect((await getCorrespondence(get("41"), context)).status).toBe(403);
    for (const role of [AppRole.ACCOUNTS_APPROVAL, AppRole.DIRECTOR, AppRole.ADMIN]) {
      roles = [role];
      expect((await getCorrespondence(get("41"), context)).status).toBe(200);
    }
  });

  it("refuses a baseline user, no token, a bad id and a missing send", async () => {
    roles = [AppRole.USER];
    expect((await getCorrespondence(get("41"), context)).status).toBe(403);
    roles = [AppRole.FACILITIES];
    expect((await getCorrespondence(get(null), context)).status).toBe(400);
    expect((await getCorrespondence(get("abc"), context)).status).toBe(400);
    jobs.readJob.mockResolvedValue(null);
    expect((await getCorrespondence(get("41"), context)).status).toBe(404);
    token = null;
    expect((await getCorrespondence(get("41"), context)).status).toBe(401);
  });
});
