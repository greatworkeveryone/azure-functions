# Toddler on ACA GPU + Document Intelligence — Azure Functions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the email-parse pipeline safe to run against a scale-to-zero GPU (attachments actually reach toddler; no HTTP handler waits on warm-up or parsing; a deadline-driven, claim-one-at-a-time runner that fits the 10-minute Consumption timeout) and teach the Function side the v5 taxonomy (deterministic job matcher, `knownJob` context, skip-senders, `promoteEmailToJobUpdate`, `recordEmailQuoteDecision`, migration 089).

**Architecture:** `hydrateAttachmentRefs` first learns the `{ blobName, fileName }` shape Graph sync stores, so toddler stops receiving `attachments: []`. HTTP handlers (`graphNotification`, `syncEmailsNow`, `triggerEmailParse`) only validate, write one message to the Storage queue `email-sync` (on the existing `AzureWebJobsStorage` account) and return 202. A queue-triggered `processEmailSync` does the Graph sync (skipping already-stored MessageIDs before any attachment download) and then the shared warm parse: cheap `TOP (1)` queue check → `POST /warmup` → deadline-driven `runParseBatch`, which claims **one** row at a time and stops claiming once less than `TODDLER_TIMEOUT_MS` + 30 s remains before invocation start + 540 s. A 2-minute singleton timer `parseEmailsTimer` and the existing daily retry run the same path as the backstop. `runParseBatch` gains a shared `jobIdFromText` matcher (`src/email/job-ref.ts`), a one-SELECT `knownJob` block sent to toddler when `MatchedJobID` is set, and an `AI_PARSE_SKIP_SENDERS` short-circuit. Two new operator endpoints in `emails.ts` record a reply as a job-timeline note (with optional `WORK_COMPLETED` through the existing state machine) and record an emailed director decision through shared helpers `approveDirectorQuote` / `rejectQuote` in `src/quote-decisions.ts`, extracted from `quotes.ts`. Migration 089 adds `JobEvents.SourceEmailID`.

**Tech Stack:** Azure Functions v4 (Node 22, TypeScript strict, `@azure/functions` 4.12.0 — `app.storageQueue` / `output.storageQueue` are built in, the extension bundle `[4.*, 5.0.0)` carries the queue extension), `tedious` 18.6.2, Jest 30 + ts-jest, Azure SQL Basic. No new npm dependencies.

---

## Scope boundaries

- **In:** everything under §5A.2, §5A.5, §6 (incl. §6.4) and the Function parts of §9 of `codename-toddler/docs/superpowers/specs/2026-10-06-aca-gpu-document-intelligence-design.md`.
- **Out (other plans):** toddler code (`/warmup`, DI, prompt v5, the credit-note `amount = null` rule — no amount handling lives in the Functions), frontend (including its handling of the new 202 bodies), Azure resources and Function App settings values.
- **Baseline before Task 1:** `npx jest` → 54 suites, 1183 passed, 1 todo. `npx tsc --noEmit` clean.
- **Git:** Will stages and commits. No `git add` / `git commit` in any step.
- **Guard tests already in the repo that new code must keep green:** `src/__tests__/no-user-connection.test.ts` (never `createConnection(`; HTTP-handler files never call the `createServiceConnection()` singleton — its `it.each` runs **two tests per non-test `.ts` file under `src/`**, so every new source file adds 2 to the Jest total; the checkpoint counts below include that), `no-select-star.test.ts`, `list-endpoints-paginated.test.ts` (quotes.ts must keep referencing `parsePagination` / `MAX_LIST_ROWS` — the refactor in Task 9 leaves those untouched), and the eslint rule `local/no-sql-interpolation` (only `SCREAMING_SNAKE_CASE` identifiers may be interpolated into SQL template literals).
- **Settings the new code reads** (values are set in Azure by the infra plan, §6.3): `TODDLER_URL`, `TODDLER_SERVICE_KEY`, `TODDLER_TIMEOUT_MS` (existing), `TODDLER_WARMUP_TIMEOUT_MS` (new, default `240000`), `AI_PARSE_BATCH_SIZE` (existing; now an upper bound on emails per run), `AI_PARSE_SKIP_SENDERS` (new, default empty), `GRAPH_MAILBOX_DEV` (existing), `AzureWebJobsStorage` (existing — the `email-sync` queue lives there), `MYBUILDINGS_BEARER_TOKEN` (existing — the token the daily retry already passes to `createRequestConnection`; only used for SQL when `SQL_USER_CONNECTION=true`).

---

## File structure

| Path | Action | Single responsibility |
|---|---|---|
| `src/functions/parseEmails.ts` | Modify | `hydrateAttachmentRefs` accepts both stored shapes; deadline-driven claim-one runner; `toddlerConfigured`, `warmUpToddler`, `hasUnparsedEmails`, `parseQueued`, `parseEmailsTimer`, queue-triggered `processEmailSync`; `triggerEmailParse` enqueues; `knownJob` lookup; widened classification; skip-senders; `MatchedJobID` in the claim. |
| `src/functions/parseEmails.test.ts` | Modify | Attachment-shape tests, runner/deadline tests, timer tests, trigger/queue tests, `knownJob` + skip-sender tests; shared module loader. |
| `src/email/job-ref.ts` | Create | Deterministic subject/body → job id matcher (`Job #N`, document numbers). The only thing that ever sets `MatchedJobID`. |
| `src/email/job-ref.test.ts` | Create | Matcher behaviour: positives (incl. real PO subjects and `Re:` / `RE: Fwd:`), negatives (incl. legacy PO formats), precedence. |
| `src/graph.ts` | Modify | `graphFetchEmails` takes the set of already-stored MessageIDs and drops them before fetching attachments. |
| `src/graph.test.ts` | Create | Known messages never trigger an attachment download; new ones still do. |
| `src/email/mail-sync.ts` | Create | `syncMailbox` — `ge MAX(ReceivedAt)` window + known-MessageID set → Graph → `upsertGraphEmails`. |
| `src/email/mail-sync.test.ts` | Create | Known-ID set built from rows at/after the newest `ReceivedAt`. |
| `src/email/sync-queue.ts` | Create | `email-sync` queue name, output binding, `enqueueEmailSync`, message type guard. |
| `src/functions/graphWebhook.ts` | Modify | `graphNotification` validates, enqueues, returns 202; corrected 3 s comment; export the handler for tests. |
| `src/functions/graphWebhook.test.ts` | Create | Webhook and `syncEmailsNow` enqueue and return 202 without Graph, SQL or parsing. |
| `src/functions/emails.ts` | Modify | Replace two inline job regexes with `jobIdFromText`; `syncEmailsNow` enqueues; add `promoteEmailToJobUpdate` and `recordEmailQuoteDecision` handlers + registrations. |
| `src/functions/emails.test.ts` | Create | Handler tests for the two new endpoints (mock DB / auth / shared helpers). |
| `src/quote-decisions.ts` | Create | Shared helpers `approveDirectorQuote` / `rejectQuote` + `QUOTE_COLUMNS`. Status guards (409), actor passed in by the caller. Callers own the transaction, response and Planner follow-up. |
| `src/quote-decisions.test.ts` | Create | SQL-level tests for both helpers. |
| `src/functions/quotes.ts` | Modify | `directorApproveQuote` and `rejectQuote` call the helpers with the actor from `verifiedIdentityFromRequest`; literal-director check kept; `QUOTE_COLUMNS` imported instead of local. |
| `src/functions/quotes.test.ts` | Create | Handler tests: actor from the verified token, 409 passthrough, admin refused on director approval. |
| `migrations/089_job_events_source_email.sql` | Create | `JobEvents.SourceEmailID INT NULL` + FK to `Emails(EmailID)`, idempotent. |
| `host.json` | Modify | `"functionTimeout": "00:10:00"`; `extensions.queues` `batchSize: 1`, `maxDequeueCount: 3`. |
| `README.md` | Modify | Document the new settings and the `email-sync` queue next to the existing `TODDLER_*` entries. |

`src/openapi.json` is **not** touched: it lists no email endpoints today (its only "Email" hit is a `PrimaryContactEmail` property), so there is nothing to mirror.

---

### Task 1: `hydrateAttachmentRefs` accepts both stored attachment shapes (prerequisite)

Graph sync stores `AttachmentBlobs` as `[{ blobName, fileName }]` (`src/graph.ts` `fetchAndUploadAttachments`, written by `upsertGraphEmails`), but `hydrateAttachmentRefs` in `parseEmails.ts` keeps only strings — so every Graph-synced email reaches toddler with `attachments: []` and nothing in spec §4 (Document Intelligence) is reachable. `emails.ts` `hydrateAttachments` already accepts both shapes; this task applies the same rule to the parse worker. It lands first because every later parse task depends on attachments arriving.

**Files:**
- Modify: `src/functions/parseEmails.ts` (`ToddlerAttachmentRef` ~line 67; attachment hydration section lines 260–278)
- Test: `src/functions/parseEmails.test.ts`

- [ ] **Step 1: Add a claim-queue helper and the failing tests**

In `src/functions/parseEmails.test.ts`, directly after the `sqlOfCalls` helper (ends line 80), add:

```ts
// Answers the claim UPDATE from a queue so each row is handed out once;
// `extra` answers any other statement by shape (undefined → no rows).
function stubClaims(emails: object[], extra?: (sql: string) => unknown[] | undefined): void {
  const queue = [...emails];
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (sql.includes("OUTPUT inserted")) return queue.splice(0, queue.length);
    return extra?.(sql) ?? [];
  });
}
```

In the `beforeEach`, replace the `// claimBatch runs two UPDATEs; …` comment and the `db.executeQuery.mockImplementation(…)` call below it with:

```ts
  stubClaims([claimedEmail]);
```

After the `const db = require("../db") …` line add:

```ts
const { hydrateAttachmentRefs } = require("./parseEmails") as typeof import("./parseEmails");
const blob = require("../blob-storage") as { generateReadSasUrl: jest.Mock };
const SAS = "https://acct.blob.core.windows.net/x?sig=1";
```

Append to the file:

```ts
describe("hydrateAttachmentRefs", () => {
  it("accepts bare blob-name strings (ingestEmail shape)", () => {
    expect(hydrateAttachmentRefs(JSON.stringify(["emails/abc/quote.pdf"]))).toEqual([
      { fileName: "quote.pdf", sasUrl: SAS },
    ]);
    expect(blob.generateReadSasUrl).toHaveBeenCalledWith("emails/abc/quote.pdf", 3_600_000);
  });

  it("accepts { blobName, fileName } objects (Graph sync shape)", () => {
    const raw = JSON.stringify([{ blobName: "email-attachments/AAMk/9f2c-quote.pdf", fileName: "Quote 1042.pdf" }]);

    expect(hydrateAttachmentRefs(raw)).toEqual([{ fileName: "Quote 1042.pdf", sasUrl: SAS }]);
    expect(blob.generateReadSasUrl).toHaveBeenCalledWith("email-attachments/AAMk/9f2c-quote.pdf", 3_600_000);
  });

  it("handles a mixed array in order", () => {
    const raw = JSON.stringify(["emails/abc/a.pdf", { blobName: "email-attachments/x/b.pdf", fileName: "b.pdf" }]);

    expect(hydrateAttachmentRefs(raw).map((a) => a.fileName)).toEqual(["a.pdf", "b.pdf"]);
  });

  it("drops junk entries and falls back to the blob basename when fileName is missing", () => {
    const raw = JSON.stringify([null, 42, "", {}, { blobName: 7 }, { blobName: "" }, { blobName: "email-attachments/x/c.pdf" }]);

    expect(hydrateAttachmentRefs(raw)).toEqual([{ fileName: "c.pdf", sasUrl: SAS }]);
  });

  it("returns [] for null, invalid JSON and non-array JSON", () => {
    expect(hydrateAttachmentRefs(null)).toEqual([]);
    expect(hydrateAttachmentRefs("not json")).toEqual([]);
    expect(hydrateAttachmentRefs(JSON.stringify({ blobName: "email-attachments/x/c.pdf" }))).toEqual([]);
  });
});

describe("runParseBatch → attachments", () => {
  it("sends Graph-shaped attachments to toddler", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    stubClaims([
      {
        ...claimedEmail,
        AttachmentBlobs: JSON.stringify([{ blobName: "email-attachments/x/b.pdf", fileName: "Invoice.pdf" }]),
      },
    ]);
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as { attachments: unknown }).attachments).toEqual([
      { fileName: "Invoice.pdf", sasUrl: SAS },
    ]);
  });
});
```

- [ ] **Step 2: Run — red**

```
npx jest src/functions/parseEmails.test.ts
```

Expected: ts-jest diagnostic `TS2339: Property 'hydrateAttachmentRefs' does not exist on type 'typeof import(".../src/functions/parseEmails")'`.

- [ ] **Step 3: Export the ref type**

`tsconfig.json` has `"declaration": true`, so an exported function cannot return a private interface (TS4060). In `src/functions/parseEmails.ts` change `interface ToddlerAttachmentRef {` (~line 67) to `export interface ToddlerAttachmentRef {`.

- [ ] **Step 4: Replace the hydration helper**

Replace the attachment-hydration section (lines 260–278, from `// ── Attachment hydration (local helper — mirrors emails.ts)` through the closing `}` of `hydrateAttachmentRefs`) with:

```ts
// ── Attachment hydration ────────────────────────────────────────────────────
// AttachmentBlobs holds two shapes: bare blob names (ingestEmail) and
// { blobName, fileName } objects (Graph sync, src/graph.ts). Accept both —
// the same rule as hydrateAttachments in emails.ts — and drop anything else.

interface StoredAttachment {
  blobName: string;
  fileName: string;
}

function basename(blobName: string): string {
  return blobName.split("/").pop() ?? blobName;
}

function storedAttachment(entry: unknown): StoredAttachment | null {
  if (typeof entry === "string") {
    return entry.length > 0 ? { blobName: entry, fileName: basename(entry) } : null;
  }
  if (typeof entry !== "object" || entry === null || !("blobName" in entry)) return null;
  const { blobName, fileName } = entry as { blobName: unknown; fileName?: unknown };
  if (typeof blobName !== "string" || blobName.length === 0) return null;
  return {
    blobName,
    fileName: typeof fileName === "string" && fileName.length > 0 ? fileName : basename(blobName),
  };
}

export function hydrateAttachmentRefs(raw: string | null): ToddlerAttachmentRef[] {
  if (!raw) return [];
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const hour = 60 * 60 * 1000;
  return entries
    .map(storedAttachment)
    .filter((a): a is StoredAttachment => a !== null)
    .map(({ blobName, fileName }) => ({ fileName, sasUrl: generateReadSasUrl(blobName, hour) }));
}
```

- [ ] **Step 5: Run — green**

```
npx jest src/functions/parseEmails.test.ts
```

Expected: `Tests: 11 passed, 11 total` (5 existing + 5 hydration + 1 end-to-end).

- [ ] **Checkpoint:** run `npx tsc --noEmit && npx jest` (expected: all pass — 54 suites, 1189 tests) and hand to Will to commit.

---

### Task 2: Shared job matcher `jobIdFromText`

**Files:**
- Create: `src/email/job-ref.ts`
- Test: `src/email/job-ref.test.ts`
- Modify: `src/functions/emails.ts` (import block lines 7–15; `ingestEmail` lines 258–263; `upsertGraphEmails` lines 757–759)

- [ ] **Step 1: Write the failing matcher tests**

Create `src/email/job-ref.test.ts`:

```ts
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
    expect(jobIdFromText("Re: your request", "<p>Regarding job 42, all done.</p>")).toBe(42);
  });

  it("subject wins over body", () => {
    expect(jobIdFromText("Job #7", "see job 9")).toBe(7);
  });

  it("Job #N wins over a document number in the same text", () => {
    expect(jobIdFromText("Job #7 — 260419-PO-9-ACM-1", null)).toBe(7);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail for the right reason**

```
npx jest src/email/job-ref.test.ts
```

Expected: suite fails to run with `Cannot find module './job-ref' from 'src/email/job-ref.test.ts'`.

- [ ] **Step 3: Write the matcher**

Create `src/email/job-ref.ts`:

```ts
// Deterministic email → job matcher. The model never sets MatchedJobID — this
// is the only source. Shared by ingestEmail, the Graph sync and the parse
// worker so all three agree on what "references a job" means.

// "Job #42", "job 42", "JOB#42". The trailing \b stops "Job #42a".
const JOB_REF_RE = /\bjob\s*#?\s*(\d{1,9})\b/i;

// Document numbers from src/doc-number.ts: YYMMDD-{PO|QT|IV}-{jobId}-{acronym}-{seq};
// the job id is group 3. Leading \b rather than ^: real subjects are
// "Purchase Order 260419-PO-42-ACM-7 — …" (src/pdf/default-po-email.ts),
// often behind "Re:" / "RE: Fwd:".
// Deliberately NOT matched: legacy PO-{JobID}-{seq} (migration 012 seed data
// only) and the PO-{PurchaseOrderID} display fallback — that carries a PO id,
// not a job id, so matching it could link the wrong job.
const DOC_NUMBER_RE = /\b(\d{6})-(PO|QT|IV)-(\d+)-/i;

// [pattern, capture group holding the job id], in precedence order.
const PATTERNS: readonly (readonly [RegExp, number])[] = [
  [JOB_REF_RE, 1],
  [DOC_NUMBER_RE, 3],
];

// SQL INT ceiling — anything larger is noise, not a job id.
const MAX_JOB_ID = 2147483647;

function firstJobId(text: string | null | undefined): number | null {
  if (!text) return null;
  for (const [pattern, group] of PATTERNS) {
    const match = text.match(pattern);
    const id = match ? Number(match[group]) : NaN;
    if (Number.isInteger(id) && id > 0 && id <= MAX_JOB_ID) return id;
  }
  return null;
}

/** Subject wins over body; within each, "Job #N" wins over a document number. */
export function jobIdFromText(
  subject: string | null | undefined,
  body: string | null | undefined,
): number | null {
  return firstJobId(subject) ?? firstJobId(body);
}
```

- [ ] **Step 4: Run the tests again**

```
npx jest src/email/job-ref.test.ts
```

Expected: `Tests: 24 passed, 24 total`.

- [ ] **Step 5: Use the matcher in `ingestEmail`**

In `src/functions/emails.ts`, add to the import block (after the `doc-number` import on line 13):

```ts
import { jobIdFromText } from "../email/job-ref";
```

Replace lines 258–263 (the `// Best-effort match by subject` comment through `const matchedJobId = ...`) with:

```ts
    // Deterministic job match — shared with the Graph sync and the parse
    // worker (src/email/job-ref.ts) so MatchedJobID means the same everywhere.
    const matchedJobId = jobIdFromText(
      typeof Subject === "string" ? Subject : null,
      typeof Body === "string" ? Body : null,
    );
```

- [ ] **Step 6: Use the matcher in `upsertGraphEmails`**

Replace lines 758–759 (`const jobMatch = email.subject?.match(...)` and `const matchedJobId = jobMatch ? ... : null;`) with:

```ts
    const matchedJobId = jobIdFromText(email.subject, email.bodyContent);
```

- [ ] **Step 7: Confirm no inline job regex remains**

```
grep -n "job\\\\s\*#" src/functions/emails.ts src/functions/parseEmails.ts
```

Expected: no output.

- [ ] **Checkpoint:** run `npx tsc --noEmit && npx jest` (expected: all pass — 55 suites, 1215 tests: +24 matcher, +2 guard tests for the new `job-ref.ts`) and hand to Will to commit.

---

### Task 3: Deadline-driven, claim-one-at-a-time runner + `functionTimeout`

The Function App is on Consumption and `host.json` sets no `functionTimeout`, so today's limit is the 5-minute default. A batch of `AI_PARSE_BATCH_SIZE` rows claimed up front, each allowed `TODDLER_TIMEOUT_MS` (180 s), can be killed mid-batch with every claimed row charged an attempt. This task raises the timeout to the Consumption maximum and makes the runner claim **one** row at a time against a deadline (invocation start + 540 s): before each claim it stops if less than `TODDLER_TIMEOUT_MS` + 30 s remains. A run the host kills anyway costs at most one row one attempt. `AI_PARSE_BATCH_SIZE` stays as an upper bound per run.

**Files:**
- Modify: `src/functions/parseEmails.ts` (config lines 26–34; `claimBatch` lines 154–194; the `// ── Shared batch runner` section — `ParseBatchResult` + `runParseBatch`, now below Task 1's hydration block)
- Modify: `host.json`
- Test: `src/functions/parseEmails.test.ts`

- [ ] **Step 1: Hand out one row per claim in the test helper, pin the env, add the failing tests**

In `src/functions/parseEmails.test.ts`, in `stubClaims` change `return queue.splice(0, queue.length);` to:

```ts
    if (sql.includes("OUTPUT inserted")) return queue.splice(0, 1);
```

Change `ENV` to (so a test that sets one of these cannot leak it into the next):

```ts
const ENV = {
  AI_PARSE_BATCH_SIZE: undefined,
  TODDLER_SERVICE_KEY: "test-key",
  TODDLER_TIMEOUT_MS: undefined,
  TODDLER_URL: "https://toddler.test",
};
```

Append:

```ts
describe("runParseBatch → deadline runner", () => {
  const claimSql = (): string[] => sqlOfCalls().filter((s) => s.includes("OUTPUT inserted"));

  it("claims one row per statement until the queue is empty", async () => {
    mockFetchJson(toddlerOk);
    stubClaims([claimedEmail, { ...claimedEmail, EmailID: 43 }]);
    const run = loadRunParseBatch(ENV);

    const result = await run("tok", context);

    expect(result).toEqual({ claimed: 2, errored: 0, flagged: 0, succeeded: 2 });
    // Two rows plus the empty claim that ends the run.
    expect(claimSql()).toHaveLength(3);
    expect(claimSql().every((s) => /UPDATE TOP \(1\) Emails/.test(s))).toBe(true);
  });

  it("stops at AI_PARSE_BATCH_SIZE even with rows left", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    stubClaims([1, 2, 3].map((n) => ({ ...claimedEmail, EmailID: n })));
    const run = loadRunParseBatch({ ...ENV, AI_PARSE_BATCH_SIZE: "2" });

    const result = await run("tok", context);

    expect(result.claimed).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops claiming once less than TODDLER_TIMEOUT_MS + 30 s remains", async () => {
    let now = 1_000_000;
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
    // Each toddler call takes 5 s of fake time.
    const fetchMock = jest.fn().mockImplementation(async () => {
      now += 5_000;
      return { json: async () => toddlerOk, ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    stubClaims([1, 2, 3, 4, 5].map((n) => ({ ...claimedEmail, EmailID: n })));
    // Per-email budget = 1 s timeout + 30 s margin = 31 s.
    // 40 s left → claim; 35 s → claim; 30 s → stop.
    const run = loadRunParseBatch({ ...ENV, AI_PARSE_BATCH_SIZE: "10", TODDLER_TIMEOUT_MS: "1000" });

    try {
      const result = await run("tok", context, now + 40_000);

      expect(result.claimed).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(claimSql()).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("claims nothing when the deadline leaves less than one email's budget", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    const run = loadRunParseBatch(ENV);

    // Default budget: 180 s timeout + 30 s margin = 210 s; only 200 s left.
    const result = await run("tok", context, Date.now() + 200_000);

    expect(result.claimed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(claimSql()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — red**

```
npx jest src/functions/parseEmails.test.ts -t "deadline runner"
```

Expected: ts-jest diagnostic `TS2554: Expected 2 arguments, but got 3.` (`runParseBatch` has no deadline parameter yet).

- [ ] **Step 3: Replace the batch-size config with the run budget**

In `src/functions/parseEmails.ts` replace line 33 (`const BATCH_SIZE = Number(process.env.AI_PARSE_BATCH_SIZE ?? "5");`) with:

```ts
// Upper bound on emails per run. The deadline below normally stops a run first.
const MAX_EMAILS_PER_RUN = Number(process.env.AI_PARSE_BATCH_SIZE ?? "5");
```

and after line 34 (`const MAX_ATTEMPTS = 3;`) add:

```ts
// host.json functionTimeout is 10 min (Consumption maximum). Every run gets a
// deadline of invocation start + 540 s; warm-up counts against it.
export const RUN_BUDGET_MS = 540_000;
// Claim another email only while a full toddler timeout plus 30 s of
// write-back still fits before the deadline.
const MIN_EMAIL_BUDGET_MS = TODDLER_TIMEOUT_MS + 30_000;
```

- [ ] **Step 4: Split the claim into a once-per-run sweep and a one-row claim**

Replace `claimBatch` (lines 154–194, the whole function) with:

```ts
// Rows that burned through their retries: stamp AIParsedAt so the queue
// filter stops picking them up, flag them for admin review, record why.
// Once per run; idempotent.
async function expireExhausted(token: string): Promise<void> {
  const connection = await createRequestConnection(token);
  try {
    await executeQuery(
      connection,
      `UPDATE Emails
         SET AIParsedAt = SYSUTCDATETIME(),
             AIFlaggedForReview = 1,
             AIParseError = ISNULL(AIParseError, 'Max retries exhausted')
       WHERE AIParsedAt IS NULL
         AND AIParseAttempts >= @MaxAttempts`,
      [{ name: "MaxAttempts", type: TYPES.Int, value: MAX_ATTEMPTS }],
    );
  } finally {
    closeConnection(connection);
  }
}

// Atomic claim of ONE row: bump its attempt counter and return it in one
// statement, so concurrent runners (queue, timer, daily retry) never share a
// row and a killed run costs at most this row one attempt.
async function claimOne(token: string): Promise<ClaimedEmail | null> {
  const connection = await createRequestConnection(token);
  try {
    const rows = (await executeQuery(
      connection,
      `UPDATE TOP (1) Emails
         SET AIParseAttempts = AIParseAttempts + 1
         OUTPUT inserted.EmailID, inserted.Subject, inserted.FromAddress,
                inserted.Body, inserted.AttachmentBlobs
       WHERE AIParsedAt IS NULL
         AND AIParseAttempts < @MaxAttempts`,
      [{ name: "MaxAttempts", type: TYPES.Int, value: MAX_ATTEMPTS }],
    )) as unknown as ClaimedEmail[];
    return rows[0] ?? null;
  } finally {
    closeConnection(connection);
  }
}
```

- [ ] **Step 5: Rewrite the runner**

Replace the `// ── Shared batch runner` section (the `ParseBatchResult` interface and `runParseBatch`, up to the `// ── Timer: parseEmailsDailyRetry` comment) with:

```ts
// ── Shared batch runner ────────────────────────────────────────────────────

export interface ParseBatchResult {
  claimed: number;
  errored: number;
  flagged: number;
  succeeded: number;
}

type EmailOutcome = "succeeded" | "flagged" | "errored";

async function parseClaimedEmail(
  token: string,
  email: ClaimedEmail,
  context: InvocationContext,
): Promise<EmailOutcome> {
  const hints = extractHints(email.Subject, email.Body);
  try {
    const result = await callToddler({
      attachments: hydrateAttachmentRefs(email.AttachmentBlobs),
      fromAddress: email.FromAddress,
      hints,
      html: email.Body ?? "",
      subject: email.Subject,
    });
    if (result.error) {
      // Toddler returned 200 but the LLM itself errored — treat as transient
      // so the email stays in the queue and gets retried. Toddler always
      // sends data: {} on failure, so `error` is the only discriminator.
      await recordTransientError(token, email.EmailID, new Error(result.error));
      return "errored";
    }
    await writeSuccess(token, email.EmailID, hints, result);
    return result.confidence === "low" || result.classification === "unknown" ? "flagged" : "succeeded";
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    await recordTransientError(token, email.EmailID, error).catch((e: unknown) =>
      context.error(`failed to record error for #${email.EmailID}:`, e instanceof Error ? e.message : String(e)),
    );
    context.error(`parse failed for email #${email.EmailID}:`, error.message);
    return "errored";
  }
}

// Deadline-driven: claims ONE row at a time and checks the remaining budget
// before every claim. `deadline` is epoch ms; callers pass invocation start +
// RUN_BUDGET_MS so warm-up time counts against it.
export async function runParseBatch(
  token: string,
  context: InvocationContext,
  deadline: number = Date.now() + RUN_BUDGET_MS,
): Promise<ParseBatchResult> {
  const totals: ParseBatchResult = { claimed: 0, errored: 0, flagged: 0, succeeded: 0 };
  if (!TODDLER_URL) {
    context.log("runParseBatch: TODDLER_URL not configured — skipping (AI service not yet deployed)");
    return totals;
  }
  if (!TODDLER_SERVICE_KEY) {
    context.error("runParseBatch: TODDLER_SERVICE_KEY not configured — skipping (every call would 401)");
    return totals;
  }

  await expireExhausted(token);

  while (totals.claimed < MAX_EMAILS_PER_RUN) {
    const remainingMs = deadline - Date.now();
    if (remainingMs < MIN_EMAIL_BUDGET_MS) {
      context.log(
        `runParseBatch: ${Math.round(remainingMs / 1000)}s left, under one email's budget — stopping; the next run continues`,
      );
      break;
    }
    const email = await claimOne(token);
    if (!email) break;
    totals.claimed++;
    const outcome = await parseClaimedEmail(token, email, context);
    if (outcome === "errored") {
      totals.errored++;
    } else {
      totals.succeeded++;
      if (outcome === "flagged") totals.flagged++;
    }
  }

  if (totals.claimed > 0) {
    context.log(
      `runParseBatch: claimed ${totals.claimed} email(s) — succeeded=${totals.succeeded}, flagged=${totals.flagged}, errored=${totals.errored}`,
    );
  }
  return totals;
}
```

- [ ] **Step 6: Set the Consumption-plan maximum timeout**

In `host.json` add `"functionTimeout": "00:10:00",` directly after `"version": "2.0",`. Result:

```json
{
  "version": "2.0",
  "functionTimeout": "00:10:00",
  "logging": {
    "applicationInsights": {
      "samplingSettings": {
        "isEnabled": true,
        "excludedTypes": "Request"
      }
    }
  },
  "extensionBundle": {
    "id": "Microsoft.Azure.Functions.ExtensionBundle",
    "version": "[4.*, 5.0.0)"
  }
}
```

Budget note for the runbook: 600 s host limit; runs stop claiming by 540 s − (`TODDLER_TIMEOUT_MS` + 30 s) = 330 s after start with the default 180 s timeout, so the last email always has its full timeout plus 30 s of write-back and 60 s of host headroom before the kill.

- [ ] **Step 7: Run the whole parseEmails suite**

```
npx jest src/functions/parseEmails.test.ts
```

Expected: `Tests: 15 passed, 15 total` (11 from Task 1 + 4 runner).

- [ ] **Checkpoint:** run `npx tsc --noEmit && npx jest` (expected: all pass — 55 suites, 1219 tests) and hand to Will to commit.

---

### Task 4: Warm-up helper, shared `parseQueued`, `parseEmailsTimer`

**Files:**
- Modify: `src/functions/parseEmails.ts` (header comment lines 1–16; config after `TODDLER_TIMEOUT_MS`; new helpers after `callToddler`; `runParseBatch` config checks; `parseEmailsDailyRetry` section; registrations)
- Test: `src/functions/parseEmails.test.ts`

`adminTriggerEmailParse` is left alone here — Task 6 turns it into an enqueue.

- [ ] **Step 1: Generalise the module loader and add fetch-routing helpers in the test file**

In `src/functions/parseEmails.test.ts` replace the block from `type RunParseBatch = …` through the end of `loadRunParseBatch` with:

```ts
type ParseEmailsModule = typeof import("./parseEmails");
type RunParseBatch = ParseEmailsModule["runParseBatch"];

// TODDLER_* / AI_PARSE_* are read at module load, so each test loads a fresh copy.
function loadParseEmails(env: Record<string, string | undefined>): ParseEmailsModule {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let mod: ParseEmailsModule | undefined;
  jest.isolateModules(() => {
    mod = require("./parseEmails") as ParseEmailsModule;
  });
  if (!mod) throw new Error("module failed to load");
  return mod;
}

function loadRunParseBatch(env: Record<string, string | undefined>): RunParseBatch {
  return loadParseEmails(env).runParseBatch;
}
```

Then, directly after the existing `mockFetchJson` helper, add:

```ts
interface FetchStub {
  body: unknown;
  ok?: boolean;
  status?: number;
}

