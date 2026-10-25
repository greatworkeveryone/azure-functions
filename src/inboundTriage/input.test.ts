import { MAX_EMAIL_IDS, MAX_NOTE_CHARS, parseAssignBody, parseEmailIds } from "./input";

describe("parseEmailIds", () => {
  it("reads a comma list, once each", () => {
    expect(parseEmailIds("1, 2,2,30")).toEqual({ ok: true, value: [1, 2, 30] });
  });

  it.each([[null], [""], ["a,b"], ["0"], ["-3"], ["1.5"], ["99999999999"], [Array.from({ length: MAX_EMAIL_IDS + 1 }, (_, i) => i + 1).join(",")]])("refuses %p", (raw) => {
    expect(parseEmailIds(raw).ok).toBe(false);
  });
});

describe("parseAssignBody", () => {
  const good = { assigneeUserId: 4, emailId: 9, expectedAssigneeUserId: 2, note: " She knows them " };

  it("accepts a whole body, trimming the note, and treats a missing expected owner as nobody", () => {
    expect(parseAssignBody(good)).toEqual({ ok: true, value: { assigneeUserId: 4, emailId: 9, expectedAssigneeUserId: 2, note: "She knows them" } });
    expect(parseAssignBody({ assigneeUserId: 4, emailId: 9 })).toEqual({ ok: true, value: { assigneeUserId: 4, emailId: 9, expectedAssigneeUserId: null, note: null } });
    expect(parseAssignBody({ ...good, note: "   " })).toMatchObject({ value: { note: null } });
  });

  it.each([
    ["no email", { assigneeUserId: 4 }],
    ["a string email id", { ...{ assigneeUserId: 4 }, emailId: "9" }],
    ["no assignee", { emailId: 9 }],
    ["assignee zero", { assigneeUserId: 0, emailId: 9 }],
    ["a fractional expected owner", { assigneeUserId: 4, emailId: 9, expectedAssigneeUserId: 1.5 }],
    ["a note that is not text", { assigneeUserId: 4, emailId: 9, note: 7 }],
    ["a note that is too long", { assigneeUserId: 4, emailId: 9, note: "x".repeat(MAX_NOTE_CHARS + 1) }],
    ["a note with a control character", { assigneeUserId: 4, emailId: 9, note: "a\u0000b" }],
  ])("refuses %s", (_label, body) => {
    expect(parseAssignBody(body as Record<string, unknown>).ok).toBe(false);
  });
});
