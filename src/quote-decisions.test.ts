import { approveDirectorQuote, rejectQuote } from "./quote-decisions";

jest.mock("./db", () => ({ executeQuery: jest.fn() }));

import { executeQuery } from "./db";

const mockExecuteQuery = executeQuery as jest.MockedFunction<typeof executeQuery>;
const connection = {} as never;

interface Call {
  params: Record<string, unknown>;
  sql: string;
}

function calls(): Call[] {
  return mockExecuteQuery.mock.calls.map(([, sql, params]) => ({
    params: Object.fromEntries((params ?? []).map((p) => [p.name, p.value])),
    sql,
  }));
}

const storedQuote = { JobID: 42, QuoteID: 7, QuoteNumber: "260419-QT-42-ACM-1", Status: "approved" };

// First SELECT is the pre-write lookup; the QUOTE_COLUMNS re-read starts
// "SELECT\n  QuoteID, JobID, …". `updated: false` simulates a concurrent
// status change — the guarded UPDATE … OUTPUT returns no row.
function stubQuote(row: Record<string, unknown> | null, updated = true): void {
  mockExecuteQuery.mockImplementation(async (_conn, sql) => {
    if (/SELECT\s+QuoteID, JobID/i.test(sql)) return [storedQuote];
    if (/SELECT JobID, QuoteNumber/i.test(sql)) return row ? [row] : [];
    if (/UPDATE Quotes/.test(sql)) return updated ? [{ QuoteID: 7 }] : [];
    return [];
  });
}

const awaiting = {
  ContractorName: "Acme Plumbing",
  JobID: 42,
  QuoteNumber: "260419-QT-42-ACM-1",
  Status: "awaiting_director",
};

beforeEach(() => {
  mockExecuteQuery.mockReset();
});

describe("approveDirectorQuote", () => {
  it("approves the quote, mirrors onto Jobs and logs the event", async () => {
    stubQuote(awaiting);

    const outcome = await approveDirectorQuote(connection, { approvedBy: "Carlo", quoteId: 7 });

    expect(outcome).toEqual({ jobId: 42, ok: true, quote: storedQuote });
    const quoteUpdate = calls().find((c) => /UPDATE Quotes/.test(c.sql));
    expect(quoteUpdate?.sql).toMatch(/Status = 'approved'/);
    expect(quoteUpdate?.sql).toMatch(/AND Status = 'awaiting_director'/);
    expect(quoteUpdate?.params).toMatchObject({ ApprovedBy: "Carlo", Id: 7 });
    const jobUpdate = calls().find((c) => /UPDATE Jobs/.test(c.sql));
    expect(jobUpdate?.sql).toMatch(/ApprovedQuoteID = @QuoteID/);
    expect(jobUpdate?.params).toMatchObject({ ApprovedBy: "Carlo", JobID: 42, QuoteID: 7 });
    const event = calls().find((c) => /INSERT INTO JobEvents/.test(c.sql));
    expect(event?.sql).toContain("'quote_director_approved'");
    expect(event?.params).toMatchObject({
      CreatedBy: "Carlo",
      JobID: 42,
      QuoteID: 7,
      SourceEmailID: null,
      Text: "Director-approved 260419-QT-42-ACM-1 from Acme Plumbing",
    });
  });

  it("marks the event 'via email' and stores SourceEmailID when given one", async () => {
    stubQuote(awaiting);

    await approveDirectorQuote(connection, { approvedBy: "Carlo", quoteId: 7, sourceEmailId: 99 });

    const event = calls().find((c) => /INSERT INTO JobEvents/.test(c.sql));
    expect(event?.params).toMatchObject({
      SourceEmailID: 99,
      Text: "Director-approved 260419-QT-42-ACM-1 from Acme Plumbing via email",
    });
  });

  it("appends the director's note to the approval event text", async () => {
    stubQuote(awaiting);

    await approveDirectorQuote(connection, {
      approvedBy: "Carlo",
      note: "  Subject to council sign-off  ",
      quoteId: 7,
      sourceEmailId: 99,
    });

    const event = calls().find((c) => /INSERT INTO JobEvents/.test(c.sql));
    expect(event?.params.Text).toBe(
      "Director-approved 260419-QT-42-ACM-1 from Acme Plumbing via email — Subject to council sign-off",
    );
  });

  it("leaves the event text unchanged for a blank or null note", async () => {
    stubQuote(awaiting);

    await approveDirectorQuote(connection, { approvedBy: "Carlo", note: "   ", quoteId: 7 });
    await approveDirectorQuote(connection, { approvedBy: "Carlo", note: null, quoteId: 7 });

    const texts = calls()
      .filter((c) => /INSERT INTO JobEvents/.test(c.sql))
      .map((c) => c.params.Text);
    expect(texts).toEqual(Array(2).fill("Director-approved 260419-QT-42-ACM-1 from Acme Plumbing"));
  });

  it("returns 404 and writes nothing when the quote is missing", async () => {
    stubQuote(null);

    const outcome = await approveDirectorQuote(connection, { approvedBy: "Carlo", quoteId: 7 });

    expect(outcome).toEqual({ error: "Quote not found", ok: false, status: 404 });
    expect(calls().some((c) => /UPDATE|INSERT/i.test(c.sql))).toBe(false);
  });

  it("returns 409 when the quote is not awaiting the director", async () => {
    stubQuote({ ...awaiting, Status: "pending" });

    const outcome = await approveDirectorQuote(connection, { approvedBy: "Carlo", quoteId: 7 });

    expect(outcome).toEqual({ error: "Quote must be in awaiting_director state", ok: false, status: 409 });
    expect(calls().some((c) => /UPDATE|INSERT/i.test(c.sql))).toBe(false);
  });

  it("returns 409 when the quote is already fully approved", async () => {
    stubQuote({ ...awaiting, Status: "approved" });

    const outcome = await approveDirectorQuote(connection, { approvedBy: "Carlo", quoteId: 7 });

    expect(outcome).toEqual({ error: "Quote is already fully approved", ok: false, status: 409 });
  });
});

