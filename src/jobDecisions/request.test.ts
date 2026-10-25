/// <reference types="jest" />
import { parseRequestBody, QUESTION_MAX_CHARS, readId, readWithdrawReason, RequestError, WITHDRAW_REASON_MAX_CHARS } from "./request";
import { TierError } from "./tiers";

const named = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  assignmentMode: "named",
  decisionMakers: { userIds: [3, 5] },
  jobId: 12,
  question: "Pay the superseded lighting invoice?",
  tier: "soon",
  ...over,
});

const refused = (body: Record<string, unknown>) => {
  try {
    parseRequestBody(body);
  } catch (error) {
    return error;
  }
  throw new Error("expected the body to be refused");
};

describe("parseRequestBody", () => {
  it("reads a request to named people", () => {
    expect(parseRequestBody(named())).toEqual({
      jobId: 12,
      makers: { mode: "named", userIds: [3, 5] },
      question: "Pay the superseded lighting invoice?",
      sourceAttachmentId: null,
      tier: { tier: "soon" },
    });
  });

  it("reads a request to a whole role, naming the role in any case", () => {
    expect(parseRequestBody(named({ assignmentMode: "role", decisionMakers: { role: " Accounts_Manager " } })).makers).toEqual({ mode: "role", role: "accounts_manager" });
  });

  it("reads each tier's own input and a source file", () => {
    expect(parseRequestBody(named({ routineWeeks: 4, tier: "routine" })).tier).toEqual({ routineWeeks: 4, tier: "routine" });
    expect(parseRequestBody(named({ fixedDate: "2026-10-30", tier: "fixed" })).tier).toEqual({ fixedDate: "2026-10-30", tier: "fixed" });
    expect(parseRequestBody(named({ tier: "emergency" })).tier).toEqual({ tier: "emergency" });
    expect(parseRequestBody(named({ sourceAttachmentId: 77 })).sourceAttachmentId).toBe(77);
  });

  it("takes ids written as digits, trims the question, and treats null and empty extras as absent", () => {
    const parsed = parseRequestBody(named({ decisionMakers: { role: null, userIds: ["3", 5] }, jobId: "12", question: "  Pay it?\n", sourceAttachmentId: "" }));
    expect(parsed).toMatchObject({ jobId: 12, makers: { mode: "named", userIds: [3, 5] }, question: "Pay it?", sourceAttachmentId: null });
  });

  it("keeps the question as it was written inside, line breaks included", () => {
    expect(parseRequestBody(named({ question: "Line one\nLine two" })).question).toBe("Line one\nLine two");
  });

  it.each([
    ["no job", { jobId: undefined }, "jobId must be a whole number"],
    ["a job that is not a number", { jobId: "twelve" }, "jobId must be a whole number"],
    ["a job id of zero", { jobId: 0 }, "jobId must be a whole number"],
    ["a job id with a fraction", { jobId: 1.5 }, "jobId must be a whole number"],
    ["a job id too big for the column", { jobId: 2_147_483_648 }, "jobId must be a whole number"],
    ["no question", { question: undefined }, "question is required"],
    ["a blank question", { question: "   " }, "question is required"],
    ["a question that is not text", { question: 42 }, "question is required"],
    ["a question over the limit", { question: "q".repeat(QUESTION_MAX_CHARS + 1) }, `at most ${QUESTION_MAX_CHARS} characters`],
    ["no assignment mode", { assignmentMode: undefined }, 'assignmentMode must be "named" or "role"'],
    ["an unknown assignment mode", { assignmentMode: "everyone" }, 'assignmentMode must be "named" or "role"'],
    ["no decision makers", { decisionMakers: undefined }, "decisionMakers must be an object"],
    ["decision makers as a list", { decisionMakers: [3] }, "decisionMakers must be an object"],
    ["no one named", { decisionMakers: { userIds: [] } }, "at least one person"],
    ["userIds that is not a list", { decisionMakers: { userIds: 3 } }, "at least one person"],
    ["a bad id among the people", { decisionMakers: { userIds: [3, "x"] } }, "decisionMakers.userIds must be a whole number"],
    ["the same person twice", { decisionMakers: { userIds: [3, 3] } }, "names someone twice"],
    ["a role alongside named people", { decisionMakers: { role: "director", userIds: [3] } }, "role only goes with assignmentMode role"],
    ["more than 25 people", { decisionMakers: { userIds: Array.from({ length: 26 }, (_, i) => i + 1) } }, "at most 25 people"],
    ["a source file that is not an id", { sourceAttachmentId: "x" }, "sourceAttachmentId must be a whole number"],
  ])("refuses %s with 400", (_label, over, message) => {
    const error = refused(named(over));
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: "bad_request", status: 400, message: expect.stringContaining(message) });
  });

  it.each([
    ["no role", { decisionMakers: {} }, "decisionMakers.role must name a role"],
    ["a blank role", { decisionMakers: { role: "  " } }, "decisionMakers.role must name a role"],
    ["a role that is not a decision maker's (user)", { decisionMakers: { role: "user" } }, "decisionMakers.role must be one of"],
    ["a role that does not exist", { decisionMakers: { role: "janitor" } }, "decisionMakers.role must be one of"],
    ["people alongside a role", { decisionMakers: { role: "director", userIds: [3] } }, "userIds only goes with assignmentMode named"],
  ])("refuses a role request with %s with 400", (_label, over, message) => {
    expect(refused(named({ assignmentMode: "role", ...over }))).toMatchObject({ code: "bad_request", status: 400, message: expect.stringContaining(message) });
  });

  it("refuses a request to the admin role, in plain words (422): admin approves nothing real", () => {
    for (const role of ["admin", " Admin "]) {
      expect(refused(named({ assignmentMode: "role", decisionMakers: { role } }))).toMatchObject({
        code: "decision_maker_role_not_allowed",
        message: "Admin looks after Floorplan and doesn't decide on jobs, so a question can't be put to the Admin role. Ask a director, the CFO or a manager.",
        status: 422,
      });
    }
  });

  it("lets a role request carry an empty people list", () => {
    expect(parseRequestBody(named({ assignmentMode: "role", decisionMakers: { role: "director", userIds: [] } })).makers).toEqual({ mode: "role", role: "director" });
  });

  it("refuses a tier that is wrong, with the tier's own error", () => {
    expect(refused(named({ tier: "whenever" }))).toBeInstanceOf(TierError);
    expect(refused(named({ tier: "routine" }))).toMatchObject({ code: "routine_weeks_required" });
    expect(refused(named({ routineWeeks: 12, tier: "routine" }))).toMatchObject({ code: "routine_weeks_invalid" });
    expect(refused(named({ tier: "fixed" }))).toMatchObject({ code: "fixed_date_required" });
    expect(refused(named({ fixedDate: "2026-10-30", tier: "soon" }))).toMatchObject({ code: "unexpected_fixed_date" });
  });
});

describe("readId", () => {
  it("accepts a positive whole number or its digits, and nothing else", () => {
    expect(readId(5, "x")).toBe(5);
    expect(readId("5", "x")).toBe(5);
    for (const bad of [0, -1, 1.2, "1.2", "", " 5", "5 ", "five", null, undefined, true, [], {}, Number.NaN, Infinity]) {
      expect(() => readId(bad, "x")).toThrow(RequestError);
    }
  });
});

describe("readWithdrawReason", () => {
  it("trims a reason", () => {
    expect(readWithdrawReason("  Raised on the wrong job ")).toBe("Raised on the wrong job");
  });

  it("requires one", () => {
    for (const none of [undefined, null, "", "   "]) {
      expect(() => readWithdrawReason(none)).toThrow(expect.objectContaining({ code: "reason_required", status: 400 }));
    }
  });

  it("refuses text that is not text and text that is too long", () => {
    expect(() => readWithdrawReason(5)).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(() => readWithdrawReason("r".repeat(WITHDRAW_REASON_MAX_CHARS + 1))).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(readWithdrawReason("r".repeat(WITHDRAW_REASON_MAX_CHARS))).toHaveLength(WITHDRAW_REASON_MAX_CHARS);
  });
});