// Routes fetch by URL path so a test can give /warmup and /parse-incoming
// different answers.
function mockFetchRoutes(routes: Record<string, FetchStub>): jest.Mock {
  const fetchMock = jest.fn().mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    const stub = routes[path];
    if (!stub) throw new Error(`unexpected fetch ${url}`);
    return {
      json: async () => stub.body,
      ok: stub.ok ?? true,
      status: stub.status ?? 200,
      text: async () => JSON.stringify(stub.body),
    };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function fetchedPaths(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls.map((c: unknown[]) => new URL(String(c[0])).pathname);
}

// Queue check answers "rows waiting"; the claim hands out claimedEmail once.
function stubQueue(hasRows: boolean): void {
  stubClaims(hasRows ? [claimedEmail] : [], (sql) =>
    sql.includes("SELECT TOP (1) EmailID") ? (hasRows ? [{ EmailID: 42 }] : []) : undefined,
  );
}
```

- [ ] **Step 2: Add the failing timer tests**

Append to `src/functions/parseEmails.test.ts`:

```ts
describe("parseEmailsTimer", () => {
  const TIMER_ENV = { ...ENV, MYBUILDINGS_BEARER_TOKEN: "sql-tok" };
  const warmupOk = { elapsedMs: 1200, loaded: true, model: "qwen3:14b" };

  it("returns without calling toddler when no unparsed rows are queued", async () => {
    const fetchMock = mockFetchRoutes({ "/parse-incoming": { body: toddlerOk }, "/warmup": { body: warmupOk } });
    stubQueue(false);
    const { parseEmailsTimer } = loadParseEmails(TIMER_ENV);

    await parseEmailsTimer(null, context);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sqlOfCalls()).toEqual([expect.stringContaining("SELECT TOP (1) EmailID")]);
  });

  it("aborts the tick on warm-up failure without touching any row", async () => {
    const fetchMock = mockFetchRoutes({
      "/parse-incoming": { body: toddlerOk },
      "/warmup": { body: { error: "model load failed" }, ok: false, status: 503 },
    });
    stubQueue(true);
    const { parseEmailsTimer } = loadParseEmails(TIMER_ENV);

    await parseEmailsTimer(null, context);

    expect(fetchedPaths(fetchMock)).toEqual(["/warmup"]);
    expect(sqlOfCalls().some((s) => /UPDATE/i.test(s))).toBe(false);
  });

  it("runs the batch after a successful warm-up", async () => {
    const fetchMock = mockFetchRoutes({ "/parse-incoming": { body: toddlerOk }, "/warmup": { body: warmupOk } });
    stubQueue(true);
    const { parseEmailsTimer } = loadParseEmails(TIMER_ENV);

    await parseEmailsTimer(null, context);

    expect(fetchedPaths(fetchMock)).toEqual(["/warmup", "/parse-incoming"]);
    const [, warmupInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(warmupInit.method).toBe("POST");
    expect(warmupInit.headers).toMatchObject({ "X-Service-Key": "test-key" });
    expect(sqlOfCalls().some((s) => s.includes("AIClassification = @Classification"))).toBe(true);
  });

  it("skips entirely when TODDLER_URL is unset", async () => {
    const fetchMock = mockFetchRoutes({});
    stubQueue(true);
    const { parseEmailsTimer } = loadParseEmails({ ...TIMER_ENV, TODDLER_URL: undefined });

    await parseEmailsTimer(null, context);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the new tests — red**

```
npx jest src/functions/parseEmails.test.ts -t "parseEmailsTimer"
```

Expected: ts-jest diagnostic `TS2339: Property 'parseEmailsTimer' does not exist on type 'typeof import(".../src/functions/parseEmails")'`.

- [ ] **Step 4: Update the module header and config**

In `src/functions/parseEmails.ts` replace lines 1–16 (the header comment) with:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// Email AI parsing — timer-driven worker + admin-only flagged read.
//
// Every trigger runs `parseQueued`:
//   1. Cheap queue check — no unparsed rows → return before touching toddler,
//      so the GPU Container App stays at zero replicas overnight.
//   2. POST /warmup — absorbs the cold start (image pull + model load) so the
//      per-email timeout is only ever measured against a warm model.
//   3. `runParseBatch` — deadline-driven: claims ONE row at a time, stops
//      claiming once less than TODDLER_TIMEOUT_MS + 30 s remains before
//      invocation start + 540 s (host.json functionTimeout is 10 min).
//
// Triggers: `parseEmailsTimer` (every 2 min) and `parseEmailsDailyRetry`
// (02:00 UTC).
//
// `getFlaggedEmails` is the read-side for the dev-only Flagged Incoming page.
// It returns rows where the AI flagged low confidence, errored, or never
// responded. The page is read-only — no mutations here, just a diagnosis view.
// ─────────────────────────────────────────────────────────────────────────────
```

Then after the `const TODDLER_TIMEOUT_MS = …` line add:

```ts
// Warm-up budget covers a cold Container App replica: image pull plus a ~9 GB
// model load from Azure Files. Spec §3.3 expects 1–3 min; 4 min is the cap,
// and parseQueued shrinks it further if the run's deadline is closer.
const TODDLER_WARMUP_TIMEOUT_MS = Number(process.env.TODDLER_WARMUP_TIMEOUT_MS ?? "240000");
```

- [ ] **Step 5: Add `toddlerConfigured`, `warmUpToddler` and `hasUnparsedEmails`**

Insert directly after the end of `callToddler` (after its closing `}`):

```ts
// ── Warm-up ─────────────────────────────────────────────────────────────────

function toddlerConfigured(context: InvocationContext, caller: string): boolean {
  if (!TODDLER_URL) {
    context.log(`${caller}: TODDLER_URL not configured — skipping (AI service not yet deployed)`);
    return false;
  }
  if (!TODDLER_SERVICE_KEY) {
    context.error(`${caller}: TODDLER_SERVICE_KEY not configured — skipping (every call would 401)`);
    return false;
  }
  return true;
}

// POST /warmup loads the model (one-token chat) and returns when it is
// resident. False on any failure — callers skip the batch and the next run
// retries, so a cold start never burns an email's retry budget.
export async function warmUpToddler(
  context: InvocationContext,
  timeoutMs: number = TODDLER_WARMUP_TIMEOUT_MS,
): Promise<boolean> {
  if (!toddlerConfigured(context, "warmUpToddler")) return false;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(`${TODDLER_URL}/warmup`, {
      headers: { "X-Service-Key": TODDLER_SERVICE_KEY },
      method: "POST",
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Toddler warmup ${response.status}: ${text.slice(0, 200)}`);
    }
    context.log(`warmUpToddler: model ready after ${Date.now() - started}ms`);
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    context.error(`warmUpToddler: failed after ${Date.now() - started}ms —`, message);
    return false;
  } finally {
    clearTimeout(t);
  }
}

// Same predicate as claimOne. Hits IX_Emails_AIParse_Queue.
async function hasUnparsedEmails(token: string): Promise<boolean> {
  const connection = await createRequestConnection(token);
  try {
    const rows = await executeQuery(
      connection,
      `SELECT TOP (1) EmailID
         FROM Emails
        WHERE AIParsedAt IS NULL
          AND AIParseAttempts < @MaxAttempts`,
      [{ name: "MaxAttempts", type: TYPES.Int, value: MAX_ATTEMPTS }],
    );
    return rows.length > 0;
  } finally {
    closeConnection(connection);
  }
}
```

- [ ] **Step 6: Route `runParseBatch`'s config checks through the helper**

Replace the two `if (!TODDLER_URL)` / `if (!TODDLER_SERVICE_KEY)` blocks at the top of `runParseBatch` with:

```ts
  if (!toddlerConfigured(context, "runParseBatch")) return totals;
```

- [ ] **Step 7: Add `parseQueued`, the timer, and route the daily retry through it**

Replace the `parseEmailsDailyRetry` section (comment + function) with:

```ts
// ── Warm parse: the one path every trigger shares ──────────────────────────
// config → token → cheap queue check (no SQL writes, no toddler call when
// idle) → warm-up → deadline runner. Warm-up counts against `deadline`; a
// failed warm-up records nothing. Never throws: failures go to Sentry and
// the next trigger retries.

async function parseQueued(caller: string, context: InvocationContext, deadline: number): Promise<void> {
  if (!toddlerConfigured(context, caller)) return;
  const token = process.env.MYBUILDINGS_BEARER_TOKEN;
  if (!token) {
    context.error(`${caller}: MYBUILDINGS_BEARER_TOKEN not set`);
    return;
  }

  try {
    if (!(await hasUnparsedEmails(token))) {
      context.log(`${caller}: no unparsed emails — toddler not called`);
      return;
    }
    const warmUpBudgetMs = Math.min(TODDLER_WARMUP_TIMEOUT_MS, deadline - Date.now() - MIN_EMAIL_BUDGET_MS);
    if (warmUpBudgetMs <= 0) {
      context.warn(`${caller}: no time left for warm-up plus one email — the next run continues`);
      return;
    }
    if (!(await warmUpToddler(context, warmUpBudgetMs))) return;
    const result = await runParseBatch(token, context, deadline);
    context.log(
      `${caller} done: claimed=${result.claimed}, succeeded=${result.succeeded}, flagged=${result.flagged}, errored=${result.errored}`,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    context.error(`${caller} failed:`, message);
    Sentry.captureException(err, { extra: { context: `${caller} failed` } });
  } finally {
    await Sentry.flush(2000);
  }
}

// ── Timer: parseEmailsTimer ────────────────────────────────────────────────
// Every 2 minutes. Timer triggers are singletons, so ticks never overlap.

export async function parseEmailsTimer(_timer: unknown, context: InvocationContext): Promise<void> {
  await parseQueued("parseEmailsTimer", context, Date.now() + RUN_BUDGET_MS);
}

// ── Timer: parseEmailsDailyRetry ───────────────────────────────────────────
// Once-a-day safety net for anything the 2-minute timer left behind (e.g. a
// run of warm-up failures). Scheduled at 02:00 UTC to share a DB wakeup with
// the other daily timers.

async function parseEmailsDailyRetry(_timer: unknown, context: InvocationContext): Promise<void> {
  await parseQueued("parseEmailsDailyRetry", context, Date.now() + RUN_BUDGET_MS);
}
```

- [ ] **Step 8: Register the timer**

Replace the registrations block (from `// ── Registrations` through the `parseEmailsDailyRetry` `app.timer` call) with:

```ts
// ── Registrations ──────────────────────────────────────────────────────────

// Every 2 minutes. Singleton, so ticks never overlap; the queue check keeps
// the GPU at zero replicas when nothing is waiting.
app.timer("parseEmailsTimer", {
  handler: parseEmailsTimer,
  schedule: "0 */2 * * * *",
});

// Daily at 02:00 UTC — coincides with other daily timers so the DB only
// wakes once for the batch.
app.timer("parseEmailsDailyRetry", {
  handler: parseEmailsDailyRetry,
  schedule: "0 0 2 * * *",
});
```

(leave the `triggerEmailParse` and `getFlaggedEmails` `app.http` registrations as they are.)

- [ ] **Step 9: Run the whole parseEmails suite**

```
npx jest src/functions/parseEmails.test.ts
```

Expected: `Tests: 19 passed, 19 total` (15 from Task 3 + 4 timer).

- [ ] **Checkpoint:** run `npx tsc --noEmit && npx jest` (expected: all pass — 55 suites, 1223 tests) and hand to Will to commit.

---

### Task 5: Skip already-stored messages before attachment download — `syncMailbox`

The sync filter is `receivedDateTime ge MAX(ReceivedAt)`. `ge` (not `gt`) is right — two mails sharing the newest timestamp must both be seen — but it means the newest stored message is re-listed on **every** sync, and `graphFetchEmails` downloads and re-uploads its attachments before `upsertGraphEmails` discovers the row exists, leaving orphan blobs. Fix: pass the MessageIDs already stored at or after that timestamp into `graphFetchEmails`, which drops them before touching attachments. The one shared `syncMailbox` helper is what `processEmailSync` calls in Task 6.

**Files:**
- Modify: `src/graph.ts` (`graphFetchEmails` ~lines 289–347)
- Test: `src/graph.test.ts`
- Create: `src/email/mail-sync.ts`
- Test: `src/email/mail-sync.test.ts`

- [ ] **Step 1: Write the failing Graph test**

Create `src/graph.test.ts`:

```ts
/// <reference types="jest" />
jest.mock("./blob-storage", () => ({
  uploadBlob: jest
    .fn()
    .mockImplementation(async (_buf: Buffer, name: string, _type: string, prefix: string) => ({
      blobName: `${prefix}/${name}`,
    })),
}));

import { graphFetchEmails } from "./graph";

const blob = require("./blob-storage") as { uploadBlob: jest.Mock };

const MESSAGES = [
  { hasAttachments: true, id: "g-old", internetMessageId: "<old@x>", receivedDateTime: "2026-10-06T01:00:00Z", subject: "Old" },
  { hasAttachments: true, id: "g-new", internetMessageId: "<new@x>", receivedDateTime: "2026-10-06T01:00:00Z", subject: "New" },
];

function respond(body: unknown): unknown {
  return { arrayBuffer: async () => new ArrayBuffer(4), json: async () => body, ok: true, status: 200, text: async () => "" };
}

// Token, message list, attachment list and attachment bytes, routed by URL.
function routeGraph(): jest.Mock {
  const fetchMock = jest.fn().mockImplementation(async (input: string) => {
    const url = String(input);
    if (url.startsWith("https://login.microsoftonline.com/")) return respond({ access_token: "graph-tok" });
    if (url.includes("/attachments?")) {
      return respond({
        value: [{ "@odata.type": "#microsoft.graph.fileAttachment", contentType: "application/pdf", id: "a1", name: "quote.pdf" }],
      });
    }
    if (url.endsWith("/$value")) return respond({});
    if (url.includes("/mailFolders/Inbox/messages")) return respond({ value: MESSAGES });
    throw new Error(`unexpected fetch ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GRAPH_TENANT_ID = "tenant";
  process.env.GRAPH_CLIENT_ID = "client";
  process.env.GRAPH_CLIENT_SECRET = "secret";
});

describe("graphFetchEmails → already-stored messages", () => {
  it("drops a known message before fetching its attachments", async () => {
    const fetchMock = routeGraph();

    const emails = await graphFetchEmails("inbox@example.test", "2026-10-06T01:00:00.000Z", new Set(["<old@x>"]));

    expect(emails.map((e) => e.internetMessageId)).toEqual(["<new@x>"]);
    const urls = fetchMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(urls.some((u) => u.includes("/messages/g-old/"))).toBe(false);
  });

  it("still downloads and uploads attachments for a new message", async () => {
    routeGraph();

    const emails = await graphFetchEmails("inbox@example.test", "2026-10-06T01:00:00.000Z", new Set(["<old@x>"]));

    expect(emails[0].attachmentBlobNames).toEqual([
      { blobName: "email-attachments/g-new/quote.pdf", fileName: "quote.pdf" },
    ]);
    expect(blob.uploadBlob).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run — red**

```
npx jest src/graph.test.ts
```

Expected: ts-jest diagnostic `TS2554: Expected 1-2 arguments, but got 3.`

- [ ] **Step 3: Filter known messages in `graphFetchEmails`**

In `src/graph.ts` change the signature line to:

```ts
export async function graphFetchEmails(
  mailbox: string,
  sinceDateTime?: string,
  knownMessageIds: ReadonlySet<string> = new Set(),
): Promise<GraphEmail[]> {
```

and replace

```ts
  const emails = await Promise.all(
    (data.value ?? []).map(async (m) => {
```

with

```ts
  // The `ge` window always re-lists the newest stored message(s). Drop them
  // here, BEFORE their attachments are downloaded and re-uploaded as orphan
  // blobs. Keyed the same way upsertGraphEmails keys MessageID.
  const fresh = (data.value ?? []).filter(
    (m) => !knownMessageIds.has(m.internetMessageId ?? m.id),
  );

  const emails = await Promise.all(
    fresh.map(async (m) => {
```

- [ ] **Step 4: Run — green**

```
npx jest src/graph.test.ts
```

Expected: `Tests: 2 passed, 2 total`.

- [ ] **Step 5: Write the failing `syncMailbox` test**

Create `src/email/mail-sync.test.ts`:

```ts
/// <reference types="jest" />
jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../graph", () => ({ graphFetchEmails: jest.fn().mockResolvedValue([]) }));
jest.mock("../functions/emails", () => ({ upsertGraphEmails: jest.fn().mockResolvedValue(undefined) }));

import { syncMailbox } from "./mail-sync";

const db = require("../db") as { executeQuery: jest.Mock };
const graph = require("../graph") as { graphFetchEmails: jest.Mock };
const emails = require("../functions/emails") as { upsertGraphEmails: jest.Mock };
const connection = {} as never;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("syncMailbox", () => {
  it("passes MessageIDs stored at or after the newest ReceivedAt to Graph", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (sql.includes("MAX(ReceivedAt)")) return [{ LatestReceivedAt: new Date("2026-10-06T01:00:00Z") }];
      if (sql.includes("SELECT MessageID FROM Emails")) return [{ MessageID: "<old@x>" }, { MessageID: null }];
      return [];
    });

    const result = await syncMailbox(connection, "inbox@example.test");

    expect(graph.graphFetchEmails).toHaveBeenCalledWith(
      "inbox@example.test",
      "2026-10-06T01:00:00.000Z",
      new Set(["<old@x>"]),
    );
    const known = db.executeQuery.mock.calls.find((c: unknown[]) => String(c[1]).includes("SELECT MessageID FROM Emails"));
    expect(String(known?.[1])).toMatch(/ReceivedAt >= @Since/);
    expect(emails.upsertGraphEmails).toHaveBeenCalledWith(connection, []);
    expect(result).toEqual({ fetched: 0, since: "2026-10-06T01:00:00.000Z" });
  });

  it("fetches everything with an empty known set when Emails is empty", async () => {
    db.executeQuery.mockResolvedValue([{ LatestReceivedAt: null }]);

    await syncMailbox(connection, "inbox@example.test");

    expect(graph.graphFetchEmails).toHaveBeenCalledWith("inbox@example.test", undefined, new Set());
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Run — red**

```
npx jest src/email/mail-sync.test.ts
```

Expected: `Cannot find module './mail-sync' from 'src/email/mail-sync.test.ts'`.

- [ ] **Step 7: Write the helper**

Create `src/email/mail-sync.ts`:

```ts
// Graph → Emails sync. Called by processEmailSync (parseEmails.ts) — the
// webhook and the manual sync button only enqueue.

import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { executeQuery } from "../db";
import { graphFetchEmails } from "../graph";
import { upsertGraphEmails } from "../functions/emails";

export interface MailboxSyncResult {
  fetched: number;
  since: string | null;
}

async function knownMessageIdsSince(connection: Connection, since: Date): Promise<Set<string>> {
  const rows = await executeQuery(
    connection,
    "SELECT MessageID FROM Emails WHERE ReceivedAt >= @Since",
    [{ name: "Since", type: TYPES.DateTime2, value: since }],
  );
  return new Set(rows.map((r) => r.MessageID).filter((id): id is string => typeof id === "string"));
}

// `receivedDateTime ge MAX(ReceivedAt)` — `ge`, not `gt`, so two mails that
// share the newest timestamp are both seen. The rows already stored in that
// window go to Graph as a skip-set, so their attachments are not refetched.
export async function syncMailbox(connection: Connection, mailbox: string): Promise<MailboxSyncResult> {
  const latestRows = await executeQuery(connection, "SELECT MAX(ReceivedAt) AS LatestReceivedAt FROM Emails");
  const rawDate = latestRows[0]?.LatestReceivedAt as Date | string | null | undefined;
  const since = rawDate ? new Date(rawDate) : null;

  const known = since ? await knownMessageIdsSince(connection, since) : new Set<string>();
  const emails = await graphFetchEmails(mailbox, since?.toISOString(), known);
  await upsertGraphEmails(connection, emails);

  return { fetched: emails.length, since: since?.toISOString() ?? null };
}
```

- [ ] **Step 8: Run — green**

```
npx jest src/email/mail-sync.test.ts src/graph.test.ts
```

Expected: `Tests: 4 passed, 4 total`.

Note: `upsertGraphEmails` keeps its `ELSE IF @AttachmentBlobs IS NOT NULL UPDATE …` branch, but Graph sync no longer re-sends a stored message, so a row whose first attachment upload failed is not back-filled on the next sync. That was the branch's only Graph-side use; recovery for such a row is a manual re-ingest.

- [ ] **Checkpoint:** run `npx tsc --noEmit && npx jest` (expected: all pass — 57 suites, 1229 tests: +4, +2 guard tests for `mail-sync.ts`) and hand to Will to commit.

---

### Task 6: Storage queue `email-sync` — no HTTP handler syncs or parses

Graph expects the webhook's 202 within **3 s** (10 s only for validation and retries; if more than 10% of responses in 10 minutes exceed 3 s, Graph marks the endpoint slow and delays notifications by 10 minutes), and every HTTP response is cut at 230 s. Today `graphNotification` awaits the Graph fetch, attachment downloads and `runParseBatch`; `syncEmailsNow` and `triggerEmailParse` also parse inline. All three now validate, write one message to the `email-sync` queue (on `AzureWebJobsStorage`, no new resource) and return 202. A queue-triggered `processEmailSync` does the Graph sync (Task 5) and then `parseQueued` (Task 4). `host.json` processes one message at a time with three attempts; duplicate messages are harmless because sync is idempotent and claims are row-level. `parseEmailsTimer` stays as the backstop.

**Files:**
- Create: `src/email/sync-queue.ts`
- Modify: `src/functions/graphWebhook.ts` (imports lines 4–9; handler lines 20–87; `graphNotification` registration)
- Modify: `src/functions/emails.ts` (imports; `syncEmailsNow` section; its registration)
- Modify: `src/functions/parseEmails.ts` (header; imports; `adminTriggerEmailParse` section; new `processEmailSync`; registrations)
- Modify: `host.json`
- Test: `src/functions/graphWebhook.test.ts` (create), `src/functions/parseEmails.test.ts`

- [ ] **Step 1: Write the failing webhook / manual-sync tests**

Create `src/functions/graphWebhook.test.ts`:

```ts
/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  createServiceConnection: jest.fn().mockResolvedValue({}),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
}));

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    extractToken: jest.fn().mockReturnValue("tok"),
    requireRole: jest.fn().mockResolvedValue(null),
  };
});

jest.mock("../graph", () => ({
  graphCreateSubscription: jest.fn(),
  graphFetchEmails: jest.fn().mockResolvedValue([]),
  graphRenewSubscription: jest.fn(),
}));

jest.mock("../blob-storage", () => ({ generateReadSasUrl: jest.fn() }));

jest.mock("./parseEmails", () => ({
  runParseBatch: jest.fn().mockResolvedValue({ claimed: 0, errored: 0, flagged: 0, succeeded: 0 }),
}));

jest.mock("../rateLimit", () => ({
  checkRateLimit: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }),
}));

import { emailSyncQueueOutput } from "../email/sync-queue";

const db = require("../db") as { createServiceRequestConnection: jest.Mock; executeQuery: jest.Mock };
const graph = require("../graph") as { graphFetchEmails: jest.Mock };
const parseEmails = require("./parseEmails") as { runParseBatch: jest.Mock };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: unknown }>;
const { graphNotification } = require("./graphWebhook") as { graphNotification: Handler };
const { syncEmailsNow } = require("./emails") as { syncEmailsNow: Handler };

