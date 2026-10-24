/// <reference types="jest" />
import { ownWords, replyStatesDecision } from "./reply-decision";

describe("ownWords", () => {
  it("drops quoted lines and everything under a quote header", () => {
    const body = "Approved.\n> Please approve\nOn Mon, Carlo wrote:\n> rejected earlier";
    expect(ownWords(body)).toBe("Approved.");
  });

  it("stops at From: and Original Message markers", () => {
    expect(ownWords("Yes\nFrom: Ops\nreject")).toBe("Yes");
    expect(ownWords("Yes\n----- Original Message -----\nreject")).toBe("Yes");
  });

  it("returns empty for null", () => {
    expect(ownWords(null)).toBe("");
  });
});

describe("replyStatesDecision", () => {
  it.each(["Approved", "approve it", "YES", "Go ahead", "ok to proceed", "Please proceed."])(
    "accepts %p as approval",
    (body) => expect(replyStatesDecision(body, "approved")).toEqual({ ok: true }),
  );

  it.each(["Rejected", "I reject this", "Declined", "decline", "No", "Do not proceed", "Don't proceed", "Not approved"])(
    "accepts %p as rejection",
    (body) => expect(replyStatesDecision(body, "rejected")).toEqual({ ok: true }),
  );

  it("does not read 'do not proceed' as approval", () => {
    expect(replyStatesDecision("Do not proceed", "approved")).toEqual({ ok: false, reason: "no_decision" });
  });

  it("matches whole words only", () => {
    expect(replyStatesDecision("Yesterday's quote is approvable", "approved")).toEqual({ ok: false, reason: "no_decision" });
    expect(replyStatesDecision("Nothing to add", "rejected")).toEqual({ ok: false, reason: "no_decision" });
  });

  it("is ambiguous when both appear in the director's own words", () => {
    expect(replyStatesDecision("Approved the first, rejected the second", "approved")).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("ignores decision words that only appear in the quoted request", () => {
    expect(replyStatesDecision("Call me.\n> Please reply approved or rejected", "approved")).toEqual({ ok: false, reason: "no_decision" });
  });

  it("refuses when the reply states the opposite decision", () => {
    expect(replyStatesDecision("Rejected", "approved")).toEqual({ ok: false, reason: "no_decision" });
  });
});
