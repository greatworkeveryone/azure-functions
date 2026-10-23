import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { recordOutcome } from "../contractorSuggestions/outcome";
import { closeConnection, createRequestConnection } from "../db";
import { recordContractorSuggestionOutcome } from "./recordContractorSuggestionOutcome";

jest.mock("@azure/functions", () => ({
  ...jest.requireActual("@azure/functions"),
  app: { http: jest.fn() },
}));
let roles: string[] = [AppRole.FACILITIES];
let token: string | null = "token";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) =>
    jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 },
  verifiedIdentityFromRequest: async () => ({ email: "fay@example.com", name: "Fay Facilities", oid: "fay-oid" }),
}));
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn(async () => ({})),
  executeQuery: jest.fn(),
}));
jest.mock("../contractorSuggestions/outcome", () => ({ recordOutcome: jest.fn() }));

const recordMock = jest.mocked(recordOutcome);
const warn = jest.fn();
const context = { error: jest.fn(), warn } as unknown as InvocationContext;
const request = (body: unknown) =>
  new HttpRequest({
    body: { string: typeof body === "string" ? body : JSON.stringify(body) },
    headers: { "Content-Type": "application/json" },
    method: "POST",
    url: "http://localhost/api/recordContractorSuggestionOutcome",
  });

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.FACILITIES];
  token = "token";
  recordMock.mockResolvedValue({
    ok: true,
    value: { featureCaptureFailed: false, outcomes: [{ chosenRank: 2, contractorId: 2, outcome: "chose_suggested" }], recorded: 1 },
  });
});

describe("recordContractorSuggestionOutcome: who may record", () => {
  it.each([AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR, AppRole.ADMIN])(
    "lets %s record, the same people who may ask",
    async (role) => {
      roles = [role];
      expect((await recordContractorSuggestionOutcome(request({ chosenContractorIds: [2], jobId: 7, suggestionSetId: 55 }), context)).status).toBe(200);
    },
  );

  it("refuses a baseline user and a request with no token", async () => {
    roles = [AppRole.USER];
    expect((await recordContractorSuggestionOutcome(request({ chosenContractorIds: [2], jobId: 7, suggestionSetId: 55 }), context)).status).toBe(403);
    roles = [AppRole.FACILITIES];
    token = null;
    expect((await recordContractorSuggestionOutcome(request({ chosenContractorIds: [2], jobId: 7, suggestionSetId: 55 }), context)).status).toBe(401);
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("recordContractorSuggestionOutcome: input", () => {
  it.each([
    ["not JSON", "nope"],
    ["no set id", { chosenContractorIds: [2] }],
    ["a set id that is not a whole number", { chosenContractorIds: [2], suggestionSetId: 1.5 }],
    ["a job id that is not a number", { chosenContractorIds: [2], jobId: "7", suggestionSetId: 55 }],
    ["nobody chosen and not dismissed", { suggestionSetId: 55 }],
    ["an empty choice that is not a dismissal", { chosenContractorIds: [], suggestionSetId: 55 }],
    ["a dismissal that also names someone", { chosenContractorIds: [2], dismissed: true, suggestionSetId: 55 }],
    ["a contractor id that is not a number", { chosenContractorIds: ["2"], suggestionSetId: 55 }],
    ["more than ten contractors", { chosenContractorIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], suggestionSetId: 55 }],
    ["dismissed that is not true or false", { dismissed: "yes", suggestionSetId: 55 }],
  ])("is a 400 for %s, before the database is opened", async (_label, body) => {
    expect((await recordContractorSuggestionOutcome(request(body), context)).status).toBe(400);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("accepts a dismissal and a repeated id once", async () => {
    await recordContractorSuggestionOutcome(request({ dismissed: true, jobId: 7, suggestionSetId: 55 }), context);
    expect(recordMock.mock.calls[0][1]).toEqual({ chosenContractorIds: [], dismissed: true, jobId: 7, suggestionSetId: 55 });
    await recordContractorSuggestionOutcome(request({ chosenContractorIds: [2, 2, 3], suggestionSetId: 55 }), context);
    expect(recordMock.mock.calls[1][1]).toEqual({ chosenContractorIds: [2, 3], dismissed: false, jobId: null, suggestionSetId: 55 });
  });
});

describe("recordContractorSuggestionOutcome: the answer", () => {
  it("returns what was recorded, uncached", async () => {
    const response = await recordContractorSuggestionOutcome(request({ chosenContractorIds: [2], jobId: 7, suggestionSetId: 55 }), context);
    expect(response.status).toBe(200);
    expect(response.headers).toEqual({ "Cache-Control": "no-store" });
    expect(response.jsonBody).toEqual({ outcomes: [{ chosenRank: 2, contractorId: 2, outcome: "chose_suggested" }], recorded: 1 });
  });

  it("takes who is recording from the verified token, never from the body", async () => {
    await recordContractorSuggestionOutcome(request({ actor: "forged", actorOid: "forged-oid", chosenContractorIds: [2], jobId: 7, suggestionSetId: 55 }), context);
    expect(recordMock.mock.calls[0][2]).toEqual({ name: "Fay Facilities", oid: "fay-oid" });
  });

  it("is a 404 for a set that is not this person's or this job's", async () => {
    recordMock.mockResolvedValue({ error: "Suggestion set not found for this job", ok: false, status: 404 });
    const response = await recordContractorSuggestionOutcome(request({ chosenContractorIds: [2], jobId: 9, suggestionSetId: 55 }), context);
    expect(response.status).toBe(404);
    expect(response.jsonBody).toEqual({ error: "Suggestion set not found for this job" });
  });

  it("is a 400 for a contractor that does not exist", async () => {
    recordMock.mockResolvedValue({ error: "Unknown contractor", ok: false, status: 400 });
    expect((await recordContractorSuggestionOutcome(request({ chosenContractorIds: [4040], jobId: 7, suggestionSetId: 55 }), context)).status).toBe(400);
  });

  it("still succeeds, and warns, when the features of a contractor chosen unsuggested could not be captured", async () => {
    recordMock.mockResolvedValue({ ok: true, value: { featureCaptureFailed: true, outcomes: [{ chosenRank: null, contractorId: 90, outcome: "chose_other" }], recorded: 1 } });
    const response = await recordContractorSuggestionOutcome(request({ chosenContractorIds: [90], jobId: 7, suggestionSetId: 55 }), context);
    expect(response.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("set 55"));
  });

  it("closes its connection and answers 500 when the work fails", async () => {
    recordMock.mockRejectedValue(new Error("deadlock victim"));
    const response = await recordContractorSuggestionOutcome(request({ chosenContractorIds: [2], jobId: 7, suggestionSetId: 55 }), context);
    expect(response.status).toBe(500);
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });
});