function notification(clientState: string): HttpRequest {
  return {
    json: async () => ({ value: [{ changeType: "created", clientState, resource: "x" }] }),
    url: "https://fn.test/api/graphNotification",
  } as unknown as HttpRequest;
}

function expectNothingSyncedOrParsed(): void {
  expect(graph.graphFetchEmails).not.toHaveBeenCalled();
  expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
  expect(db.executeQuery).not.toHaveBeenCalled();
  expect(parseEmails.runParseBatch).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE = "secret-state";
  process.env.GRAPH_MAILBOX_DEV = "inbox@example.test";
  // Only the pre-change handler reads this; set so the red run reaches the
  // sync instead of returning early on a missing token.
  process.env.MYBUILDINGS_BEARER_TOKEN = "tok";
});

describe("graphNotification", () => {
  it("enqueues one email-sync message and returns 202 without syncing or parsing", async () => {
    const context = new InvocationContext();

    const res = await graphNotification(notification("secret-state"), context);

    expect(res.status).toBe(202);
    expect(context.extraOutputs.get(emailSyncQueueOutput)).toMatchObject({ source: "graph" });
    expectNothingSyncedOrParsed();
  });

  it("returns 202 and enqueues nothing when clientState does not match", async () => {
    const context = new InvocationContext();

    const res = await graphNotification(notification("wrong"), context);

    expect(res.status).toBe(202);
    expect(context.extraOutputs.get(emailSyncQueueOutput)).toBeUndefined();
    expectNothingSyncedOrParsed();
  });
});

describe("syncEmailsNow", () => {
  it("enqueues a manual sync and returns 202 without touching Graph or SQL", async () => {
    const context = new InvocationContext();
    const request = { headers: { get: () => null }, json: jest.fn(), query: new URLSearchParams() } as unknown as HttpRequest;

    const res = await syncEmailsNow(request, context);

    expect(res.status).toBe(202);
    expect(context.extraOutputs.get(emailSyncQueueOutput)).toMatchObject({ source: "manual" });
    expectNothingSyncedOrParsed();
  });
});
```

- [ ] **Step 2: Run — red**

```
npx jest src/functions/graphWebhook.test.ts
```

Expected: `Cannot find module '../email/sync-queue' from 'src/functions/graphWebhook.test.ts'`.

- [ ] **Step 3: Create the queue module**

Create `src/email/sync-queue.ts`:

```ts
// Storage queue "email-sync" on the Function App's own AzureWebJobsStorage
// account (no new resource). HTTP handlers enqueue and return 202; the
// queue-triggered processEmailSync (parseEmails.ts) does the Graph sync,
// attachments and the deadline-driven parse. No HTTP request ever waits on
// a cold GPU (230 s response cap; Graph's webhook deadline is 3 s).

import { InvocationContext, output } from "@azure/functions";

export const EMAIL_SYNC_QUEUE = "email-sync";

export const emailSyncQueueOutput = output.storageQueue({
  connection: "AzureWebJobsStorage",
  queueName: EMAIL_SYNC_QUEUE,
});

export type EmailSyncSource = "graph" | "manual" | "admin";

export interface EmailSyncMessage {
  requestedAt: string;
  source: EmailSyncSource;
}

// The host writes the message when the handler returns. Handlers that call
// this must list emailSyncQueueOutput in their registration's extraOutputs.
// Duplicates are harmless — sync is idempotent and claims are row-level.
export function enqueueEmailSync(context: InvocationContext, source: EmailSyncSource): void {
  const message: EmailSyncMessage = { requestedAt: new Date().toISOString(), source };
  context.extraOutputs.set(emailSyncQueueOutput, message);
}

export function isEmailSyncMessage(value: unknown): value is EmailSyncMessage {
  if (typeof value !== "object" || value === null) return false;
  const source = (value as { source?: unknown }).source;
  return source === "graph" || source === "manual" || source === "admin";
}
```

- [ ] **Step 4: Rewrite the webhook to validate + enqueue**

In `src/functions/graphWebhook.ts`:

1. Replace lines 4–9 (the `../db` import through the `../rateLimit` import) with:

```ts
import { createRequestConnection, createServiceConnection, executeQuery, closeConnection } from "../db";
import { AppRole, extractToken, oidFromToken, requireRole, unauthorizedResponse, errorResponse } from "../auth";
import { graphCreateSubscription, graphRenewSubscription } from "../graph";
import { emailSyncQueueOutput, enqueueEmailSync } from "../email/sync-queue";
import { checkRateLimit } from "../rateLimit";
```

2. Replace the handler (the `// ── POST /api/graphNotification` comment through the function's closing `}`, lines 20–87) with:

```ts
// ── POST /api/graphNotification ─────────────────────────────────────────────
// Receives Graph change notifications when new email arrives in the mailbox.
// Also handles the one-time validation POST that Graph sends when a
// subscription is first created (validationToken in query params).
//
// Validate and enqueue only — no Graph fetch, no attachment download, no
// parsing. processEmailSync (parseEmails.ts) does all of that off the
// "email-sync" queue.

export async function graphNotification(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  // Subscription validation handshake — must echo validationToken as plain text
  const validationToken = new URL(request.url).searchParams.get("validationToken");
  if (validationToken) {
    return { status: 200, headers: { "Content-Type": "text/plain" }, body: validationToken };
  }

  interface GraphChangeNotification { clientState?: string; subscriptionId?: string; changeType?: string; resource?: string }
  const body = (await request.json().catch(() => null)) as { value?: GraphChangeNotification[] } | null;
  const notifications: GraphChangeNotification[] = body?.value ?? [];
  const clientState = process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE;
  if (!clientState) {
    context.error("graphNotification: GRAPH_SUBSCRIPTION_CLIENT_STATE is not configured — rejecting all notifications");
    return { status: 202 };
  }

  const valid = notifications.filter((n) =>
    typeof n.clientState === "string" && timingSafeCompareString(n.clientState, clientState),
  );

  if (valid.length === 0) {
    context.warn("graphNotification: no valid notifications (clientState mismatch)");
    return { status: 202 };
  }

  // One message per POST however many notifications it carries — the sync
  // fetches everything since the newest stored row anyway.
  enqueueEmailSync(context, "graph");

  // Graph wants the 202 within 3 s (10 s only for validation and retries);
  // slower than that on >10% of calls in 10 min and it marks the endpoint
  // slow and delays notifications by 10 minutes.
  return { status: 202 };
}
```

3. Change the `graphNotification` registration to:

```ts
app.http("graphNotification", {
  methods: ["POST"],
  authLevel: "anonymous",
  extraOutputs: [emailSyncQueueOutput],
  handler: graphNotification,
});
```

- [ ] **Step 5: Make `syncEmailsNow` enqueue**

In `src/functions/emails.ts`:

1. In the import block change `import { graphFetchEmails, GraphEmail } from "../graph";` to `import { GraphEmail } from "../graph";`, delete `import { runParseBatch } from "./parseEmails";`, and add after the `job-ref` import:

```ts
import { emailSyncQueueOutput, enqueueEmailSync } from "../email/sync-queue";
```

2. Replace the `// ── POST /api/syncEmailsNow` section (comment + function) with:

```ts
// ── POST /api/syncEmailsNow ─────────────────────────────────────────────────
// Manual "check mail now". Enqueues an email-sync message and returns 202;
// processEmailSync (parseEmails.ts) does the Graph sync and the parse, so
// the request never waits on Graph or a cold model.

export async function syncEmailsNow(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

  if (!process.env.GRAPH_MAILBOX_DEV) {
    return { status: 500, jsonBody: { error: "GRAPH_MAILBOX_DEV not configured" } };
  }

  enqueueEmailSync(context, "manual");
  return { status: 202, jsonBody: { queued: true } };
}
```

3. Change its registration to:

```ts
app.http("syncEmailsNow", {
  methods: ["POST"],
  authLevel: "anonymous",
  extraOutputs: [emailSyncQueueOutput],
  handler: syncEmailsNow,
});
```

- [ ] **Step 6: Run the webhook tests — green**

```
npx jest src/functions/graphWebhook.test.ts
```

Expected: `Tests: 3 passed, 3 total`.

- [ ] **Step 7: Add the failing trigger / queue tests in `parseEmails.test.ts`**

At the top of `src/functions/parseEmails.test.ts`:

1. Change line 2 to `import { HttpRequest, InvocationContext } from "@azure/functions";`.
2. In the `@azure/functions` mock change the `app` object to `{ http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() }`.
3. In the `../db` mock add `createServiceRequestConnection: jest.fn().mockResolvedValue({}),`.
4. In the `../auth` mock return `{ ...actual, extractToken: jest.fn().mockReturnValue("tok"), requireRole: jest.fn().mockResolvedValue(null) }`.
5. After the `../sentry` mock add:

```ts
jest.mock("../email/mail-sync", () => ({
  syncMailbox: jest.fn().mockResolvedValue({ fetched: 2, since: null }),
}));

import { emailSyncQueueOutput } from "../email/sync-queue";
```

6. After the `const db = require("../db") …` line add:

```ts
// Required here so isolated module loads reuse this same mock instance.
const mailSync = require("../email/mail-sync") as { syncMailbox: jest.Mock };
```

Append:

```ts
describe("triggerEmailParse", () => {
  function adminRequest(query = ""): HttpRequest {
    return { headers: { get: () => null }, query: new URLSearchParams(query) } as unknown as HttpRequest;
  }

  it("enqueues an admin sync and returns 202 without calling toddler or SQL", async () => {
    const fetchMock = mockFetchRoutes({});
    const { adminTriggerEmailParse } = loadParseEmails(ENV);
    const invocation = new InvocationContext();

    const res = await adminTriggerEmailParse(adminRequest(), invocation);

    expect(res.status).toBe(202);
    expect(invocation.extraOutputs.get(emailSyncQueueOutput)).toMatchObject({ source: "admin" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("?reset=true resets failed rows inline, then enqueues", async () => {
    mockFetchRoutes({});
    const { adminTriggerEmailParse } = loadParseEmails(ENV);
    const invocation = new InvocationContext();

    const res = await adminTriggerEmailParse(adminRequest("reset=true"), invocation);

    expect(res.status).toBe(202);
    expect(sqlOfCalls()).toHaveLength(1);
    expect(sqlOfCalls()[0]).toMatch(/AIParseAttempts\s+= 0/);
    expect(invocation.extraOutputs.get(emailSyncQueueOutput)).toMatchObject({ source: "admin" });
  });

  it("returns 503 and enqueues nothing when toddler is not configured", async () => {
    const { adminTriggerEmailParse } = loadParseEmails({ ...ENV, TODDLER_URL: undefined });
    const invocation = new InvocationContext();

    const res = await adminTriggerEmailParse(adminRequest(), invocation);

    expect(res.status).toBe(503);
    expect(invocation.extraOutputs.get(emailSyncQueueOutput)).toBeUndefined();
  });
});

describe("processEmailSync", () => {
  const QUEUE_ENV = { ...ENV, GRAPH_MAILBOX_DEV: "inbox@example.test", MYBUILDINGS_BEARER_TOKEN: "sql-tok" };

  it("syncs the mailbox, then warms up and runs the deadline runner", async () => {
    const fetchMock = mockFetchRoutes({ "/parse-incoming": { body: toddlerOk }, "/warmup": { body: { loaded: true } } });
    stubQueue(true);
    const { processEmailSync } = loadParseEmails(QUEUE_ENV);

    await processEmailSync({ requestedAt: "2026-10-07T00:00:00.000Z", source: "graph" }, context);

    expect(mailSync.syncMailbox).toHaveBeenCalledWith({}, "inbox@example.test");
    expect(fetchedPaths(fetchMock)).toEqual(["/warmup", "/parse-incoming"]);
    expect(mailSync.syncMailbox.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
  });

  it("rethrows a sync failure so the queue retries, without calling toddler", async () => {
    const fetchMock = mockFetchRoutes({});
    mailSync.syncMailbox.mockRejectedValueOnce(new Error("Graph fetch emails failed: 503"));
    const { processEmailSync } = loadParseEmails(QUEUE_ENV);

    await expect(
      processEmailSync({ requestedAt: "2026-10-07T00:00:00.000Z", source: "manual" }, context),
    ).rejects.toThrow("Graph fetch emails failed: 503");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 8: Run them — red**

```
npx jest src/functions/parseEmails.test.ts -t "triggerEmailParse|processEmailSync"
```

Expected: ts-jest diagnostics `TS2339: Property 'adminTriggerEmailParse' does not exist …` and `TS2339: Property 'processEmailSync' does not exist …`.

- [ ] **Step 9: Imports and header in `parseEmails.ts`**

Replace the `../db` import with:

```ts
import {
  closeConnection,
  createRequestConnection,
  createServiceRequestConnection,
  executeQuery,
  SqlRow,
} from "../db";
```

and add after the `../blob-storage` import:

```ts
import { syncMailbox } from "../email/mail-sync";
import { EMAIL_SYNC_QUEUE, emailSyncQueueOutput, enqueueEmailSync, isEmailSyncMessage } from "../email/sync-queue";
```

In the header comment replace the two `// Triggers: …` lines with:

```ts
// Triggers — no HTTP handler parses:
//   - `processEmailSync` (Storage queue "email-sync"): fed by the Graph
//     webhook, the manual sync button and `triggerEmailParse`; syncs the
//     mailbox first, then parses.
//   - `parseEmailsTimer` (every 2 min): backstop for lost/failed messages.
//   - `parseEmailsDailyRetry` (02:00 UTC): once-a-day safety net.
```

- [ ] **Step 10: Turn the admin trigger into an enqueue**

Replace the `// ── POST /api/adminTriggerEmailParse` section (comment + function) with:

```ts
// ── POST /api/triggerEmailParse ────────────────────────────────────────────
// Admin-only manual trigger. Enqueues an email-sync message and returns 202;
// processEmailSync runs the sync + warm-up + deadline runner off the queue.
// ?reset=true first clears failed/errored rows back into the queue (one
// UPDATE, fast) so a manual trigger can recover from bugs that burned
// through retries.

export async function adminTriggerEmailParse(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, [AppRole.ADMIN]);
  if (roleCheck) return roleCheck;

  if (!toddlerConfigured(context, "adminTriggerEmailParse")) {
    return { status: 503, jsonBody: { error: "Email AI parsing is not configured (TODDLER_URL / TODDLER_SERVICE_KEY)" } };
  }

  try {
    const reset = request.query.get("reset") === "true" ? await resetFailedEmails(token) : 0;
    if (reset > 0) context.log(`adminTriggerEmailParse: reset ${reset} failed email(s)`);
    enqueueEmailSync(context, "admin");
    return { status: 202, jsonBody: { queued: true, reset } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("adminTriggerEmailParse failed:", message);
    return errorResponse("Email parse trigger failed", message);
  }
}
```

- [ ] **Step 11: Add the queue handler**

Insert directly after `parseEmailsDailyRetry`:

```ts
// ── Queue: processEmailSync ────────────────────────────────────────────────
// One message per webhook / manual sync / admin trigger. Graph sync (with
// attachments) then the shared warm parse, inside one deadline. A sync
// failure rethrows so the queue retries (maxDequeueCount 3, then
// email-sync-poison); parse failures never throw — they are recorded per row.

export async function processEmailSync(message: unknown, context: InvocationContext): Promise<void> {
  const deadline = Date.now() + RUN_BUDGET_MS;
  const source = isEmailSyncMessage(message) ? message.source : "unknown";

  const mailbox = process.env.GRAPH_MAILBOX_DEV;
  if (!mailbox) {
    context.error("processEmailSync: GRAPH_MAILBOX_DEV not configured — parsing without a sync");
  } else {
    const connection = await createServiceRequestConnection();
    try {
      const { fetched, since } = await syncMailbox(connection, mailbox);
      context.log(`processEmailSync (${source}): synced ${fetched} email(s) from ${mailbox} (since=${since ?? "beginning"})`);
    } finally {
      closeConnection(connection);
    }
  }

  await parseQueued("processEmailSync", context, deadline);
}
```

- [ ] **Step 12: Register the queue trigger and the trigger's output**

In the registrations block, after the `parseEmailsDailyRetry` timer, add:

```ts
// One message at a time per instance (host.json queues.batchSize 1). Three
// attempts, then email-sync-poison; the 2-minute timer still parses whatever
// is queued.
app.storageQueue("processEmailSync", {
  connection: "AzureWebJobsStorage",
  handler: processEmailSync,
  queueName: EMAIL_SYNC_QUEUE,
});
```

and change the `triggerEmailParse` registration to:

```ts
app.http("triggerEmailParse", {
  authLevel: "anonymous",
  extraOutputs: [emailSyncQueueOutput],
  handler: adminTriggerEmailParse,
  methods: ["POST"],
});
```

- [ ] **Step 13: Queue settings in `host.json`**

Add after the `"functionTimeout"` line:

```json
  "extensions": {
    "queues": {
      "batchSize": 1,
      "maxDequeueCount": 3
    }
  },
```

(`newBatchThreshold` defaults to `batchSize / 2` = 0, so an instance never fetches a second message while one is running.)

- [ ] **Step 14: Run the affected suites**

```
npx jest src/functions/parseEmails.test.ts src/functions/graphWebhook.test.ts
```

Expected: `Tests: 27 passed, 27 total` (24 parseEmails = 19 + 3 trigger + 2 queue; 3 webhook / manual sync).

- [ ] **Step 15: Confirm nothing but parseEmails.ts calls the batch, and nothing HTTP-registered syncs**

```
grep -rn "runParseBatch\|syncMailbox\|graphFetchEmails" src --include=*.ts | grep -v "\.test\.ts"
```

