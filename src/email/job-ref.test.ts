import { jobIdFromText } from "./job-ref";

describe("jobIdFromText — job references", () => {
  it.each([
    ["Job #42", 42],
    ["job 42", 42],
    ["Re: JOB#42 leaking tap", 42],
    ["FW: Job # 42", 42],
  ])("%s → %d", (subject, expected) => {
    expect(jobIdFromText(subject, null)).toBe(expected);
  });
});

describe("jobIdFromText — document numbers", () => {
  it.each([
    ["260419-PO-42-ACM-7", 42],
    ["260419-QT-42-CR-3", 42],
    ["Re: 260419-IV-42-CR-1 attached", 42],
    ["Invoice for 260419-po-42-acm-7", 42],
    // The real PO subject (src/pdf/default-po-email.ts) and its replies.
    ["Purchase Order 260419-PO-42-ACM-7 — Leaking tap L2 kitchen", 42],
    ["Re: Purchase Order 260419-PO-42-ACM-7 — Leaking tap L2 kitchen", 42],
    ["RE: Fwd: 260419-QT-42-CR-3 revised", 42],
  ])("%s → %d", (subject, expected) => {
    expect(jobIdFromText(subject, null)).toBe(expected);
  });
});

describe("jobIdFromText — no match", () => {
  it.each([
    "Invoice 1234",
    "Call me on 0412 345 678",
    "Ticket #2024 has been closed",
    "jobs 42 done this week",
    "Job #0",
    "123456-XX-42-ACM-1",
    "",
    // Legacy PO-{JobID}-{seq} — only in migration 012 seed data.
    "PO-42-1",
    // PO-{PurchaseOrderID} display fallback — a PO id, not a job id.
    "Purchase Order PO-1234 — Leaking tap",
  ])("%s → null", (subject) => {
    expect(jobIdFromText(subject, null)).toBeNull();
  });

  it("returns null for null / undefined subject and body", () => {
    expect(jobIdFromText(null, null)).toBeNull();
    expect(jobIdFromText(undefined, undefined)).toBeNull();
  });
});

describe("jobIdFromText — precedence", () => {
  it("falls back to the body when the subject has no reference", () => {
    expect(jobIdFromText("Re: your request", "<p>Regarding Job #42, all done.</p>")).toBe(42);
  });

  it("subject wins over body", () => {
    expect(jobIdFromText("Job #7", "see Job #9")).toBe(7);
  });

  it("Job #N wins over a document number in the same text", () => {
    expect(jobIdFromText("Job #7 — 260419-PO-9-ACM-1", null)).toBe(7);
  });
});

describe("jobIdFromText — subject stays loose", () => {
  it("accepts a bare 'job N' in the subject", () => {
    expect(jobIdFromText("Re: Job 42", null)).toBe(42);
  });

  it("does not span a line break between 'job' and the number", () => {
    expect(jobIdFromText("job\n\n42", null)).toBeNull();
  });
});

describe("jobIdFromText — body is strict", () => {
  it.each([
    ["Job #42 is finished", 42],
    ["<p>JOB# 42 done</p>", 42],
    ["Attached 260419-IV-42-CR-1", 42],
  ])("%s → %d", (body, expected) => {
    expect(jobIdFromText(null, body)).toBe(expected);
  });

  it.each([
    ["bare 'job N'", "Regarding job 42, all done."],
    ["'Job N of M' counters", "Job 1 of 3 completed"],
    ["a number on a later line", "job\n\n42"],
    ["a number after blank space and '#' across lines", "job\n#42"],
  ])("ignores %s", (_label, body) => {
    expect(jobIdFromText(null, body)).toBeNull();
  });

  it("a document number outranks an earlier Job #N", () => {
    expect(jobIdFromText(null, "Job #3 — see 260419-PO-9-ACM-1")).toBe(9);
  });
});

describe("jobIdFromText — quoted history is ignored", () => {
  it.each([
    ["an HTML blockquote", "<p>Thanks</p><blockquote>Job #12 done</blockquote>"],
    ["nested blockquotes", "<blockquote>a<blockquote>b</blockquote>Job #12</blockquote>"],
    ["an unclosed blockquote", "<p>Thanks</p><blockquote>Job #12 done"],
    ["'>' quoted lines", "Thanks\n> Job #12 done\n>> 260419-PO-12-ACM-1"],
    ["an 'On … wrote:' reply header", "Thanks\n\nOn Mon, 6 Oct 2026, Bob <b@x.com> wrote:\nJob #12 done"],
    ["a wrapped 'On … wrote:' header", "Thanks\nOn Mon, 6 Oct 2026 at 10:00, Bob Smith\n<b@x.com> wrote:\nJob #12"],
    ["an Outlook From: header", "Thanks\n\nFrom: Bob\nSent: Monday\nSubject: Job #12"],
    ["an Outlook HTML From: header", "<p>Thanks</p><hr><b>From:</b> Bob<br>Job #12"],
    ["an Original Message separator", "Thanks\n-----Original Message-----\nJob #12"],
  ])("ignores a reference inside %s", (_label, body) => {
    expect(jobIdFromText(null, body)).toBeNull();
  });

  it("keeps a reference written above the quoted history", () => {
    expect(jobIdFromText(null, "Job #5 done.\n\nOn Mon, Bob wrote:\n> Job #12")).toBe(5);
  });
});
