// ─────────────────────────────────────────────────────────────────────────────
// Email AI parsing — batch worker + admin-only flagged read.
//
// Every 5 minutes, `parseEmailsTimer`:
//   1. Flags permanently-failed rows (attempts ≥ 3) and stops retrying them.
//   2. Atomically claims a batch of unparsed rows (incrementing attempts).
//   3. Pre-extracts PO#/Quote# hints via regex (cheap, deterministic).
//   4. Calls codename-toddler's /parse-incoming for each one.
//   5. Writes the classification/data/confidence back to Emails.
//
// `getFlaggedEmails` is the read-side for the dev-only Flagged Incoming page.
// It returns rows where the AI flagged low confidence, errored, or never
// responded. The page is read-only — no mutations here, just a diagnosis view.
// ─────────────────────────────────────────────────────────────────────────────

import { app, HttpRequest, HttpResponseInit, InvocationContext, Timer } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createConnection, executeQuery, SqlRow } from "../db";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { generateReadSasUrl } from "../blob-storage";

// ── Config ──────────────────────────────────────────────────────────────────

const TODDLER_URL = process.env.TODDLER_URL ?? "http://localhost:8000";
const TODDLER_TIMEOUT_MS = Number(process.env.TODDLER_TIMEOUT_MS ?? "180000");
const BATCH_SIZE = Number(process.env.AI_PARSE_BATCH_SIZE ?? "5");
const MAX_ATTEMPTS = 3;

// ── Hint extraction ─────────────────────────────────────────────────────────
// Cheap regex pass. The results are soft signals — passed into the prompt
// and also stored on the email row so the UI can show "detected PO#1234"
// even when the LLM misses it. Keep patterns conservative to avoid false
// positives; the model is the fallback when the regex comes up empty.