Expected: `runParseBatch` and `syncMailbox` only in `src/functions/parseEmails.ts` (plus `syncMailbox`'s definition in `src/email/mail-sync.ts`); `graphFetchEmails` only in `src/graph.ts` and `src/email/mail-sync.ts`.

- [ ] **Checkpoint:** run `npx tsc --noEmit && npx jest` (expected: all pass — 58 suites, 1239 tests: +8, +2 guard tests for `sync-queue.ts`) and hand to Will to commit.

> Local dev: the queue trigger needs a storage emulator. With `AzureWebJobsStorage=UseDevelopmentStorage=true` in `local.settings.json`, run Azurite (`npx azurite --silent` or the VS Code extension) before `npm start`.

---

### Task 7: `knownJob`, widened classification, `AI_PARSE_SKIP_SENDERS`

**Files:**
- Modify: `src/functions/parseEmails.ts` (toddler types ~lines 73–88; `ClaimedEmail` + `claimOne` OUTPUT; `writeSuccess`; new `loadKnownJob` + skip-sender helpers; `parseClaimedEmail`)
- Test: `src/functions/parseEmails.test.ts`

- [ ] **Step 1: Extend the fixture and add the failing `knownJob` / skip-sender tests**

In `src/functions/parseEmails.test.ts` change the `claimedEmail` fixture to:

```ts
const claimedEmail = {
  AttachmentBlobs: null,
  Body: "<p>Please quote Q-123</p>",
  EmailID: 42,
  FromAddress: "a@b.com",
  MatchedJobID: null as number | null,
  Subject: "Quote request",
};
```

and add `AI_PARSE_SKIP_SENDERS: undefined,` as the first key of `ENV`.

Append:

```ts
describe("runParseBatch → knownJob", () => {
  const knownJobRow = {
    AwaitingQuoteAmount: 1234,
    AwaitingQuoteID: 7,
    AwaitingQuoteNumber: "260419-QT-42-ACM-1",
    ContractorName: "Acme Plumbing",
    JobID: 42,
    Status: "Work",
    Title: "Leaking tap L2 kitchen",
  };

  function stubClaim(email: typeof claimedEmail, jobRow: typeof knownJobRow | null): void {
    stubClaims([email], (sql) => (sql.includes("FROM Jobs j") ? (jobRow ? [jobRow] : []) : undefined));
  }

  function sentBody(fetchMock: jest.Mock): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it("sends knownJob when the email is matched to a job", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    stubClaim({ ...claimedEmail, MatchedJobID: 42 }, knownJobRow);
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    expect(sentBody(fetchMock).knownJob).toEqual({
      awaitingDirectorQuote: { amount: 1234, quoteId: 7, quoteNumber: "260419-QT-42-ACM-1" },
      contractorName: "Acme Plumbing",
      jobId: 42,
      status: "Work",
      title: "Leaking tap L2 kitchen",
    });
  });

  it("sends awaitingDirectorQuote: null when no quote is awaiting the director", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    stubClaim(
      { ...claimedEmail, MatchedJobID: 42 },
      { ...knownJobRow, AwaitingQuoteAmount: null, AwaitingQuoteID: null, AwaitingQuoteNumber: null },
    );
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    const knownJob = sentBody(fetchMock).knownJob as { awaitingDirectorQuote: unknown };
    expect(knownJob.awaitingDirectorQuote).toBeNull();
  });

  it("omits knownJob and skips the lookup when MatchedJobID is null", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    stubClaim(claimedEmail, knownJobRow);
    const run = loadRunParseBatch(ENV);

    await run("tok", context);

    expect("knownJob" in sentBody(fetchMock)).toBe(false);
    expect(sqlOfCalls().some((s) => s.includes("FROM Jobs j"))).toBe(false);
  });

  it("still parses (without knownJob) when the matched job no longer exists", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    stubClaim({ ...claimedEmail, MatchedJobID: 999 }, null);
    const run = loadRunParseBatch(ENV);

    const result = await run("tok", context);

    expect(result.succeeded).toBe(1);
    expect("knownJob" in sentBody(fetchMock)).toBe(false);
  });
});

describe("runParseBatch → AI_PARSE_SKIP_SENDERS", () => {
  it("short-circuits a matching sender to unknown/high without calling toddler", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    stubClaims([{ ...claimedEmail, FromAddress: "No-Reply@MyBuildings.com.au" }]);
    const run = loadRunParseBatch({ ...ENV, AI_PARSE_SKIP_SENDERS: "no-reply@, bounces@" });

    const result = await run("tok", context);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ claimed: 1, errored: 0, flagged: 0, succeeded: 1 });
    const write = db.executeQuery.mock.calls.find((c: unknown[]) =>
      String(c[1]).includes("AIClassification = @Classification"),
    ) as unknown[] | undefined;
    const params = Object.fromEntries(
      ((write?.[2] as { name: string; value: unknown }[]) ?? []).map((p) => [p.name, p.value]),
    );
    expect(params).toMatchObject({
      Classification: "unknown",
      Confidence: "high",
      Flagged: 0,
      ModelVersion: "skip-sender@v5",
    });
  });

  it("calls toddler as normal when the setting is empty", async () => {
    const fetchMock = mockFetchJson(toddlerOk);
    const run = loadRunParseBatch({ ...ENV, AI_PARSE_SKIP_SENDERS: undefined });

    await run("tok", context);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run them — red**

```
npx jest src/functions/parseEmails.test.ts -t "knownJob|SKIP_SENDERS"
```

Expected: "sends knownJob…" fails with `Expected: {…} Received: undefined`; "omits knownJob…" passes trivially; "short-circuits…" fails with `expect(jest.fn()).not.toHaveBeenCalled()` … `Received number of calls: 1`.

- [ ] **Step 3: Widen the toddler types**

In `src/functions/parseEmails.ts` replace the `ToddlerRequest` and `ToddlerResponse` interfaces (~lines 73–88) with:

```ts
export type ToddlerClassification =
  | "job"
  | "job-update"
  | "quote"
  | "quote-approval"
  | "invoice"
  | "unknown";

// Context from our own DB, rendered into the prompt outside the attachment
// fences. Mirrors KnownJob / AwaitingDirectorQuote in toddler's
// models/incoming.py — keep the field names in step.
export interface AwaitingDirectorQuote {
  quoteId: number;
  quoteNumber: string | null;
  amount: number | null;
}

export interface KnownJob {
  jobId: number;
  title: string | null;
  status: string | null;
  contractorName: string | null;
  awaitingDirectorQuote: AwaitingDirectorQuote | null;
}

interface ToddlerRequest {
  html: string;
  subject?: string | null;
  fromAddress?: string | null;
  hints: { poNumber?: string | null; quoteNumber?: string | null };
  attachments: ToddlerAttachmentRef[];
  knownJob?: KnownJob;
}

interface ToddlerResponse {
  classification: ToddlerClassification;
  confidence: "high" | "medium" | "low";
  data: Record<string, unknown>;
  modelVersion: string;
  rawResponse: string | null;
  error: string | null;
}
```

- [ ] **Step 4: Add skip-sender config and helpers**

Directly after the `ToddlerResponse` interface add:

```ts
// ── Skip-senders ────────────────────────────────────────────────────────────
// Comma-separated, case-insensitive substrings matched against FromAddress
// (e.g. "no-reply@,notifications@mybuildings"). Matching rows are classified
// unknown/high deterministically — no GPU call, and not flagged: there is
// nothing for a reviewer to second-guess.

const SKIP_SENDERS = (process.env.AI_PARSE_SKIP_SENDERS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s.length > 0);

const SKIP_SENDER_MODEL_VERSION = "skip-sender@v5";

export function isSkippedSender(fromAddress: string | null): boolean {
  if (!fromAddress || SKIP_SENDERS.length === 0) return false;
  const address = fromAddress.toLowerCase();
  return SKIP_SENDERS.some((pattern) => address.includes(pattern));
}

function skipSenderResult(): ToddlerResponse {
  return {
    classification: "unknown",
    confidence: "high",
    data: {},
    error: null,
    modelVersion: SKIP_SENDER_MODEL_VERSION,
    rawResponse: null,
  };
}
```

- [ ] **Step 5: Carry `MatchedJobID` through the claim**

Change the `ClaimedEmail` interface to:

```ts
interface ClaimedEmail {
  AttachmentBlobs: string | null;
  Body: string | null;
  EmailID: number;
  FromAddress: string | null;
  MatchedJobID: number | null;
  Subject: string | null;
}
```

and the OUTPUT clause in `claimOne` to:

```ts
         OUTPUT inserted.EmailID, inserted.Subject, inserted.FromAddress,
                inserted.Body, inserted.AttachmentBlobs, inserted.MatchedJobID
```

- [ ] **Step 6: Add the known-job lookup**

Insert directly after `claimOne` (before `writeSuccess`):

```ts
// ── Known-job context ──────────────────────────────────────────────────────
// One SELECT per matched email. Contractor name comes from the approved
// quote, else the latest PO. The awaiting_director quote (if any) is what
// lets the model read a director's "Approved" reply as quote-approval.

interface KnownJobRow {
  AwaitingQuoteAmount: number | string | null;
  AwaitingQuoteID: number | null;
  AwaitingQuoteNumber: string | null;
  ContractorName: string | null;
  JobID: number;
  Status: string | null;
  Title: string | null;
}

async function loadKnownJob(token: string, jobId: number): Promise<KnownJob | null> {
  const connection = await createRequestConnection(token);
  try {
    const rows = (await executeQuery(
      connection,
      `SELECT j.JobID, j.Title, j.Status,
              COALESCE(aq.ContractorName, po.ContractorName) AS ContractorName,
              dq.QuoteID AS AwaitingQuoteID,
              dq.QuoteNumber AS AwaitingQuoteNumber,
              dq.Amount AS AwaitingQuoteAmount
         FROM Jobs j
         LEFT JOIN Quotes aq ON aq.QuoteID = j.ApprovedQuoteID
         OUTER APPLY (SELECT TOP (1) p.ContractorName
                        FROM PurchaseOrders p
                       WHERE p.JobID = j.JobID
                       ORDER BY p.CreatedAt DESC) po
         OUTER APPLY (SELECT TOP (1) q.QuoteID, q.QuoteNumber, q.Amount
                        FROM Quotes q
                       WHERE q.JobID = j.JobID AND q.Status = 'awaiting_director'
                       ORDER BY q.CreatedAt DESC) dq
        WHERE j.JobID = @JobID`,
      [{ name: "JobID", type: TYPES.Int, value: jobId }],
    )) as unknown as KnownJobRow[];
    const row = rows[0];
    if (!row) return null;
    return {
      jobId: row.JobID,
      title: row.Title,
      status: row.Status,
      contractorName: row.ContractorName,
      awaitingDirectorQuote:
        row.AwaitingQuoteID == null
          ? null
          : {
              quoteId: row.AwaitingQuoteID,
              quoteNumber: row.AwaitingQuoteNumber,
              amount: row.AwaitingQuoteAmount == null ? null : Number(row.AwaitingQuoteAmount),
            },
    };
  } finally {
    closeConnection(connection);
  }
}
```

- [ ] **Step 7: Let the caller decide the review flag**

Replace the `writeSuccess` signature and its first line:

```ts
async function writeSuccess(
  token: string,
  emailId: number,
  hints: ExtractedHints,
  result: ToddlerResponse,
): Promise<void> {
  const flag = result.confidence === "low" || result.classification === "unknown";
```

with:

```ts
// Low confidence or a genuine model "unknown" goes to the admin Flagged page.
function needsReview(result: ToddlerResponse): boolean {
  return result.confidence === "low" || result.classification === "unknown";
}

async function writeSuccess(
  token: string,
  emailId: number,
  hints: ExtractedHints,
  result: ToddlerResponse,
  flagged: boolean,
): Promise<void> {
```

and in its params array change `{ name: "Flagged", type: TYPES.Bit, value: flag ? 1 : 0 }` to `{ name: "Flagged", type: TYPES.Bit, value: flagged ? 1 : 0 }`.

- [ ] **Step 8: Rewrite `parseClaimedEmail`**

Replace the whole `parseClaimedEmail` function (Task 3) with:

```ts
async function parseClaimedEmail(
  token: string,
  email: ClaimedEmail,
  context: InvocationContext,
): Promise<EmailOutcome> {
  const hints = extractHints(email.Subject, email.Body);

  if (isSkippedSender(email.FromAddress)) {
    try {
      await writeSuccess(token, email.EmailID, hints, skipSenderResult(), false);
      return "succeeded";
    } catch (err: unknown) {
      context.error(`skip-sender write failed for email #${email.EmailID}:`, err instanceof Error ? err.message : String(err));
      return "errored";
    }
  }

  try {
    // Best-effort: a context lookup failure must not cost the email a retry.
    let knownJob: KnownJob | null = null;
    if (email.MatchedJobID != null) {
      knownJob = await loadKnownJob(token, email.MatchedJobID).catch((err: unknown) => {
        context.warn(`knownJob lookup failed for job #${email.MatchedJobID}:`, err instanceof Error ? err.message : String(err));
        return null;
      });
    }
    const result = await callToddler({
      // Both stored shapes (strings and Graph's { blobName, fileName }) — Task 1.
      attachments: hydrateAttachmentRefs(email.AttachmentBlobs),
      fromAddress: email.FromAddress,
      hints,
      html: email.Body ?? "",
      subject: email.Subject,
      ...(knownJob ? { knownJob } : {}),
    });
    if (result.error) {
      // Toddler returned 200 but the LLM itself errored — treat as transient
      // so the email stays in the queue and gets retried. Toddler always
      // sends data: {} on failure, so `error` is the only discriminator.
      await recordTransientError(token, email.EmailID, new Error(result.error));
      return "errored";
    }
    const review = needsReview(result);
    await writeSuccess(token, email.EmailID, hints, result, review);
    return review ? "flagged" : "succeeded";
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    await recordTransientError(token, email.EmailID, error).catch((e: unknown) =>
      context.error(`failed to record error for #${email.EmailID}:`, e instanceof Error ? e.message : String(e)),
    );
    context.error(`parse failed for email #${email.EmailID}:`, error.message);
    return "errored";
  }
}
```

- [ ] **Step 9: Run the parseEmails suite**

```
npx jest src/functions/parseEmails.test.ts
```

Expected: `Tests: 30 passed, 30 total` (24 from Task 6 + 4 knownJob + 2 skip-sender).

- [ ] **Checkpoint:** run `npx tsc --noEmit && npx jest` (expected: all pass — 58 suites, 1245 tests) and hand to Will to commit.

---

### Task 8: Migration 089 — `JobEvents.SourceEmailID`

**Files:**
- Create: `migrations/089_job_events_source_email.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/089_job_events_source_email.sql`:

```sql
-- Migration 089: JobEvents.SourceEmailID
--
-- Links a timeline event to the inbound email it was promoted from, so the
-- job timeline can offer "view email". Written by promoteEmailToJobUpdate
-- (EventType 'email_update') and by director decisions recorded from a reply
-- (recordEmailQuoteDecision → src/quote-decisions.ts). Mirrors
-- Jobs.SourceEmailID / Quotes.SourceEmailID.
--
-- ON DELETE SET NULL: the event is the record, the email is provenance.
-- No index — the column is written on promote and read only when a timeline
-- row is opened; nothing queries JobEvents by email.
--
-- Idempotent: both steps are guarded.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.JobEvents') AND name = 'SourceEmailID')
  ALTER TABLE dbo.JobEvents ADD SourceEmailID INT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_JobEvents_SourceEmail' AND parent_object_id = OBJECT_ID('dbo.JobEvents'))
  ALTER TABLE dbo.JobEvents
    ADD CONSTRAINT FK_JobEvents_SourceEmail
    FOREIGN KEY (SourceEmailID) REFERENCES dbo.Emails(EmailID) ON DELETE SET NULL;
GO
```

- [ ] **Step 2: Sanity-check the batch separators**

```
grep -c "^GO" migrations/089_job_events_source_email.sql
```

Expected: `2`. (`src/migrate.ts` splits on `^GO$`, sorts files by name and skips `_seed_` files, so 089 runs after 088 on the next host start.)

- [ ] **Step 3 (optional, local Docker DB running): apply by hand and verify**

```
docker exec -it azure-functions-sql-1 /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "DevPassword123!" -No -d command_centre_dev -i migrations/089_job_events_source_email.sql
docker exec -it azure-functions-sql-1 /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "DevPassword123!" -No -d command_centre_dev -Q "SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('dbo.JobEvents') AND name = 'SourceEmailID'"
```

Expected second output: one row, `SourceEmailID`. Running the file a second time must produce no error.

- [ ] **Checkpoint:** run `npx tsc --noEmit && npx jest` (expected: all pass — unchanged counts) and hand to Will to commit.

> Deployment order: 089 must be applied before the code from Tasks 9–11 serves traffic, because those INSERTs name `SourceEmailID`. `runMigrations()` on host start handles this when the Function App restarts on deploy.

---

### Task 9: Extract `approveDirectorQuote` / `rejectQuote` helpers from `quotes.ts`

Neither `directorApproveQuote` nor `rejectQuote` has a reusable write path today — their SQL lives inside the HTTP handlers — so this task is budgeted explicitly. The helpers live in `src/quote-decisions.ts` and are used by both the existing handlers and `recordEmailQuoteDecision` (Task 11). Rules carried into them:

- **Director approvals stay director-only.** `directorApproveQuote` keeps its literal-`DIRECTOR` re-check after `requireRole` (which would otherwise let admin through the role hierarchy). Admins are deliberately excluded; this is policy, not a bug.
- **Status guards return 409.** The approve helper requires `awaiting_director`; the reject helper requires one of the caller's `expectedStatuses` (`awaiting_director` for the email flow; `pending` or `awaiting_director` in-app). The status is re-checked in the `UPDATE … WHERE` so a concurrent change is also a 409, not a silent overwrite.
- **Actor from the verified token.** Both in-app handlers take the actor from `verifiedIdentityFromRequest`, never from the body (today `rejectQuote` stamps `RejectedBy` and `directorApproveQuote` stamps `ApprovedBy` from the body). The helpers take the actor as a parameter; callers decide where it comes from.

**Files:**
- Create: `src/quote-decisions.ts`
- Test: `src/quote-decisions.test.ts`
- Modify: `src/functions/quotes.ts` (imports lines 5–33; `QUOTE_COLUMNS` lines 35–41; `rejectQuote` lines 598–670; `directorApproveQuote` + its body interface lines 1081–1187)
- Test: `src/functions/quotes.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `src/quote-decisions.test.ts`:

```ts
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

    expect(outcome).toEqual({ jobId: 42, ok: true, quote: storedQuote });
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
```

- [ ] **Step 2: Run — red**

```
npx jest src/quote-decisions.test.ts
```

Expected: `Cannot find module './quote-decisions' from 'src/quote-decisions.test.ts'`.

- [ ] **Step 3: Write the module**

Create `src/quote-decisions.ts`:

```ts
// Director decision on a quote — the write paths shared by the in-app
// buttons (quotes.ts: directorApproveQuote / rejectQuote) and the email
// operator flow (emails.ts: recordEmailQuoteDecision). Plain writes on the
// caller's connection: callers own the transaction, the HTTP response, any
// Planner follow-up, and where the actor comes from (never a request body).

import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { executeQuery, type SqlRow } from "./db";

export const QUOTE_COLUMNS = `
  QuoteID, JobID, QuoteNumber, Seq, ContractorID, ContractorName,
  Amount, Currency, Notes, QuotePDFBlobName, SourceEmailID, ReceivedAt,
  Status, ApprovedAt, ApprovedBy, AIValidatedAt, AIValidatedBy,
  CreatedAt, CreatedBy,
  DirectorApprovedAt, DirectorApprovedBy, DirectorEmailSentAt, DirectorEmailSentTo, DirectorEmailSentBy
`;

export interface DirectorQuoteApprovalInput {
  quoteId: number;
  /** Stamped on Quotes.DirectorApprovedBy, Jobs.ApprovedBy and the event. */
  approvedBy: string | null;
  /** Set when the decision was recorded from an inbound email. */
  sourceEmailId?: number;
}

export interface QuoteRejectionInput {
  quoteId: number;
  rejectedBy: string | null;
  /** Statuses the caller allows a reject from; anything else is a 409. */
  expectedStatuses: readonly string[];
  note?: string | null;
  sourceEmailId?: number;
}

export type QuoteDecisionOutcome =
  | { ok: true; jobId: number; quote: SqlRow }
  | { ok: false; status: 404 | 409; error: string };

const CONCURRENT_CHANGE: QuoteDecisionOutcome = {
  ok: false,
  status: 409,
  error: "Quote status changed concurrently — reload and try again",
};

async function loadQuote(connection: Connection, quoteId: number): Promise<SqlRow> {
  const rows = await executeQuery(
    connection,
    `SELECT ${QUOTE_COLUMNS} FROM Quotes WHERE QuoteID = @Id`,
    [{ name: "Id", type: TYPES.Int, value: quoteId }],
  );
  return rows[0];
}

export async function approveDirectorQuote(
  connection: Connection,
  input: DirectorQuoteApprovalInput,
): Promise<QuoteDecisionOutcome> {
  const { quoteId, approvedBy, sourceEmailId } = input;
  const rows = await executeQuery(
    connection,
    `SELECT JobID, QuoteNumber, ContractorName, Status FROM Quotes WHERE QuoteID = @Id`,
    [{ name: "Id", type: TYPES.Int, value: quoteId }],
  );
  if (rows.length === 0) return { ok: false, status: 404, error: "Quote not found" };

  const jobId = rows[0].JobID as number;
  const quoteNumber = (rows[0].QuoteNumber as string | null) ?? `#${quoteId}`;
  const contractorName = rows[0].ContractorName as string | null;
  const status = (rows[0].Status as string) ?? "";

  if (status === "approved") {
    return { ok: false, status: 409, error: "Quote is already fully approved" };
  }
  if (status !== "awaiting_director") {
    return { ok: false, status: 409, error: "Quote must be in awaiting_director state" };
  }

  const updated = await executeQuery(
    connection,
    `UPDATE Quotes
       SET Status = 'approved',
           DirectorApprovedAt = SYSUTCDATETIME(),
           DirectorApprovedBy = @ApprovedBy
     OUTPUT inserted.QuoteID
     WHERE QuoteID = @Id AND Status = 'awaiting_director'`,
    [
      { name: "Id", type: TYPES.Int, value: quoteId },
      { name: "ApprovedBy", type: TYPES.NVarChar, value: approvedBy },
    ],
  );
  if (updated.length === 0) return CONCURRENT_CHANGE;

  await executeQuery(
    connection,
    `UPDATE Jobs
       SET ApprovedQuoteID = @QuoteID,
           ApprovedBy = @ApprovedBy,
           ApprovedAt = SYSUTCDATETIME(),
           LastModifiedDate = SYSUTCDATETIME()
     WHERE JobID = @JobID`,
    [
      { name: "QuoteID", type: TYPES.Int, value: quoteId },
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "ApprovedBy", type: TYPES.NVarChar, value: approvedBy },
    ],
  );
  const via = sourceEmailId == null ? "" : " via email";
  await executeQuery(
    connection,
    `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, QuoteID, SourceEmailID)
     VALUES (@JobID, @CreatedBy, @Text, 'quote_director_approved', @QuoteID, @SourceEmailID);`,
    [
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "CreatedBy", type: TYPES.NVarChar, value: approvedBy },
      {
        name: "Text",
        type: TYPES.NVarChar,
        value: `Director-approved ${quoteNumber}${contractorName ? ` from ${contractorName}` : ""}${via}`,
      },
      { name: "QuoteID", type: TYPES.Int, value: quoteId },
      { name: "SourceEmailID", type: TYPES.Int, value: sourceEmailId ?? null },
    ],
  );

  return { ok: true, jobId, quote: await loadQuote(connection, quoteId) };
}