describe("rejectQuote", () => {
  const awaitingRow = { JobID: 42, QuoteNumber: "260419-QT-42-ACM-1", Status: "awaiting_director" };

  it("rejects with the note and source email in the event text", async () => {
    stubQuote(awaitingRow);

    const outcome = await rejectQuote(connection, {
      expectedStatuses: ["awaiting_director"],
      note: "Too expensive",
      quoteId: 7,
      rejectedBy: "Carlo",
      sourceEmailId: 99,
    });

    expect(outcome).toEqual({ jobId: 42, ok: true, previousStatus: "awaiting_director", quote: storedQuote });
    const quoteUpdate = calls().find((c) => /UPDATE Quotes/.test(c.sql));
    expect(quoteUpdate?.sql).toMatch(/Status = 'rejected'/);
    expect(quoteUpdate?.params).toMatchObject({ CurrentStatus: "awaiting_director", Id: 7 });
    const event = calls().find((c) => /INSERT INTO JobEvents/.test(c.sql));
    expect(event?.sql).toContain("'quote_rejected'");
    expect(event?.params).toMatchObject({
      CreatedBy: "Carlo",
      QuoteID: 7,
      SourceEmailID: 99,
      Text: "Rejected quote 260419-QT-42-ACM-1 via email — Too expensive",
    });
    expect(calls().some((c) => /UPDATE Jobs SET LastModifiedDate/.test(c.sql))).toBe(true);
  });

  it("keeps the in-app wording when there is no note or source email", async () => {
    stubQuote({ ...awaitingRow, Status: "pending" });

    await rejectQuote(connection, { expectedStatuses: ["pending", "awaiting_director"], quoteId: 7, rejectedBy: "Carlo" });

    const event = calls().find((c) => /INSERT INTO JobEvents/.test(c.sql));
    expect(event?.params).toMatchObject({ SourceEmailID: null, Text: "Rejected quote 260419-QT-42-ACM-1" });
  });

  it("returns 404 and writes nothing when the quote is missing", async () => {
    stubQuote(null);

    const outcome = await rejectQuote(connection, { expectedStatuses: ["pending"], quoteId: 7, rejectedBy: "Carlo" });

    expect(outcome).toEqual({ error: "Quote not found", ok: false, status: 404 });
    expect(calls().some((c) => /UPDATE|INSERT/i.test(c.sql))).toBe(false);
  });

  it("returns 409 and writes nothing when the quote is not in an expected status", async () => {
    stubQuote({ ...awaitingRow, Status: "approved" });

    const outcome = await rejectQuote(connection, { expectedStatuses: ["awaiting_director"], quoteId: 7, rejectedBy: "Carlo" });

    expect(outcome).toEqual({
      error: "Quote is approved — it can only be rejected while awaiting_director",
      ok: false,
      status: 409,
    });
    expect(calls().some((c) => /UPDATE|INSERT/i.test(c.sql))).toBe(false);
  });

  it("returns 409 and logs no event when the status changes between read and write", async () => {
    stubQuote(awaitingRow, false);

    const outcome = await rejectQuote(connection, { expectedStatuses: ["awaiting_director"], quoteId: 7, rejectedBy: "Carlo" });

    expect(outcome).toEqual({ error: "Quote status changed concurrently — reload and try again", ok: false, status: 409 });
    expect(calls().some((c) => /INSERT INTO JobEvents/.test(c.sql))).toBe(false);
  });
});