const PO_PATTERN =
  /\b(?:P\.?O\.?|Purchase\s*Order)[\s:#-]*([A-Z0-9][A-Z0-9-]{1,20})\b/i;
const QUOTE_PATTERN =
  /\b(?:Quote|Q)[\s:#-]+([A-Z0-9][A-Z0-9-]{1,20})\b/i;

export interface ExtractedHints {
  poNumber: string | null;
  quoteNumber: string | null;
}

export function extractHints(
  subject: string | null | undefined,
  body: string | null | undefined,
): ExtractedHints {
  const haystack = `${subject ?? ""}\n${body ?? ""}`;
  const po = haystack.match(PO_PATTERN);
  const quote = haystack.match(QUOTE_PATTERN);
  return {
    poNumber: po?.[1] ?? null,
    quoteNumber: quote?.[1] ?? null,
  };
}

// ── Toddler client ──────────────────────────────────────────────────────────

interface ToddlerAttachmentRef {
  fileName: string;
  sasUrl: string;
  contentType?: string | null;
}

interface ToddlerRequest {
  html: string;
  subject?: string | null;
  fromAddress?: string | null;
  hints: { poNumber?: string | null; quoteNumber?: string | null };
  attachments: ToddlerAttachmentRef[];
}

interface ToddlerResponse {
  classification: "job" | "quote" | "invoice" | "unknown";
  confidence: "high" | "medium" | "low";
  data: Record<string, unknown>;
  modelVersion: string;
  rawResponse: string | null;
  error: string | null;
}

async function callToddler(req: ToddlerRequest): Promise<ToddlerResponse> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TODDLER_TIMEOUT_MS);
  try {
    const response = await fetch(`${TODDLER_URL}/parse-incoming`, {
      body: JSON.stringify(req),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Toddler ${response.status}: ${text.slice(0, 200)}`);
    }
    return (await response.json()) as ToddlerResponse;
  } finally {
    clearTimeout(t);
  }
}

// ── Batch claim + writeback ────────────────────────────────────────────────

interface ClaimedEmail {
  AttachmentBlobs: string | null;
  Body: string | null;
  EmailID: number;
  FromAddress: string | null;
  Subject: string | null;
}

async function claimBatch(
  token: string,
  batchSize: number,
): Promise<ClaimedEmail[]> {
  const connection = await createConnection(token);
  try {
    // Mark rows that have burned through their retries. We stamp AIParsedAt
    // so the queue filter stops picking them up, flag them for admin review,
    // and record why. Done in a single UPDATE for idempotency.
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

    // Atomic claim: bump the attempt counter and return the rows in one
    // statement so two concurrent workers can't pick up the same row.
    const rows = (await executeQuery(
      connection,
      `UPDATE TOP (@BatchSize) Emails
         SET AIParseAttempts = AIParseAttempts + 1
         OUTPUT inserted.EmailID, inserted.Subject, inserted.FromAddress,
                inserted.Body, inserted.AttachmentBlobs
       WHERE AIParsedAt IS NULL
         AND AIParseAttempts < @MaxAttempts`,
      [
        { name: "BatchSize", type: TYPES.Int, value: batchSize },
        { name: "MaxAttempts", type: TYPES.Int, value: MAX_ATTEMPTS },
      ],
    )) as unknown as ClaimedEmail[];

    return rows;
  } finally {
    closeConnection(connection);
  }
}

async function writeSuccess(
  token: string,
  emailId: number,
  hints: ExtractedHints,
  result: ToddlerResponse,
): Promise<void> {
  const flag = result.confidence === "low" || result.classification === "unknown";
  const connection = await createConnection(token);
  try {
    await executeQuery(
      connection,
      `UPDATE Emails
         SET AIParsedAt = SYSUTCDATETIME(),
             AIClassification = @Classification,
             AIConfidence = @Confidence,
             AIParsedData = @ParsedData,
             AIRawResponse = @RawResponse,
             AIModelVersion = @ModelVersion,
             AIParseError = @Error,
             AIHintPO = @HintPO,
             AIHintQuote = @HintQuote,
             AIFlaggedForReview = @Flagged
       WHERE EmailID = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: emailId },
        { name: "Classification", type: TYPES.NVarChar, value: result.classification },
        { name: "Confidence", type: TYPES.NVarChar, value: result.confidence },
        { name: "ParsedData", type: TYPES.NVarChar, value: JSON.stringify(result.data ?? {}) },
        { name: "RawResponse", type: TYPES.NVarChar, value: result.rawResponse ?? null },
        { name: "ModelVersion", type: TYPES.NVarChar, value: result.modelVersion },
        { name: "Error", type: TYPES.NVarChar, value: result.error?.slice(0, 500) ?? null },
        { name: "HintPO", type: TYPES.NVarChar, value: hints.poNumber },
        { name: "HintQuote", type: TYPES.NVarChar, value: hints.quoteNumber },
        { name: "Flagged", type: TYPES.Bit, value: flag ? 1 : 0 },
      ],
    );
  } finally {
    closeConnection(connection);
  }
}