export async function rejectQuote(
  connection: Connection,
  input: QuoteRejectionInput,
): Promise<QuoteDecisionOutcome> {
  const { quoteId, rejectedBy, expectedStatuses, note, sourceEmailId } = input;
  const rows = await executeQuery(
    connection,
    "SELECT JobID, QuoteNumber, Status FROM Quotes WHERE QuoteID = @Id",
    [{ name: "Id", type: TYPES.Int, value: quoteId }],
  );
  if (rows.length === 0) return { ok: false, status: 404, error: "Quote not found" };

  const jobId = rows[0].JobID as number;
  const quoteNumber = (rows[0].QuoteNumber as string | null) ?? `#${quoteId}`;
  const status = (rows[0].Status as string | null) ?? "";
  if (!expectedStatuses.includes(status)) {
    return {
      ok: false,
      status: 409,
      error: `Quote is ${status || "in an unknown state"} — it can only be rejected while ${expectedStatuses.join(" or ")}`,
    };
  }

  const updated = await executeQuery(
    connection,
    `UPDATE Quotes SET Status = 'rejected'
     OUTPUT inserted.QuoteID
     WHERE QuoteID = @Id AND Status = @CurrentStatus`,
    [
      { name: "Id", type: TYPES.Int, value: quoteId },
      { name: "CurrentStatus", type: TYPES.NVarChar, value: status },
    ],
  );
  if (updated.length === 0) return CONCURRENT_CHANGE;

  const via = sourceEmailId == null ? "" : " via email";
  const reason = note && note.trim().length > 0 ? ` — ${note.trim()}` : "";
  await executeQuery(
    connection,
    `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, QuoteID, SourceEmailID)
     VALUES (@JobID, @CreatedBy, @Text, 'quote_rejected', @QuoteID, @SourceEmailID);`,
    [
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "CreatedBy", type: TYPES.NVarChar, value: rejectedBy },
      { name: "Text", type: TYPES.NVarChar, value: `Rejected quote ${quoteNumber}${via}${reason}` },
      { name: "QuoteID", type: TYPES.Int, value: quoteId },
      { name: "SourceEmailID", type: TYPES.Int, value: sourceEmailId ?? null },
    ],
  );
  await executeQuery(
    connection,
    "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );

  return { ok: true, jobId, quote: await loadQuote(connection, quoteId) };
}
```

- [ ] **Step 4: Run — green**

```
npx jest src/quote-decisions.test.ts
```

Expected: `Tests: 10 passed, 10 total`.

- [ ] **Step 5: Point `quotes.ts` at the helpers**

In `src/functions/quotes.ts`:

1. On line 16 add `verifiedIdentityFromRequest` to the `../auth` import:

```ts
import { AppRole, extractToken, requireRole, unauthorizedResponse, errorResponse, rolesForRequest, verifiedIdentityFromRequest } from "../auth";
```

2. After line 33 (`import { JobEvent } from "../jobStatusMachine";`) add (the alias avoids clashing with the `rejectQuote` handler below):

```ts
import { QUOTE_COLUMNS, approveDirectorQuote, rejectQuote as rejectQuoteWrite } from "../quote-decisions";
```

3. Delete the local `const QUOTE_COLUMNS = \`…\`;` block (lines 35–41).

4. Replace the `rejectQuote` function (keep the `// ── POST /api/rejectQuote` comment above it) with:

```ts
// The quote card offers Reject only on 'pending'; an 'awaiting_director'
// quote may also be turned down. Anything else is a 409 from the helper.
const IN_APP_REJECTABLE_STATUSES = ["pending", "awaiting_director"] as const;

interface RejectQuoteBody {
  QuoteID?: unknown;
}

export async function rejectQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ACCOUNTS, AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

  // Actor from the verified token. A RejectedBy in the body is ignored.
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = ((await request.json().catch(() => null)) ?? {}) as RejectQuoteBody;
    const { QuoteID } = body;
    if (typeof QuoteID !== "number") {
      return { status: 400, jsonBody: { error: "QuoteID (number) required" } };
    }

    connection = await createRequestConnection(token);

    // Shared with recordEmailQuoteDecision — src/quote-decisions.ts.
    const outcome = await rejectQuoteWrite(connection, {
      expectedStatuses: IN_APP_REJECTABLE_STATUSES,
      quoteId: QuoteID,
      rejectedBy: identity.name,
    });
    if (!outcome.ok) return { status: outcome.status, jsonBody: { error: outcome.error } };

    return { status: 200, jsonBody: { quote: outcome.quote } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("rejectQuote failed:", message);
    return errorResponse("Reject quote failed", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}
```

5. Replace the `DirectorApproveQuoteBody` interface and the `directorApproveQuote` function (keep the section comment above them, but change its `// Body: { QuoteID, ApprovedBy }` line to `// Body: { QuoteID } — the approver is the verified caller, never the body.`) with:

```ts
interface DirectorApproveQuoteBody {
  QuoteID?: unknown;
}

export async function directorApproveQuote(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.DIRECTOR]);
  if (denied) return denied;

  // Director-only by policy. requireRole lets admin through via the role
  // hierarchy, so re-check the literal role. Admins are deliberately
  // excluded — keep this check.
  const userRoles = await rolesForRequest(request);
  if (!userRoles.includes(AppRole.DIRECTOR)) {
    return { status: 403, jsonBody: { error: "Director role required" } };
  }

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  let connection;
  try {
    const body = ((await request.json().catch(() => null)) ?? {}) as DirectorApproveQuoteBody;
    const { QuoteID } = body;
    if (typeof QuoteID !== "number") {
      return { status: 400, jsonBody: { error: "QuoteID (number) required" } };
    }

    connection = await createRequestConnection(token);

    // Shared with recordEmailQuoteDecision — src/quote-decisions.ts.
    const outcome = await approveDirectorQuote(connection, {
      approvedBy: identity.name,
      quoteId: QuoteID,
    });
    if (!outcome.ok) return { status: outcome.status, jsonBody: { error: outcome.error } };

    resolveActivePlannerTasks("job", outcome.jobId, ["director_approval"]).catch(
      (err: unknown) =>
        context.warn("plannerResolve (directorApproveQuote):", err instanceof Error ? err.message : String(err)),
    );
    return { status: 200, jsonBody: { quote: outcome.quote } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("directorApproveQuote failed:", message);
    return errorResponse("Director approve quote failed", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}
```

(Registrations are unchanged: `handler: rejectQuote` / `handler: directorApproveQuote` still resolve to these functions.)

- [ ] **Step 6: Write the handler tests**

Create `src/functions/quotes.test.ts`:

```ts
/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  buildUpdateSet: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    rolesForRequest: jest.fn().mockResolvedValue(["director"]),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({
      email: "carlo@randazzo.properties",
      name: "Carlo Randazzo",
      oid: "director-oid",
    }),
  };
});

jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../quote-decisions", () => ({
  QUOTE_COLUMNS: "QuoteID",
  approveDirectorQuote: jest.fn(),
  rejectQuote: jest.fn(),
}));

const auth = require("../auth") as { rolesForRequest: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const decisions = require("../quote-decisions") as { approveDirectorQuote: jest.Mock; rejectQuote: jest.Mock };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: unknown }>;
const { directorApproveQuote, rejectQuote } = require("./quotes") as {
  directorApproveQuote: Handler;
  rejectQuote: Handler;
};

function makeRequest(body: unknown): HttpRequest {
  return {
    headers: { get: () => null },
    json: jest.fn().mockResolvedValue(body),
    query: new URLSearchParams(),
  } as unknown as HttpRequest;
}

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const storedQuote = { QuoteID: 7, Status: "rejected" };

beforeEach(() => {
  jest.clearAllMocks();
  decisions.rejectQuote.mockResolvedValue({ jobId: 9, ok: true, quote: storedQuote });
  decisions.approveDirectorQuote.mockResolvedValue({ jobId: 9, ok: true, quote: { ...storedQuote, Status: "approved" } });
});

describe("rejectQuote (in-app)", () => {
  it("takes the actor from the verified token and ignores RejectedBy in the body", async () => {
    const res = await rejectQuote(makeRequest({ QuoteID: 7, RejectedBy: "Mallory" }), ctx);

    expect(res.status).toBe(200);
    expect(decisions.rejectQuote).toHaveBeenCalledWith({}, {
      expectedStatuses: ["pending", "awaiting_director"],
      quoteId: 7,
      rejectedBy: "Carlo Randazzo",
    });
  });

  it("surfaces the helper's 409 when the quote is not rejectable", async () => {
    decisions.rejectQuote.mockResolvedValue({
      error: "Quote is approved — it can only be rejected while pending or awaiting_director",
      ok: false,
      status: 409,
    });

    const res = await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(409);
  });

  it("401s and writes nothing when the token identity cannot be verified", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(401);
    expect(decisions.rejectQuote).not.toHaveBeenCalled();
  });
});

describe("directorApproveQuote", () => {
  it("403s an admin without the literal director role — director-only by policy", async () => {
    auth.rolesForRequest.mockResolvedValueOnce(["admin"]);

    const res = await directorApproveQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(403);
    expect(decisions.approveDirectorQuote).not.toHaveBeenCalled();
  });

  it("stamps the verified director, not ApprovedBy from the body", async () => {
    const res = await directorApproveQuote(makeRequest({ ApprovedBy: "Mallory", QuoteID: 7 }), ctx);

    expect(res.status).toBe(200);
    expect(decisions.approveDirectorQuote).toHaveBeenCalledWith({}, { approvedBy: "Carlo Randazzo", quoteId: 7 });
  });
});
```

- [ ] **Step 7: Run the handler tests**

```
npx jest src/functions/quotes.test.ts
```

Expected: `Tests: 5 passed, 5 total`. (Run before Step 5 to see red: `TypeError: rejectQuote is not a function` — the handlers were not exported.)

- [ ] **Step 8: Confirm the column list moved and nothing else in quotes.ts broke**

```
grep -n "const QUOTE_COLUMNS" src/functions/quotes.ts src/quote-decisions.ts
grep -n "RejectedBy\|ApprovedBy ??" src/functions/quotes.ts
npx tsc --noEmit
npm run lint
```

