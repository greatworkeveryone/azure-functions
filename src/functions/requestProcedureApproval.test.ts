/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});

jest.mock("../auth", () => ({
  AppRole: {
    ACCOUNTS: "accounts",
    ACCOUNTS_APPROVAL: "accounts_manager",
    ADMIN: "admin",
    DIRECTOR: "director",
    FACILITIES: "facilities",
    FACILITIES_APPROVAL: "facilities_manager",
    USER: "user",
  },
  errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
  extractToken: jest.fn().mockReturnValue("mock-token"),
  requireRole: jest.fn().mockResolvedValue(null),
  unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
  userInfoFromToken: jest.fn().mockReturnValue({ email: "fay@rp.com.au", name: "Fay Manager" }),
}));
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
}));
jest.mock("../escalation/store", () => ({ listActiveUsers: jest.fn() }));
jest.mock("../graph", () => ({ graphSendMail: jest.fn().mockResolvedValue(undefined) }));

const auth = require("../auth") as { extractToken: jest.Mock; requireRole: jest.Mock };
const db = require("../db") as { executeQuery: jest.Mock };
const store = require("../escalation/store") as { listActiveUsers: jest.Mock };
const graph = require("../graph") as { graphSendMail: jest.Mock };

import { NOT_A_RECORD } from "../test-data";
import { requestProcedureApproval } from "./requestProcedureApproval";

const context = new InvocationContext();
const FORBIDDEN = { status: 403, jsonBody: { error: "Forbidden" } };
const request = (body: unknown) => ({ json: async () => body }) as unknown as HttpRequest;

const DEE = { email: "dee@rp.com.au", name: "Dee Director", role: "director", userId: 7 };
const body = { approverUserId: 7, slug: "keys", versionId: "11111111-1111-1111-1111-111111111111" };
const DRAFT = { BlocksJson: JSON.stringify([{ id: "b1", kind: "paragraph", text: "Do the thing" }]), Title: "Key handover", VersionNo: 2 };

/** The draft lookup answers `draft`; the request UPDATE answers `updated` rows. */
function arrange({ draft = [DRAFT], updated = [{ ApprovalRequestedAt: new Date("2026-10-18T01:00:00Z") }] }: { draft?: unknown[]; updated?: unknown[] } = {}) {
  db.executeQuery.mockImplementation(async (_conn: unknown, sql: string) => (/UPDATE dbo\.ProcedureVersions/.test(sql) ? updated : draft));
}
const updateCall = () => db.executeQuery.mock.calls.find((call) => /UPDATE dbo\.ProcedureVersions/.test(String(call[1])));
const param = (call: unknown[], name: string) => (call[2] as Array<{ name: string; value: unknown }>).find((entry) => entry.name === name)?.value;

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  store.listActiveUsers.mockResolvedValue([DEE, { email: "a@rp.com.au", name: "Ann", role: "accounts_manager", userId: 3 }]);
  delete process.env.DEV_EMAIL_OVERRIDE;
  process.env.APP_BASE_URL = "https://floorplan.example";
  arrange();
});
afterEach(() => {
  delete process.env.APP_BASE_URL;
  delete process.env.DEV_EMAIL_OVERRIDE;
});