async function recordTransientError(
  token: string,
  emailId: number,
  err: Error,
): Promise<void> {
  // Transient failure (network, Toddler down, timeout). Keep AIParsedAt null
  // so the next run retries — only the error text and hint fields are
  // touched here. Attempt counter was incremented by claimBatch already.
  const connection = await createConnection(token);
  try {
    await executeQuery(
      connection,
      `UPDATE Emails SET AIParseError = @Error WHERE EmailID = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: emailId },
        { name: "Error", type: TYPES.NVarChar, value: err.message.slice(0, 500) },
      ],
    );
  } finally {
    closeConnection(connection);
  }
}

// ── Attachment hydration (local helper — mirrors emails.ts) ────────────────

function hydrateAttachmentRefs(raw: string | null): ToddlerAttachmentRef[] {
  if (!raw) return [];
  let names: unknown;
  try {
    names = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(names)) return [];
  const hour = 60 * 60 * 1000;
  return names
    .filter((n): n is string => typeof n === "string" && n.length > 0)
    .map((blobName) => ({
      fileName: blobName.split("/").pop() ?? blobName,
      sasUrl: generateReadSasUrl(blobName, hour),
    }));
}

// ── Timer: parseEmailsTimer ────────────────────────────────────────────────

async function parseEmailsTimer(
  timer: Timer,
  context: InvocationContext,
): Promise<void> {
  if (timer.isPastDue) {
    context.warn("parseEmailsTimer past due — running now");
  }

  const token = process.env.MYBUILDINGS_BEARER_TOKEN;
  if (!token) {
    context.error("parseEmailsTimer: MYBUILDINGS_BEARER_TOKEN not set");
    return;
  }

  let claimed: ClaimedEmail[];
  try {
    claimed = await claimBatch(token, BATCH_SIZE);
  } catch (err: any) {
    context.error("parseEmailsTimer claim failed:", err.message);
    return;
  }

  if (claimed.length === 0) {
    context.log("parseEmailsTimer: no unparsed emails");
    return;
  }

  context.log(`parseEmailsTimer: claimed ${claimed.length} email(s)`);

  let succeeded = 0;
  let flagged = 0;
  let errored = 0;

  for (const email of claimed) {
    const hints = extractHints(email.Subject, email.Body);
    try {
      const result = await callToddler({
        attachments: hydrateAttachmentRefs(email.AttachmentBlobs),
        fromAddress: email.FromAddress,
        hints,
        html: email.Body ?? "",
        subject: email.Subject,
      });
      await writeSuccess(token, email.EmailID, hints, result);
      succeeded++;
      if (result.confidence === "low" || result.classification === "unknown") {
        flagged++;
      }
    } catch (err: any) {
      await recordTransientError(token, email.EmailID, err).catch((e) =>
        context.error(`failed to record error for #${email.EmailID}:`, e.message),
      );
      errored++;
      context.error(`parse failed for email #${email.EmailID}:`, err.message);
    }
  }

  context.log(
    `parseEmailsTimer done: succeeded=${succeeded}, flagged=${flagged}, errored=${errored}`,
  );
}

// ── GET /api/getFlaggedEmails ──────────────────────────────────────────────
// Returns emails the AI couldn't confidently parse, for the admin-only
// Flagged Incoming dev review page. Read-only — the page does not mutate.

const FLAGGED_COLUMNS = `
  EmailID, MessageID, FromAddress, Subject, Body, ReceivedAt,
  AttachmentBlobs, MatchedJobID, Status, ProcessedAt, CreatedAt,
  AIParsedAt, AIClassification, AIConfidence, AIParsedData,
  AIRawResponse, AIModelVersion, AIParseError,
  AIHintPO, AIHintQuote, AIParseAttempts, AIFlaggedForReview
`;

async function getFlaggedEmails(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(token, ["Admin"]);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT ${FLAGGED_COLUMNS}
         FROM Emails
        WHERE AIFlaggedForReview = 1
        ORDER BY CreatedAt DESC`,
    );
    return {
      jsonBody: { count: rows.length, emails: rows },
      status: 200,
    };
  } catch (error: any) {
    context.error("getFlaggedEmails failed:", error.message);
    return errorResponse("Failed to fetch flagged emails", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── Registrations ──────────────────────────────────────────────────────────

app.timer("parseEmailsTimer", {
  handler: parseEmailsTimer,
  schedule: "0 */5 * * * *", // every 5 minutes
});

app.http("getFlaggedEmails", {
  authLevel: "anonymous",
  handler: getFlaggedEmails,
  methods: ["GET"],
});

// Re-export helper — consumed by the unit tests.
export { parseEmailsTimer };

// Unused-import silencer: SqlRow is re-exported so tests can import it via
// this module without reaching into db.ts directly.
export type { SqlRow };