Expected: the first `grep` shows only `src/quote-decisions.ts`; the second shows no body-sourced actor in `rejectQuote` / `directorApproveQuote` (other handlers' `ApprovedBy` columns may still appear); `tsc` and `lint` report nothing.

- [ ] **Checkpoint:** run `npx tsc --noEmit && npx jest` (expected: all pass — 60 suites, 1262 tests: +10 helpers, +5 handlers, +2 guard tests for `quote-decisions.ts`) and hand to Will to commit.

> Frontend note: `directorApproveQuote` refusals move from 400 to 409, and both handlers ignore `ApprovedBy` / `RejectedBy` in the body. The current frontend sends those fields; they are now harmless.

---

### Task 10: `promoteEmailToJobUpdate`

**Files:**
- Modify: `src/functions/emails.ts` (import block; new section after `promoteEmailToInvoice`; registrations at the end)
- Test: `src/functions/emails.test.ts`

- [ ] **Step 1: Write the failing handler tests**

Create `src/functions/emails.test.ts`:

```ts
/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({
      email: "ops@co.com",
      name: "Ops User",
      oid: "caller-oid-123",
    }),
  };
});

jest.mock("../blob-storage", () => ({
  generateReadSasUrl: jest.fn().mockReturnValue("https://acct.blob.core.windows.net/x?sig=1"),
}));
jest.mock("../graph", () => ({ graphFetchEmails: jest.fn() }));
jest.mock("../rateLimit", () => ({
  checkRateLimit: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }),
}));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));
jest.mock("../jobStatusHelpers", () => ({ advanceJobStatus: jest.fn() }));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../quote-decisions", () => ({
  approveDirectorQuote: jest.fn(),
  rejectQuote: jest.fn(),
}));

const db = require("../db") as {
  beginTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const statusHelpers = require("../jobStatusHelpers") as { advanceJobStatus: jest.Mock };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: unknown }>;
const { promoteEmailToJobUpdate } = require("./emails") as { promoteEmailToJobUpdate: Handler };

type SqlRoute = [RegExp, Record<string, unknown>[]];

// Answer each SQL statement by shape; anything unrouted returns no rows.
function routeSql(routes: SqlRoute[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    const hit = routes.find(([re]) => re.test(sql));
    return hit ? hit[1] : [];
  });
}

function sqlCalls(): { params: Record<string, unknown>; sql: string }[] {
  return db.executeQuery.mock.calls.map((c: unknown[]) => ({
    params: Object.fromEntries(
      ((c[2] as { name: string; value: unknown }[] | undefined) ?? []).map((p) => [p.name, p.value]),
    ),
    sql: String(c[1]),
  }));
}

function makeRequest(body: unknown): HttpRequest {
  return {
    headers: { get: () => null },
    json: jest.fn().mockResolvedValue(body),
    query: new URLSearchParams(),
  } as unknown as HttpRequest;
}

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("promoteEmailToJobUpdate", () => {
  const emailExists: SqlRoute = [/SELECT EmailID FROM Emails/, [{ EmailID: 42 }]];
  const insertedEvent: SqlRoute = [/INSERT INTO JobEvents/, [{ JobEventID: 501 }]];
  const jobIn = (status: string, role = "facilities"): SqlRoute => [
    /SELECT Status, AwaitingRole FROM Jobs/,
    [{ AwaitingRole: role, Status: status }],
  ];

  it("writes the note with SourceEmailID, flips the email and commits", async () => {
    routeSql([emailExists, jobIn("Quote"), insertedEvent]);

    const res = await promoteEmailToJobUpdate(
      makeRequest({ EmailID: 42, JobID: 7, Text: "  Scheduled for Tuesday  " }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ eventId: 501, jobId: 7, newStatus: null });
    const insert = sqlCalls().find((c) => /INSERT INTO JobEvents/.test(c.sql));
    expect(insert?.sql).toContain("'email_update'");
    expect(insert?.params).toMatchObject({ CreatedBy: "Ops User", EmailID: 42, JobID: 7, Text: "Scheduled for Tuesday" });
    const flip = sqlCalls().find((c) => /UPDATE Emails/.test(c.sql));
    expect(flip?.sql).toMatch(/Status = 'promoted'/);
    expect(flip?.sql).toMatch(/MatchedJobID = COALESCE\(MatchedJobID, @JobID\)/);
    expect(flip?.params).toMatchObject({ Id: 42, JobID: 7 });
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
    expect(statusHelpers.advanceJobStatus).not.toHaveBeenCalled();
  });

  it("fires WORK_COMPLETED through advanceJobStatus when MarkWorkCompleted is true from Work", async () => {
    routeSql([emailExists, jobIn("Work"), insertedEvent]);
    statusHelpers.advanceJobStatus.mockResolvedValue({
      advanced: true,
      from: { awaitingRole: "facilities", status: "Work" },
      to: { awaitingRole: "accounts", status: "Awaiting Approval" },
    });

    const res = await promoteEmailToJobUpdate(
      makeRequest({ EmailID: 42, JobID: 7, MarkWorkCompleted: true, Text: "All done" }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ eventId: 501, jobId: 7, newStatus: "Awaiting Approval" });
    expect(statusHelpers.advanceJobStatus).toHaveBeenCalledWith({}, 7, "WORK_COMPLETED", { actor: "Ops User" });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns 422 and writes nothing when MarkWorkCompleted is illegal from the job's state", async () => {
    routeSql([emailExists, jobIn("New"), insertedEvent]);

    const res = await promoteEmailToJobUpdate(
      makeRequest({ EmailID: 42, JobID: 7, MarkWorkCompleted: true, Text: "All done" }),
      ctx,
    );

    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: string }).error).toMatch(/Cannot mark work completed/);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(sqlCalls().some((c) => /INSERT|UPDATE/i.test(c.sql))).toBe(false);
    expect(statusHelpers.advanceJobStatus).not.toHaveBeenCalled();
  });

  it("rolls back with 409 when the status write loses a race", async () => {
    routeSql([emailExists, jobIn("Work"), insertedEvent]);
    statusHelpers.advanceJobStatus.mockResolvedValue({
      advanced: false,
      from: { awaitingRole: "facilities", status: "Work" },
      to: null,
    });

    const res = await promoteEmailToJobUpdate(
      makeRequest({ EmailID: 42, JobID: 7, MarkWorkCompleted: true, Text: "All done" }),
      ctx,
    );

    expect(res.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 when Text is empty", async () => {
    const res = await promoteEmailToJobUpdate(makeRequest({ EmailID: 42, JobID: 7, Text: "   " }), ctx);

    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when the job does not exist", async () => {
    routeSql([emailExists]);

    const res = await promoteEmailToJobUpdate(makeRequest({ EmailID: 42, JobID: 7, Text: "hi" }), ctx);

    expect(res.status).toBe(404);
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — red**

```
npx jest src/functions/emails.test.ts
```

Expected: every test fails with `TypeError: promoteEmailToJobUpdate is not a function`.

- [ ] **Step 3: Extend the imports in `emails.ts`**

Replace the import block of `src/functions/emails.ts` (from `import { app, HttpRequest, …` through `import { checkRateLimit } from "../rateLimit";`, as left by Tasks 2 and 6) with:

```ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createRequestConnection,
  executeQuery,
  rollbackTransaction,
} from "../db";
import { AppRole, extractToken, requireRole, verifiedIdentityFromRequest, unauthorizedResponse, errorResponse } from "../auth";
import { generateReadSasUrl } from "../blob-storage";
import { GraphEmail } from "../graph";
import { formatDocNumber, nameToAcronym } from "../doc-number";
import { jobIdFromText } from "../email/job-ref";
import { emailSyncQueueOutput, enqueueEmailSync } from "../email/sync-queue";
import { advanceJobStatus } from "../jobStatusHelpers";
import { AwaitingRole, JobEvent, JobStatus, nextState, type JobState } from "../jobStatusMachine";
import { approveDirectorQuote, rejectQuote } from "../quote-decisions";
import { resolveActivePlannerTasks } from "../planner";
import { checkRateLimit } from "../rateLimit";
```

(`approveDirectorQuote`, `rejectQuote` and `resolveActivePlannerTasks` are consumed in Task 11; `tsconfig` has no `noUnusedLocals`, so the imports compile now.)

- [ ] **Step 4: Add the handler**

Insert after the end of `promoteEmailToInvoice` (before the `// ── GET /api/getEmailThread` section):

```ts
// ── Promote-roles ───────────────────────────────────────────────────────────
// Mirrors promoteEmailToJob / promoteEmailToQuote / promoteEmailToInvoice
// above and the matching capability in command-centre src/constants/roles.ts.
// Keep all of them in step — the frontend gate is UX, this list is the control.
const PROMOTE_EMAIL_ROLES = [AppRole.ACCOUNTS_APPROVAL, AppRole.FACILITIES_APPROVAL] as const;

// ── POST /api/promoteEmailToJobUpdate ───────────────────────────────────────
// Body: { EmailID: number, JobID: number, Text: string, MarkWorkCompleted?: boolean }
// Records a reply on an existing job as a timeline note (EventType
// 'email_update', SourceEmailID set) and optionally fires WORK_COMPLETED:
// pre-check nextState(current, WORK_COMPLETED) — null → 422, nothing
// written — then advanceJobStatus; !advanced (the job moved underneath us)
// → 409 and rollback. Note + status change + email flip are one transaction.

interface PromoteEmailToJobUpdateBody {
  EmailID?: unknown;
  JobID?: unknown;
  MarkWorkCompleted?: unknown;
  Text?: unknown;
}

export async function promoteEmailToJobUpdate(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, PROMOTE_EMAIL_ROLES);
  if (denied) return denied;

  // CreatedBy comes from the verified token — never from the body.
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  const rl = checkRateLimit(`promoteEmailToJobUpdate:${identity.oid}`, { limit: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  const body = ((await request.json().catch(() => null)) ?? {}) as PromoteEmailToJobUpdateBody;
  const { EmailID, JobID, Text, MarkWorkCompleted } = body;
  if (typeof EmailID !== "number" || typeof JobID !== "number") {
    return { status: 400, jsonBody: { error: "EmailID and JobID (numbers) are required" } };
  }
  if (typeof Text !== "string" || Text.trim().length === 0) {
    return { status: 400, jsonBody: { error: "Text (non-empty string) is required" } };
  }
  if (MarkWorkCompleted !== undefined && typeof MarkWorkCompleted !== "boolean") {
    return { status: 400, jsonBody: { error: "MarkWorkCompleted must be a boolean when provided" } };
  }
  const markCompleted = MarkWorkCompleted === true;

  let connection;
  let inTransaction = false;
  try {
    connection = await createRequestConnection(token);

    const emailRows = await executeQuery(
      connection,
      "SELECT EmailID FROM Emails WHERE EmailID = @Id",
      [{ name: "Id", type: TYPES.Int, value: EmailID }],
    );
    if (emailRows.length === 0) return { status: 404, jsonBody: { error: "Email not found" } };

    const jobRows = await executeQuery(
      connection,
      "SELECT Status, AwaitingRole FROM Jobs WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: JobID }],
    );
    if (jobRows.length === 0) return { status: 404, jsonBody: { error: "Job not found" } };

    if (markCompleted) {
      const current: JobState = {
        status: jobRows[0].Status as JobStatus,
        awaitingRole: (jobRows[0].AwaitingRole as AwaitingRole) ?? AwaitingRole.FACILITIES,
      };
      // Same machine advanceJobStatus consults — checked up front so an
      // illegal transition writes nothing, not even the note.
      if (nextState(current, JobEvent.WORK_COMPLETED) == null) {
        return {
          status: 422,
          jsonBody: { error: `Cannot mark work completed from status "${current.status}"`, from: current.status },
        };
      }
    }

    await beginTransaction(connection);
    inTransaction = true;

    const inserted = await executeQuery(
      connection,
      `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, SourceEmailID)
       OUTPUT INSERTED.JobEventID
       VALUES (@JobID, @CreatedBy, @Text, 'email_update', @EmailID);`,
      [
        { name: "JobID", type: TYPES.Int, value: JobID },
        { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
        { name: "Text", type: TYPES.NVarChar, value: Text.trim() },
        { name: "EmailID", type: TYPES.Int, value: EmailID },
      ],
    );
    const eventId = inserted[0].JobEventID as number;

    let newStatus: string | null = null;
    if (markCompleted) {
      const advanced = await advanceJobStatus(connection, JobID, JobEvent.WORK_COMPLETED, { actor: identity.name });
      if (!advanced.advanced || !advanced.to) {
        // The job moved between our check and the write — refuse rather than
        // leave a note that claims completion.
        await rollbackTransaction(connection);
        inTransaction = false;
        return { status: 409, jsonBody: { error: "Job status changed concurrently — reload and try again" } };
      }
      newStatus = advanced.to.status;
    } else {
      await executeQuery(
        connection,
        "UPDATE Jobs SET LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID",
        [{ name: "JobID", type: TYPES.Int, value: JobID }],
      );
    }

    await executeQuery(
      connection,
      `UPDATE Emails
         SET Status = 'promoted',
             ProcessedAt = SYSUTCDATETIME(),
             MatchedJobID = COALESCE(MatchedJobID, @JobID)
       WHERE EmailID = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: EmailID },
        { name: "JobID", type: TYPES.Int, value: JobID },
      ],
    );

    await commitTransaction(connection);
    inTransaction = false;

    return { status: 200, jsonBody: { eventId, jobId: JobID, newStatus } };
  } catch (error: unknown) {
    if (connection && inTransaction) await rollbackTransaction(connection).catch(() => undefined);
    context.error("promoteEmailToJobUpdate failed:", error instanceof Error ? error.message : String(error));
    return errorResponse("Promote email to job update failed", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}
```

- [ ] **Step 5: Register it**

After the `promoteEmailToInvoice` `app.http(...)` registration add:

```ts
app.http("promoteEmailToJobUpdate", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: promoteEmailToJobUpdate,
});
```

- [ ] **Step 6: Run — green**

```
npx jest src/functions/emails.test.ts
```

Expected: `Tests: 6 passed, 6 total`.

- [ ] **Checkpoint:** run `npx tsc --noEmit && npx jest` (expected: all pass — 61 suites, 1268 tests) and hand to Will to commit.

---

### Task 11: `recordEmailQuoteDecision`

**Files:**
- Modify: `src/functions/emails.ts` (new section after `promoteEmailToJobUpdate`; registrations; header)
- Test: `src/functions/emails.test.ts` (exists since Task 10)

- [ ] **Step 1: Add the failing tests to `emails.test.ts`**

In `src/functions/emails.test.ts` change the handler require to:

```ts
const { promoteEmailToJobUpdate, recordEmailQuoteDecision } = require("./emails") as {
  promoteEmailToJobUpdate: Handler;
  recordEmailQuoteDecision: Handler;
};
```

after the `statusHelpers` const add:

```ts
const quoteDecisions = require("../quote-decisions") as {
  approveDirectorQuote: jest.Mock;
  rejectQuote: jest.Mock;
};
```

and append:

```ts
describe("recordEmailQuoteDecision", () => {
  const email: SqlRoute = [
    /SELECT EmailID, FromAddress FROM Emails/,
    [{ EmailID: 42, FromAddress: " Carlo@Randazzo.properties " }],
  ];
  const quote = (
    status: string,
    sentTo: string | null = JSON.stringify(["carlo@randazzo.properties", "paolo@randazzo.properties"]),
  ): SqlRoute => [/SELECT Status, DirectorEmailSentTo FROM Quotes/, [{ DirectorEmailSentTo: sentTo, Status: status }]];
  const director: SqlRoute = [/FROM AppUsers/, [{ DisplayName: "Carlo Randazzo" }]];
  const storedQuote = { QuoteID: 7, Status: "approved" };

  beforeEach(() => {
    quoteDecisions.approveDirectorQuote.mockResolvedValue({ jobId: 9, ok: true, quote: storedQuote });
    quoteDecisions.rejectQuote.mockResolvedValue({ jobId: 9, ok: true, quote: { ...storedQuote, Status: "rejected" } });
  });

  it("409 when the quote is not awaiting the director", async () => {
    routeSql([email, quote("pending"), director]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { error: string }).error).toBe("Quote must be in awaiting_director state");
    expect(quoteDecisions.approveDirectorQuote).not.toHaveBeenCalled();
  });

  it("422 when the sender was not a recipient of the director email", async () => {
    routeSql([email, quote("awaiting_director", JSON.stringify(["paolo@randazzo.properties"])), director]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: string }).error).toBe("Sender was not a recipient of the director approval email");
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(quoteDecisions.approveDirectorQuote).not.toHaveBeenCalled();
  });

  it("422 when the sender is not an active AppUsers director", async () => {
    routeSql([email, quote("awaiting_director")]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: string }).error).toBe("Sender is not an active director");
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(quoteDecisions.approveDirectorQuote).not.toHaveBeenCalled();
  });

  it("422 when the sender is an admin, not a director — admins are excluded by policy", async () => {
    // The lookup is the literal Role = 'director'; an admin row never matches.
    routeSql([email, quote("awaiting_director")]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(422);
    const lookup = sqlCalls().find((c) => /FROM AppUsers/.test(c.sql));
    expect(lookup?.sql).toMatch(/Role = 'director'/);
    expect(lookup?.sql).not.toMatch(/admin/i);
    expect(quoteDecisions.approveDirectorQuote).not.toHaveBeenCalled();
  });

  it("approves through the shared director helper with the sender's display name and flips the email", async () => {
    routeSql([email, quote("awaiting_director"), director]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ quote: storedQuote });
    expect(quoteDecisions.approveDirectorQuote).toHaveBeenCalledWith({}, {
      approvedBy: "Carlo Randazzo",
      quoteId: 7,
      sourceEmailId: 42,
    });
    const lookup = sqlCalls().find((c) => /FROM AppUsers/.test(c.sql));
    expect(lookup?.params).toMatchObject({ Email: "carlo@randazzo.properties" });
    expect(lookup?.sql).toMatch(/Role = 'director'/);
    expect(lookup?.sql).toMatch(/IsActive = 1/);
    const flip = sqlCalls().find((c) => /UPDATE Emails/.test(c.sql));
    expect(flip?.sql).toMatch(/Status = 'promoted'/);
    expect(flip?.params).toMatchObject({ Id: 42 });
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(quoteDecisions.rejectQuote).not.toHaveBeenCalled();
  });

  it("rejects through the shared helper with the note; the actor is server-derived, never the body", async () => {
    routeSql([email, quote("awaiting_director"), director]);

    const res = await recordEmailQuoteDecision(
      makeRequest({ Decision: "rejected", EmailID: 42, Note: "Too expensive", QuoteID: 7, RejectedBy: "Mallory" }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(quoteDecisions.rejectQuote).toHaveBeenCalledWith({}, {
      expectedStatuses: ["awaiting_director"],
      note: "Too expensive",
      quoteId: 7,
      rejectedBy: "Carlo Randazzo",
      sourceEmailId: 42,
    });
    expect(quoteDecisions.approveDirectorQuote).not.toHaveBeenCalled();
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("rolls back and surfaces the helper's refusal", async () => {
    routeSql([email, quote("awaiting_director"), director]);
    quoteDecisions.approveDirectorQuote.mockResolvedValue({
      error: "Quote is already fully approved",
      ok: false,
      status: 409,
    });

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(sqlCalls().some((c) => /UPDATE Emails/.test(c.sql))).toBe(false);
  });

  it("400 on an unknown Decision", async () => {
    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "maybe", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — red**

```
npx jest src/functions/emails.test.ts -t "recordEmailQuoteDecision"
```

Expected: every test in the block fails with `TypeError: recordEmailQuoteDecision is not a function`.

- [ ] **Step 3: Add the handler**

Insert directly after `promoteEmailToJobUpdate` in `src/functions/emails.ts`:

```ts
// ── POST /api/recordEmailQuoteDecision ──────────────────────────────────────
// Body: { EmailID: number, QuoteID: number, Decision: "approved" | "rejected", Note?: string }
// Records a director's emailed approve / reject on a quote awaiting director
// sign-off. The caller is the operator (roles mirror promoteEmailToQuote);
// the director's authority is established by the SENDER checks: FromAddress
// must be a recipient of that quote's director packet AND an active AppUsers
// row with the literal Role = 'director'. Admins are deliberately excluded,
// the same policy as directorApproveQuote. The actor stamped on the quote is
// that director's DisplayName — never anything from the body. Writes go
// through the shared helpers (src/quote-decisions.ts), then the email flips
// to promoted — one transaction.

interface RecordEmailQuoteDecisionBody {
  Decision?: unknown;
  EmailID?: unknown;
  Note?: unknown;
  QuoteID?: unknown;
}

// DirectorEmailSentTo is written as a JSON array (quotes.ts); tolerate a
// comma list for rows edited by hand. Normalised for comparison.
function parseRecipientList(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw.split(",");
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((r): r is string => typeof r === "string")
    .map((r) => r.trim().toLowerCase())
    .filter((r) => r.length > 0);
}

export async function recordEmailQuoteDecision(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, PROMOTE_EMAIL_ROLES);
  if (denied) return denied;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  const rl = checkRateLimit(`recordEmailQuoteDecision:${identity.oid}`, { limit: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  const body = ((await request.json().catch(() => null)) ?? {}) as RecordEmailQuoteDecisionBody;
  const { EmailID, QuoteID, Decision, Note } = body;
  if (typeof EmailID !== "number" || typeof QuoteID !== "number") {
    return { status: 400, jsonBody: { error: "EmailID and QuoteID (numbers) are required" } };
  }
  if (Decision !== "approved" && Decision !== "rejected") {
    return { status: 400, jsonBody: { error: 'Decision must be "approved" or "rejected"' } };
  }
  if (Note !== undefined && typeof Note !== "string") {
    return { status: 400, jsonBody: { error: "Note must be a string when provided" } };
  }

  let connection;
  let inTransaction = false;
  try {
    connection = await createRequestConnection(token);

    const emailRows = await executeQuery(
      connection,
      "SELECT EmailID, FromAddress FROM Emails WHERE EmailID = @Id",
      [{ name: "Id", type: TYPES.Int, value: EmailID }],
    );
    if (emailRows.length === 0) return { status: 404, jsonBody: { error: "Email not found" } };
    const sender = ((emailRows[0].FromAddress as string | null) ?? "").trim().toLowerCase();
    if (!sender) return { status: 422, jsonBody: { error: "Email has no sender address" } };

    const quoteRows = await executeQuery(
      connection,
      "SELECT Status, DirectorEmailSentTo FROM Quotes WHERE QuoteID = @Id",
      [{ name: "Id", type: TYPES.Int, value: QuoteID }],
    );
    if (quoteRows.length === 0) return { status: 404, jsonBody: { error: "Quote not found" } };
    if ((quoteRows[0].Status as string | null) !== "awaiting_director") {
      return { status: 409, jsonBody: { error: "Quote must be in awaiting_director state" } };
    }

    // Check 1: the reply came from someone we actually sent the packet to.
    const recipients = parseRecipientList(quoteRows[0].DirectorEmailSentTo as string | null);
    if (!recipients.includes(sender)) {
      return { status: 422, jsonBody: { error: "Sender was not a recipient of the director approval email" } };
    }

    // Check 2: that address is a registered, active director. A director
    // deactivated in Admin → Users cannot approve from an old packet.
    // AppUsers.Email is stored lowercased (users.ts), so no LOWER() here.
    const directorRows = await executeQuery(
      connection,
      `SELECT DisplayName FROM AppUsers
        WHERE Email = @Email AND Role = 'director' AND IsActive = 1`,
      [{ name: "Email", type: TYPES.NVarChar, value: sender }],
    );
    if (directorRows.length === 0) {
      return { status: 422, jsonBody: { error: "Sender is not an active director" } };
    }
    const directorName = directorRows[0].DisplayName as string;

    await beginTransaction(connection);
    inTransaction = true;

    const outcome =
      Decision === "approved"
        ? await approveDirectorQuote(connection, {
            approvedBy: directorName,
            quoteId: QuoteID,
            sourceEmailId: EmailID,
          })
        : await rejectQuote(connection, {
            expectedStatuses: ["awaiting_director"],
            note: Note ?? null,
            quoteId: QuoteID,
            rejectedBy: directorName,
            sourceEmailId: EmailID,
          });
    if (!outcome.ok) {
      await rollbackTransaction(connection);
      inTransaction = false;
      return { status: outcome.status, jsonBody: { error: outcome.error } };
    }

    await executeQuery(
      connection,
      `UPDATE Emails SET Status = 'promoted', ProcessedAt = SYSUTCDATETIME()
       WHERE EmailID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: EmailID }],
    );

    await commitTransaction(connection);
    inTransaction = false;

    if (Decision === "approved") {
      resolveActivePlannerTasks("job", outcome.jobId, ["director_approval"]).catch((err: unknown) =>
        context.warn("plannerResolve (recordEmailQuoteDecision):", err instanceof Error ? err.message : String(err)),
      );
    }

    return { status: 200, jsonBody: { quote: outcome.quote } };
  } catch (error: unknown) {
    if (connection && inTransaction) await rollbackTransaction(connection).catch(() => undefined);
    context.error("recordEmailQuoteDecision failed:", error instanceof Error ? error.message : String(error));
    return errorResponse("Record email quote decision failed", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}
```

- [ ] **Step 4: Register it**

After the `promoteEmailToJobUpdate` registration add:

```ts
app.http("recordEmailQuoteDecision", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: recordEmailQuoteDecision,
});
```

- [ ] **Step 5: Refresh the file header**

Replace lines 1–5 of `src/functions/emails.ts` with:

```ts
// Emails — intake + promote actions for the Incoming page. Rows arrive from
// the email-sync queue (processEmailSync → upsertGraphEmails) or ingestEmail;
// `jobIdFromText` sets MatchedJobID deterministically. Promote endpoints turn
// an email into a Job, Quote, Invoice, job-timeline update
// (promoteEmailToJobUpdate) or a recorded director decision
// (recordEmailQuoteDecision), then flip it to 'promoted'.
```

- [ ] **Step 6: Run — green**

```
npx jest src/functions/emails.test.ts
```

Expected: `Tests: 14 passed, 14 total`.

- [ ] **Checkpoint:** run `npx tsc --noEmit && npx jest` (expected: all pass — 61 suites, 1276 tests) and hand to Will to commit.

---

### Task 12: Full verification and settings documentation

**Files:**
- Modify: `README.md` (lines 41–42 and 109–110)

- [ ] **Step 1: Document the new settings and the queue**

In `README.md`, after line 42 (`- \`TODDLER_SERVICE_KEY\` — …`) add:

```markdown
- `TODDLER_WARMUP_TIMEOUT_MS` — budget for `POST /warmup` before each parse run (default `240000`; covers a cold GPU replica; capped by the run's 540 s deadline)
- `AI_PARSE_BATCH_SIZE` — upper bound on emails per parse run (default `5`); the deadline usually stops a run first
- `AI_PARSE_SKIP_SENDERS` — optional comma list of sender substrings (e.g. `no-reply@,notifications@mybuildings`) classified `unknown` without a model call
- The `email-sync` Storage queue (webhook / manual sync / admin trigger → `processEmailSync`) lives on `AzureWebJobsStorage`; no extra setting. Locally, run Azurite.
```

and after line 110 (`- \`TODDLER_SERVICE_KEY\``) add:

```markdown
- `TODDLER_WARMUP_TIMEOUT_MS`
- `AI_PARSE_SKIP_SENDERS` (optional)
```

- [ ] **Step 2: Type-check, lint, test**

```
npx tsc --noEmit && npm run lint && npx jest
```

Expected: `tsc` silent; eslint silent (no `local/no-sql-interpolation` hits — every SQL interpolation added is `${QUOTE_COLUMNS}`); Jest `Test Suites: 61 passed, 61 total`, `Tests: 1 todo, 1276 passed, 1277 total`.

- [ ] **Step 3: Security audit (read-only — never `npm audit fix` in this repo)**

```
npm audit --omit=dev
```

Expected: exactly the 3 known findings under `exceljs` (1 high `brace-expansion`, moderate `uuid`) documented in the parent CLAUDE.md — no new advisories, because no dependency changed. `package-lock.json` must show no diff: `git diff --stat package-lock.json` prints nothing.

- [ ] **Step 4: Confirm the registration set and host settings**

```
grep -n "app\.\(http\|timer\|storageQueue\)(\"" src/functions/parseEmails.ts src/functions/emails.ts src/functions/graphWebhook.ts
node -e "const h=require('./host.json'); console.log(h.functionTimeout, JSON.stringify(h.extensions.queues))"
```

Expected the grep to include: `parseEmailsTimer`, `parseEmailsDailyRetry`, `processEmailSync`, `triggerEmailParse`, `getFlaggedEmails`, `syncEmailsNow`, `promoteEmailToJobUpdate`, `recordEmailQuoteDecision`, `graphNotification`. Expected node output: `00:10:00 {"batchSize":1,"maxDequeueCount":3}`.

- [ ] **Step 5: Local smoke (optional, needs Docker DB + Azurite + `npm start`)**

With `TODDLER_URL` unset locally the timer must log `parseEmailsTimer: TODDLER_URL not configured — skipping (AI service not yet deployed)` every two minutes and run no SQL. Set `TODDLER_URL=http://localhost:9` (nothing listening) and queue one unparsed row: the tick must log `warmUpToddler: failed after …` and the row's `AIParseAttempts` must stay unchanged — proof that a failed warm-up records nothing. `POST /api/syncEmailsNow` must return 202 at once, and the host log must then show `processEmailSync (manual): synced …`.

- [ ] **Checkpoint:** run `npx tsc --noEmit && npx jest` (expected: all pass) and hand to Will to commit.

---

## Self-review

### Spec coverage

| Spec item | Task |
|---|---|
| §6.4 `hydrateAttachmentRefs` accepts plain strings and `{ blobName, fileName }`, lands first | Task 1 |
| §5A.2.1 `src/email/job-ref.ts`, `jobIdFromText(subject, body)`, `Job #N` + `\b(\d{6})-(PO\|QT\|IV)-(\d+)-` (group 3), real PO / `Re:` / `RE: Fwd:` subjects, legacy `PO-{JobID}-{seq}` and `PO-{PurchaseOrderID}` not matched, replaces both inline regexes (ingest + Graph sync) | Task 2 |
| §6.2 `host.json` `functionTimeout` 00:10:00 | Task 3 Step 6 |
| §6.2 deadline = invocation start + 540 s, warm-up counts, claim one row at a time, stop when remaining < `TODDLER_TIMEOUT_MS` + 30 s, `AI_PARSE_BATCH_SIZE` as an upper bound | Tasks 3, 4 |
| §6.2 `parseEmailsTimer` `0 */2 * * * *`: config skip → cheap queue check → `/warmup` with `TODDLER_WARMUP_TIMEOUT_MS` (240000) → deadline runner; singleton; daily retry and `processEmailSync` use the same helper | Tasks 4, 6 |
| §6.1 no HTTP handler waits on warm-up or parsing: queue `email-sync` on `AzureWebJobsStorage`; webhook / `syncEmailsNow` / `triggerEmailParse` enqueue + 202 (`?reset=true` still resets first); `processEmailSync` = sync + attachments + deadline runner; `host.json` queues `batchSize: 1`, `maxDequeueCount: 3` | Task 6 |
| §6.1 corrected webhook deadline comment (3 s) | Task 6 Step 4 |
| Sync re-lists the newest message (`ge`): skip stored MessageIDs before attachment download | Task 5 |
| §5A.2.2 one SELECT per matched email → `knownJob { jobId, title, status, contractorName, awaitingDirectorQuote }` sent on the request | Task 7 |
| §5A.5 widen `ToddlerResponse.classification` to six values | Task 7 Step 3 |
| §5A.5 `AI_PARSE_SKIP_SENDERS` → `unknown`/`high`, no GPU call, `modelVersion` `skip-sender@v5` | Task 7 Steps 4, 8 |
| §5A.5 Migration `089_job_events_source_email.sql` | Task 8 |
| §5A.5 extract `approveDirectorQuote(...)` / `rejectQuote(...)` helpers from `quotes.ts`, used by the handlers and the email endpoint; director helper keeps the literal-director rule; reject helper requires the expected status (409) and takes the actor from the verified identity, never the body | Task 9 |
| §5A.5 director approvals stay director-only; admins deliberately excluded | Task 9 (handler + test), Task 11 (sender lookup + test) |
| §5A.5 `promoteEmailToJobUpdate` body / event row / `CreatedBy` from verified token / `nextState` pre-check → 422 writes nothing / `advanceJobStatus` `!advanced` → 409 / email flip with `MatchedJobID` fallback / roles mirror `promoteEmailToJob` | Task 10 |
| §5A.5 `recordEmailQuoteDecision` body / not `awaiting_director` (409) / recipient check (422) / active `AppUsers` director (422) / `DirectorApprovedBy` = `DisplayName` / "Director-approved … via email" with `SourceEmailID` / caller roles mirror `promoteEmailToQuote` | Tasks 9, 11 |
| §6.3 settings read by code (`TODDLER_WARMUP_TIMEOUT_MS`, `AI_PARSE_BATCH_SIZE` as cap, `AI_PARSE_SKIP_SENDERS`) documented | Task 12 Step 1 |
| §9 `parseEmails.test.ts`: `hydrateAttachmentRefs` string / object / mixed / junk; timer skips when no rows; warm-up failure aborts without touching rows; warm-up success proceeds; one-row claims and the deadline stop; `knownJob` sent / omitted; skip-senders short-circuit | Tasks 1, 3, 4, 7 |
| §9 `graphWebhook.test.ts` (create): webhook enqueues + 202 without Graph or `runParseBatch`; same for `syncEmailsNow`. `triggerEmailParse` and `processEmailSync` (sync then deadline runner) | Task 6 (see deviations for where the last two live) |
| §9 `email/job-ref.test.ts`: positives incl. `Purchase Order 260419-PO-42-ACM-7 — …`, `Re:` and `RE: Fwd:` → 42; unrelated digit runs, legacy `PO-42-1`, `PO-{PurchaseOrderID}` → null | Task 2 |
| §9 `emails.test.ts` (create): event written with `SourceEmailID` + flip; `MarkWorkCompleted` from non-Work → 422 nothing written; moved underneath → 409; 422 not recipient; 422 not active director (admin sender included); 409 not awaiting; approve + reject happy paths with the actor never from the body | Tasks 10, 11 |

Deviations, all deliberate and visible in the steps:
- `triggerEmailParse` and `processEmailSync` tests live in `parseEmails.test.ts`, not `graphWebhook.test.ts` (§9): both handlers are in `parseEmails.ts`, and `graphWebhook.test.ts` mocks that module to prove the webhook never parses. `syncEmailsNow`'s test is in `graphWebhook.test.ts` as §9 says.
- The document-number regex keeps the `i` flag on top of §5A.2's pattern so a lower-cased forward (`260419-po-42-acm-7`) still matches; the test suite pins it.
- `directorApproveQuote` also takes its actor from the verified token (the decision named only the reject path); the body's `ApprovedBy` is ignored, same as `RejectedBy`.
- The approve helper's status refusals are 409 (were 400 in-app), matching the reject helper and §9's "409 when not `awaiting_director`". Both helpers re-check the status inside the `UPDATE … WHERE`, so a concurrent change is a 409 too.
- In-app `rejectQuote` allows `pending` or `awaiting_director` (the card offers Reject only on `pending`; `awaiting_director` keeps a director-side reject possible). Approved / completed / rejected quotes now get a 409 instead of being silently flipped to rejected.
- New quote-handler tests (`src/functions/quotes.test.ts`) — not listed in §9, but the extracted handlers change behaviour (actor source, 409s, literal-director check) and need pinning.
- Skipped-sender rows are **not** flagged for review (`AIFlaggedForReview = 0`) — a deterministic rule is not a low-confidence read, and flagging would hide them from the Incoming "Archive" action §5A.1 assigns to `unknown`. `writeSuccess` therefore takes the flag from its caller.
- `triggerEmailParse` returns 503 (instead of a silent enqueue) when toddler is unconfigured; with toddler configured it returns `202 { queued, reset }` — no per-batch summary any more.
- Skipping already-stored messages means `upsertGraphEmails`' attachment back-fill branch no longer fires for Graph-synced rows (Task 5 note).

### Placeholder scan

No "TBD", "TODO", "implement later", "add appropriate error handling", "add validation", "write tests for the above", or "similar to Task N". Every code step shows the complete code.

### Type / name consistency

- `hydrateAttachmentRefs(raw: string | null): ToddlerAttachmentRef[]` — exported in Task 1 (with `ToddlerAttachmentRef`, required by `declaration: true`); called from `parseClaimedEmail` in Tasks 3 and 7.
- `jobIdFromText(subject: string \| null \| undefined, body: string \| null \| undefined): number \| null` — Task 2 definition, Task 2 call sites.
- `runParseBatch(token, context, deadline = Date.now() + RUN_BUDGET_MS): Promise<ParseBatchResult>` — Task 3; `parseQueued` passes the invocation's deadline (Tasks 4, 6). `ParseBatchResult` shape unchanged, so existing `toEqual` assertions hold.
- `expireExhausted(token)`, `claimOne(token): Promise<ClaimedEmail \| null>`, `parseClaimedEmail(token, email, context): Promise<EmailOutcome>` — Task 3; `claimOne` OUTPUT and `parseClaimedEmail` body extended in Task 7.
- `warmUpToddler(context, timeoutMs?): Promise<boolean>`, `toddlerConfigured(context, caller): boolean`, `hasUnparsedEmails(token): Promise<boolean>`, `parseQueued(caller, context, deadline): Promise<void>`, `parseEmailsTimer(_timer, context): Promise<void>` — Task 4; `toddlerConfigured` reused by `adminTriggerEmailParse` in Task 6.
- `graphFetchEmails(mailbox, sinceDateTime?, knownMessageIds = new Set())` and `syncMailbox(connection, mailbox): Promise<MailboxSyncResult>` — Task 5; `syncMailbox` called only from `processEmailSync` (Task 6).
- `EMAIL_SYNC_QUEUE`, `emailSyncQueueOutput`, `enqueueEmailSync(context, source)`, `isEmailSyncMessage` — Task 6; every handler that calls `enqueueEmailSync` lists `emailSyncQueueOutput` in `extraOutputs` (`graphNotification`, `syncEmailsNow`, `triggerEmailParse`).
- `ClaimedEmail.MatchedJobID: number \| null` ↔ `OUTPUT inserted.MatchedJobID` ↔ test fixture `MatchedJobID: null as number \| null`.
- `writeSuccess(token, emailId, hints, result, flagged)` — both call sites in Task 7's `parseClaimedEmail` pass five args.
- `QuoteDecisionOutcome` (`status: 404 \| 409`), `approveDirectorQuote(connection, { quoteId, approvedBy, sourceEmailId? })`, `rejectQuote(connection, { quoteId, rejectedBy, expectedStatuses, note?, sourceEmailId? })` — Task 9 definitions; Task 9 (quotes.ts, imported as `rejectQuoteWrite`) and Task 11 (emails.ts) call sites, and the Task 9 / Task 11 `toHaveBeenCalledWith` arguments use identical shapes.
- `PROMOTE_EMAIL_ROLES` defined in Task 10, used in Tasks 10 and 11.
- SQL columns used exist in the migrations read: `Emails(EmailID, MessageID, FromAddress, Subject, Body, ReceivedAt, MatchedJobID, Status, ProcessedAt, AIParsedAt, AIParseAttempts, …)`, `Jobs(JobID, Title, Status, AwaitingRole, ApprovedQuoteID, ApprovedBy, ApprovedAt, LastModifiedDate)`, `Quotes(QuoteID, JobID, QuoteNumber, ContractorName, Amount, Status, CreatedAt, DirectorApprovedAt, DirectorApprovedBy, DirectorEmailSentTo)`, `PurchaseOrders(JobID, ContractorName, CreatedAt)`, `AppUsers(DisplayName, Email, Role, IsActive)`, `JobEvents(JobEventID, JobID, CreatedBy, [Text], EventType, QuoteID, SourceEmailID ← 089)`.
- Response shapes: `promoteEmailToJobUpdate` → `{ jobId, eventId, newStatus }`; `recordEmailQuoteDecision` → `{ quote }` (same as `directorApproveQuote`); `syncEmailsNow` → `202 { queued: true }`; `triggerEmailParse` → `202 { queued: true, reset }`.