describe("requestProcedureApproval", () => {
  it("needs a token and an editor's role, and touches nothing before them", async () => {
    auth.extractToken.mockReturnValue(null);
    expect((await requestProcedureApproval(request(body), context)).status).toBe(401);
    auth.extractToken.mockReturnValue("mock-token");
    auth.requireRole.mockResolvedValue(FORBIDDEN);
    expect((await requestProcedureApproval(request(body), context)).status).toBe(403);
    expect(auth.requireRole).toHaveBeenLastCalledWith(expect.anything(), ["facilities_manager", "accounts_manager"]);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...body, slug: "" }],
    [{ ...body, versionId: undefined }],
    [{ ...body, approverUserId: "7" }],
    [{ ...body, approverUserId: 0 }],
    [{ ...body, approverUserId: 1.5 }],
    [null],
  ])("rejects a malformed request %j before the database", async (bad) => {
    expect((await requestProcedureApproval(request(bad), context)).status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("will only ask an active director: anyone else cannot approve", async () => {
    for (const approverUserId of [3, 99]) {
      const response = await requestProcedureApproval(request({ ...body, approverUserId }), context);
      expect(response.status).toBe(400);
      expect((response.jsonBody as { error: string }).error).toMatch(/director/i);
    }
    expect(updateCall()).toBeUndefined();
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("refuses a version that is not a draft, or has nothing in it", async () => {
    arrange({ draft: [] });
    expect((await requestProcedureApproval(request(body), context)).status).toBe(409);
    arrange({ draft: [{ ...DRAFT, BlocksJson: "[]" }] });
    const empty = await requestProcedureApproval(request(body), context);
    expect(empty.status).toBe(409);
    expect((empty.jsonBody as { error: string }).error).toMatch(/content/i);
    expect(updateCall()).toBeUndefined();
  });

  it("records who was asked, who asked and when, on the draft only", async () => {
    const response = await requestProcedureApproval(request(body), context);
    expect(response.status).toBe(200);
    const call = updateCall()!;
    expect(String(call[1])).toContain("Status = 'draft'");
    expect(param(call, "Slug")).toBe("keys");
    expect(param(call, "VersionId")).toBe(body.versionId);
    expect(param(call, "RequestedBy")).toBe("Fay Manager");
    expect(param(call, "FromUserId")).toBe(7);
    expect(param(call, "FromName")).toBe("Dee Director");
    expect(response.jsonBody).toMatchObject({ approver: { name: "Dee Director", userId: 7 }, notified: true, ok: true });
  });

  it("answers 409 when the draft was published or replaced between the look and the update", async () => {
    arrange({ updated: [] });
    expect((await requestProcedureApproval(request(body), context)).status).toBe(409);
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("tells the director by email, with a link, and no procedure title in the subject", async () => {
    await requestProcedureApproval(request(body), context);
    expect(graph.graphSendMail).toHaveBeenCalledTimes(1);
    const [egress, to, subject, text] = graph.graphSendMail.mock.calls[0];
    expect(egress).toBe(NOT_A_RECORD);
    expect(to).toBe("dee@rp.com.au");
    expect(subject).toBe("A procedure is waiting for your approval");
    expect(text).toContain("Fay Manager");
    expect(text).toContain("Key handover");
    expect(text).toContain("https://floorplan.example/procedures/keys/edit");
  });

  it("leaves the link out when APP_BASE_URL is not set, and still sends", async () => {
    delete process.env.APP_BASE_URL;
    await requestProcedureApproval(request(body), context);
    expect(graph.graphSendMail.mock.calls[0][3]).not.toMatch(/https?:/);
  });

  it("sends to the override address where one is set, never the director's own", async () => {
    process.env.DEV_EMAIL_OVERRIDE = "dev@rp.test";
    await requestProcedureApproval(request(body), context);
    expect(graph.graphSendMail.mock.calls[0][1]).toBe("dev@rp.test");
  });

  it("keeps the request and says it could not notify when the mail fails or the director has no address", async () => {
    graph.graphSendMail.mockRejectedValueOnce(new Error("Graph down"));
    const failed = await requestProcedureApproval(request(body), context);
    expect(failed.status).toBe(200);
    expect(failed.jsonBody).toMatchObject({ notified: false, ok: true });
    expect(updateCall()).toBeDefined();

    store.listActiveUsers.mockResolvedValue([{ ...DEE, email: null }]);
    const noAddress = await requestProcedureApproval(request(body), context);
    expect(noAddress.jsonBody).toMatchObject({ notified: false, ok: true });
  });
});
