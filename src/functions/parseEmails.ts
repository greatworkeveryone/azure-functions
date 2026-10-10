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
// Triggers — no HTTP handler parses:
//   - `processEmailSync` (Storage queue "email-sync"): fed by the Graph
//     webhook, the manual sync button and `triggerEmailParse`; syncs the
//     mailbox first, then parses.
//   - `parseEmailsTimer` (every 2 min): parse-only backstop for lost/failed
//     messages — it never syncs the mailbox.
//   - `parseEmailsDailyRetry` (02:00 UTC): once-a-day safety net; parses and
//     enqueues one mail sync (the only mailbox backstop if the webhook dies).
//
// `getFlaggedEmails` is the read-side for the dev-only Flagged Incoming page.
// It returns rows where the AI flagged low confidence, errored, or never
// responded. The page is read-only — no mutations here, just a diagnosis view.
// ─────────────────────────────────────────────────────────────────────────────

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import {
  closeConnection,
  createRequestConnection,
  createServiceRequestConnection,
  executeQuery,
  SqlRow,
} from "../db";
import { AppRole, errorResponse, extractToken, oidFromToken, requireRole, unauthorizedResponse } from "../auth";
import { generateReadSasUrl } from "../blob-storage";
import { syncMailbox } from "../email/mail-sync";
import { EMAIL_SYNC_QUEUE, emailSyncQueueOutput, enqueueEmailSync, isEmailSyncMessage } from "../email/sync-queue";
import { checkRateLimit } from "../rateLimit";
import { Sentry } from "../sentry";

// ── Config ──────────────────────────────────────────────────────────────────

const TODDLER_URL = process.env.TODDLER_URL ?? "";
// Must equal toddler's SERVICE_KEY_COMMAND_CENTRE. /parse-incoming rejects
// anonymous calls with 401, so without it every parse burns a retry.
const TODDLER_SERVICE_KEY = process.env.TODDLER_SERVICE_KEY ?? "";

// Positive integer from an env string, else `fallback` — a typo must not
// become NaN and silently stop the runner.
export function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

const TODDLER_TIMEOUT_MS = positiveIntFromEnv(process.env.TODDLER_TIMEOUT_MS, 180_000);
// Warm-up budget covers a cold Container App replica: image pull plus a model
// load from Azure Files. Toddler answers within 230 s; parseQueued shrinks this
// further if the run's deadline is closer.
const TODDLER_WARMUP_TIMEOUT_MS = positiveIntFromEnv(process.env.TODDLER_WARMUP_TIMEOUT_MS, 240_000);
// Upper bound on emails per run. The deadline below normally stops a run first.
const MAX_EMAILS_PER_RUN = positiveIntFromEnv(process.env.AI_PARSE_BATCH_SIZE, 5);
const MAX_ATTEMPTS = 3;
// A claim is exclusive for this long. Must be >= functionTimeout (600 s) so a
// live run never loses its row; a killed run's row frees up after it.
const CLAIM_LEASE_SECONDS = 600;
// host.json functionTimeout is 10 min (Consumption maximum). Every run gets a
// deadline of invocation start + 540 s; warm-up counts against it.
export const RUN_BUDGET_MS = 540_000;
// Claim another email only while a full toddler timeout plus 30 s of
// write-back still fits before the deadline.
const MIN_EMAIL_BUDGET_MS = TODDLER_TIMEOUT_MS + 30_000;
let budgetWarned = false;

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

export interface ToddlerAttachmentRef {
  fileName: string;
  sasUrl: string;
  contentType?: string | null;
}

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

export interface DocumentField {
  value: string | number | null;
  confidence: number;
}

interface ToddlerResponse {
  classification: ToddlerClassification;
  confidence: "high" | "medium" | "low";
  data: Record<string, unknown>;
  documentFields?: Record<string, DocumentField> | null;
  suspicious?: boolean;
  suspicionReasons?: string[];
  modelVersion: string;
  rawResponse: string | null;
  error: string | null;
}

// ── Skip-senders ────────────────────────────────────────────────────────────
// AI_PARSE_SKIP_SENDERS: comma-separated, case-insensitive substring match
// against the sender address; include the "@" (e.g. "@mybuildings.example.com")
// to avoid broad matches. Matching rows are classified unknown/high
// deterministically — no GPU call, and not flagged: there is nothing for a
// reviewer to second-guess.

const SKIP_SENDERS = (process.env.AI_PARSE_SKIP_SENDERS ?? "")
  .split(",")
  .map((p) => p.trim().toLowerCase())
  .filter((p) => p.length > 0);

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

// Toddler rejected the request itself (400/422): retrying the same payload
// cannot succeed, so the row is finalised instead of burning its attempts.
class ToddlerRejectedError extends Error {}

const FIELD_CAPS = { attachmentFileName: 255, fromAddress: 1000, subject: 2000 } as const;

function cap(value: string | null, max: number): string | null {
  return value === null ? null : value.slice(0, max);
}

async function callToddler(req: ToddlerRequest): Promise<ToddlerResponse> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TODDLER_TIMEOUT_MS);
  try {
    const response = await fetch(`${TODDLER_URL}/parse-incoming`, {
      body: JSON.stringify(req),
      headers: {
        "Content-Type": "application/json",
        "X-Service-Key": TODDLER_SERVICE_KEY,
      },
      method: "POST",
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const message = `Toddler ${response.status}: ${text.slice(0, 200)}`;
      throw response.status === 400 || response.status === 422 ? new ToddlerRejectedError(message) : new Error(message);
    }
    return (await response.json()) as ToddlerResponse;
  } finally {
    clearTimeout(t);
  }
}

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

// POST /warmup loads the model and returns when it is resident. False on any
// failure (503, 429 rate limit, 401, timeout) — callers skip the batch and the
// next run retries, so a cold start never burns an email's retry budget.
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
    const body = (await response.json().catch(() => null)) as { elapsedMs?: unknown } | null;
    const toddlerMs = body?.elapsedMs;
    const suffix = typeof toddlerMs === "number" && Number.isFinite(toddlerMs) ? ` (toddler ${toddlerMs}ms)` : "";
    context.log(`warmUpToddler: model ready after ${Date.now() - started}ms${suffix}`);
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    context.error(`warmUpToddler: failed after ${Date.now() - started}ms —`, message);
    return false;
  } finally {
    clearTimeout(t);
  }
}

// Same predicate as claimOne, lease included: only rows a runner could claim
// now count, so a leased-only queue doesn't warm the scale-to-zero GPU.
// Hits IX_Emails_AIParse_Queue.
async function hasUnparsedEmails(token: string): Promise<boolean> {
  const connection = await createRequestConnection(token);
  try {
    const rows = await executeQuery(
      connection,
      `SELECT TOP (1) EmailID
         FROM Emails
        WHERE AIParsedAt IS NULL
          AND AIParseAttempts < @MaxAttempts
          AND (AIClaimedAt IS NULL OR AIClaimedAt < DATEADD(SECOND, -@LeaseSeconds, SYSUTCDATETIME()))`,
      [
        { name: "MaxAttempts", type: TYPES.Int, value: MAX_ATTEMPTS },
        { name: "LeaseSeconds", type: TYPES.Int, value: CLAIM_LEASE_SECONDS },
      ],
    );
    return rows.length > 0;
  } finally {
    closeConnection(connection);
  }
}

// ── Reset failed emails back into the queue ────────────────────────────────
// Clears parse state on emails that errored or hit max retries so they can
// be picked up again on the next claimOne call. Only resets rows that
// failed — successfully classified emails (AIClassification IS NOT NULL,
// AIParseError IS NULL) are left untouched.

async function resetFailedEmails(token: string): Promise<number> {
  const connection = await createRequestConnection(token);
  try {
    const rows = (await executeQuery(
      connection,
      `UPDATE Emails
          SET AIParsedAt        = NULL,
              AIParseAttempts   = 0,
              AIFlaggedForReview = 0,
              AIParseError      = NULL,
              AIClassification  = NULL,
              AIConfidence      = NULL,
              AIParsedData      = NULL,
              AIRawResponse     = NULL,
              AIModelVersion    = NULL,
              AIClaimedAt       = NULL
        WHERE AIParsedAt IS NOT NULL
          AND (AIParseError IS NOT NULL
               OR AIClassification IS NULL)`,
    )) as unknown as { rowsAffected?: number }[];
    return (rows as any)?.rowsAffected ?? 0;
  } finally {
    closeConnection(connection);
  }
}

// ── Batch claim + writeback ────────────────────────────────────────────────

interface ClaimedEmail {
  AttachmentBlobs: string | null;
  Body: string | null;
  EmailID: number;
  FromAddress: string | null;
  MatchedJobID: number | null;
  Subject: string | null;
}

// Rows that burned through their retries: stamp AIParsedAt so the queue
// filter stops picking them up, flag them for admin review, record why.
// Skips rows still leased — their last attempt may yet succeed.
// Idempotent; runs on every parseQueued tick (even idle) and in runParseBatch
// for direct callers (emails.ts, graphWebhook).
async function expireExhausted(token: string): Promise<void> {
  const connection = await createRequestConnection(token);
  try {
    await executeQuery(
      connection,
      `UPDATE Emails
         SET AIParsedAt = SYSUTCDATETIME(),
             AIFlaggedForReview = 1,
             AIParseError = ISNULL(AIParseError, 'Max retries exhausted'),
             AIClaimedAt = NULL
       WHERE AIParsedAt IS NULL
         AND AIParseAttempts >= @MaxAttempts
         AND (AIClaimedAt IS NULL OR AIClaimedAt < DATEADD(SECOND, -@LeaseSeconds, SYSUTCDATETIME()))`,
      [
        { name: "MaxAttempts", type: TYPES.Int, value: MAX_ATTEMPTS },
        { name: "LeaseSeconds", type: TYPES.Int, value: CLAIM_LEASE_SECONDS },
      ],
    );
  } finally {
    closeConnection(connection);
  }
}

// Claims ONE row under a lease: bump attempts and stamp AIClaimedAt in one
// statement. The statement commits at once, so the lease (not a held lock) is
// what keeps concurrent runners (queue, timer, daily retry) off the row while
// toddler works; UPDLOCK + READPAST stop two claims racing for the same row.
// Final write-backs clear the lease; transient errors keep it so the retry
// waits for expiry; a killed run's row frees after the lease and
// has spent one attempt.
async function claimOne(token: string): Promise<ClaimedEmail | null> {
  const connection = await createRequestConnection(token);
  try {
    const rows = (await executeQuery(
      connection,
      `WITH claimable AS (
         SELECT TOP (1) EmailID, Subject, FromAddress, Body, AttachmentBlobs,
                MatchedJobID, AIParseAttempts, AIClaimedAt
           FROM Emails WITH (ROWLOCK, UPDLOCK, READPAST)
          WHERE AIParsedAt IS NULL
            AND AIParseAttempts < @MaxAttempts
            AND (AIClaimedAt IS NULL OR AIClaimedAt < DATEADD(SECOND, -@LeaseSeconds, SYSUTCDATETIME()))
          ORDER BY EmailID
       )
       UPDATE claimable
          SET AIParseAttempts = AIParseAttempts + 1,
              AIClaimedAt = SYSUTCDATETIME()
       OUTPUT inserted.EmailID, inserted.Subject, inserted.FromAddress,
              inserted.Body, inserted.AttachmentBlobs, inserted.MatchedJobID`,
      [
        { name: "MaxAttempts", type: TYPES.Int, value: MAX_ATTEMPTS },
        { name: "LeaseSeconds", type: TYPES.Int, value: CLAIM_LEASE_SECONDS },
      ],
    )) as unknown as ClaimedEmail[];
    return rows[0] ?? null;
  } finally {
    closeConnection(connection);
  }
}

// ── Known-job context ──────────────────────────────────────────────────────
// One SELECT per matched email. Contractor name comes from the approved
// quote, else the latest PO, else the awaiting-director quote. The awaiting_director quote (if any) is what
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
              COALESCE(aq.ContractorName, po.ContractorName, dq.ContractorName) AS ContractorName,
              dq.QuoteID AS AwaitingQuoteID,
              dq.QuoteNumber AS AwaitingQuoteNumber,
              dq.Amount AS AwaitingQuoteAmount
         FROM Jobs j
         LEFT JOIN Quotes aq ON aq.QuoteID = j.ApprovedQuoteID
         OUTER APPLY (SELECT TOP (1) p.ContractorName
                        FROM PurchaseOrders p
                       WHERE p.JobID = j.JobID
                       ORDER BY p.CreatedAt DESC, p.PurchaseOrderID DESC) po
         OUTER APPLY (SELECT TOP (1) q.QuoteID, q.QuoteNumber, q.Amount, q.ContractorName
                        FROM Quotes q
                       WHERE q.JobID = j.JobID AND q.Status = 'awaiting_director'
                       ORDER BY q.CreatedAt DESC, q.QuoteID DESC) dq
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

const MAX_SUSPICION_REASONS = 5;
const MAX_SUSPICION_REASON_LENGTH = 200;

interface Suspicion {
  suspicious: true;
  suspicionReasons: string[];
}

// Only a real `true` counts; reasons are string items only, capped.
function readSuspicion(result: ToddlerResponse): Suspicion | null {
  if (result.suspicious !== true) return null;
  const raw: unknown = result.suspicionReasons;
  const reasons = Array.isArray(raw)
    ? raw.filter((r): r is string => typeof r === "string").slice(0, MAX_SUSPICION_REASONS).map((r) => r.slice(0, MAX_SUSPICION_REASON_LENGTH))
    : [];
  return { suspicionReasons: reasons, suspicious: true };
}

// Low-confidence results go to the admin Flagged page; "unknown" and suspicious
// emails stay visible in Incoming (the frontend shows a warning).
function needsReview(result: ToddlerResponse): boolean {
  if (readSuspicion(result)) return false;
  return result.classification !== "unknown" && result.confidence === "low";
}

async function writeSuccess(
  token: string,
  emailId: number,
  hints: ExtractedHints,
  result: ToddlerResponse,
  flagged: boolean,
): Promise<void> {
  // The model must not smuggle its own documentFields past the merge below.
  const {
    documentFields: _modelDocumentFields,
    suspicionReasons: _modelSuspicionReasons,
    suspicious: _modelSuspicious,
    ...modelData
  } = result.data ?? {};
  const suspicion = readSuspicion(result);
  // Nothing runs on an unknown, so drop any model-written fields.
  const data = result.classification === "unknown" ? {} : modelData;
  const connection = await createRequestConnection(token);
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
             AIFlaggedForReview = @Flagged,
             AIClaimedAt = NULL
       WHERE EmailID = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: emailId },
        { name: "Classification", type: TYPES.NVarChar, value: result.classification },
        { name: "Confidence", type: TYPES.NVarChar, value: result.confidence },
        { name: "ParsedData", type: TYPES.NVarChar, value: JSON.stringify({
            ...data,
            // Toddler sends documentFields beside data; keep it inside AIParsedData.
            ...(result.documentFields ? { documentFields: result.documentFields } : {}),
            ...(suspicion ?? {}),
          }),
        },
        { name: "RawResponse", type: TYPES.NVarChar, value: result.rawResponse ?? null },
        { name: "ModelVersion", type: TYPES.NVarChar, value: result.modelVersion },
        { name: "Error", type: TYPES.NVarChar, value: result.error?.slice(0, 500) ?? null },
        { name: "HintPO", type: TYPES.NVarChar, value: hints.poNumber },
        { name: "HintQuote", type: TYPES.NVarChar, value: hints.quoteNumber },
        { name: "Flagged", type: TYPES.Bit, value: flagged ? 1 : 0 },
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
  // so a later claim retries; record the error. The lease is kept on purpose:
  // it stops this run re-claiming the row and burning all attempts in seconds.
  // Attempt counter was incremented by claimOne already.
  const connection = await createRequestConnection(token);
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

// Permanent failure: finalise like expireExhausted does — stamp AIParsedAt,
// flag for review, clear the lease — but with the real error message.
async function recordPermanentError(token: string, emailId: number, err: Error): Promise<void> {
  const connection = await createRequestConnection(token);
  try {
    await executeQuery(
      connection,
      `UPDATE Emails
         SET AIParsedAt = SYSUTCDATETIME(),
             AIFlaggedForReview = 1,
             AIParseError = @Error,
             AIClaimedAt = NULL
       WHERE EmailID = @Id`,
      [
        { name: "Id", type: TYPES.Int, value: emailId },
        { name: "Error", type: TYPES.NVarChar, value: err.message.slice(0, 500) },
      ],
    );
  } finally {
    closeConnection(connection);
  }
}

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
    .map(({ blobName, fileName }) => ({ fileName: fileName.slice(0, FIELD_CAPS.attachmentFileName), sasUrl: generateReadSasUrl(blobName, hour) }));
}

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

  if (isSkippedSender(email.FromAddress)) {
    try {
      await writeSuccess(token, email.EmailID, hints, skipSenderResult(), false);
      return "succeeded";
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      await recordTransientError(token, email.EmailID, error).catch((e: unknown) =>
        context.error(`failed to record error for #${email.EmailID}:`, e instanceof Error ? e.message : String(e)),
      );
      context.error(`skip-sender write failed for email #${email.EmailID}:`, error.message);
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
      attachments: hydrateAttachmentRefs(email.AttachmentBlobs),
      fromAddress: cap(email.FromAddress, FIELD_CAPS.fromAddress),
      hints,
      html: email.Body ?? "",
      subject: cap(email.Subject, FIELD_CAPS.subject),
      ...(knownJob ? { knownJob } : {}),
    });
    if (result.error) {
      // Toddler returned 200 but the LLM itself errored — treat as transient
      // so the email stays in the queue and gets retried. Toddler always
      // sends data: {} on failure, so `error` is the only discriminator.
      await recordTransientError(token, email.EmailID, new Error(result.error));
      return "errored";
    }
    const suspicion = readSuspicion(result);
    if (suspicion) context.info(`email #${email.EmailID} flagged suspicious by toddler (${suspicion.suspicionReasons.length} reason(s))`);
    const review = needsReview(result);
    await writeSuccess(token, email.EmailID, hints, result, review);
    return review ? "flagged" : "succeeded";
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    const record = err instanceof ToddlerRejectedError ? recordPermanentError : recordTransientError;
    await record(token, email.EmailID, error).catch((e: unknown) =>
      context.error(`failed to record error for #${email.EmailID}:`, e instanceof Error ? e.message : String(e)),
    );
    if (err instanceof ToddlerRejectedError) context.warn(`email #${email.EmailID} rejected by toddler, finalised as flagged: ${error.message}`);
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
  if (!toddlerConfigured(context, "runParseBatch")) return totals;

  if (MIN_EMAIL_BUDGET_MS >= RUN_BUDGET_MS && !budgetWarned) {
    budgetWarned = true;
    context.warn(
      `runParseBatch: per-email budget ${MIN_EMAIL_BUDGET_MS}ms >= run budget ${RUN_BUDGET_MS}ms — the runner will never claim; lower TODDLER_TIMEOUT_MS`,
    );
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
    let email: ClaimedEmail | null;
    try {
      email = await claimOne(token);
    } catch (err: unknown) {
      context.error(
        `runParseBatch: claim failed after ${totals.claimed} email(s)`,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
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

// ── Warm parse: the one path every trigger shares ──────────────────────────
// config → token → expire exhausted rows (also on idle ticks) → cheap queue
// check (no toddler call when idle) → warm-up → deadline runner. Warm-up
// counts against `deadline`; a failed warm-up claims or writes no row. Never throws: failures go to Sentry and
// the next trigger retries.

async function parseQueued(caller: string, context: InvocationContext, deadline: number): Promise<void> {
  if (!toddlerConfigured(context, caller)) return;
  const token = process.env.MYBUILDINGS_BEARER_TOKEN;
  if (!token) {
    context.error(`${caller}: MYBUILDINGS_BEARER_TOKEN not set`);
    return;
  }

  try {
    await expireExhausted(token);
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
// the other daily timers. Also enqueues one mail sync: backstop for a lost
// Graph webhook or an expired subscription (nothing else polls the mailbox).

export async function parseEmailsDailyRetry(_timer: unknown, context: InvocationContext): Promise<void> {
  enqueueEmailSync(context, "timer");
  await parseQueued("parseEmailsDailyRetry", context, Date.now() + RUN_BUDGET_MS);
}

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
    try {
      const connection = await createServiceRequestConnection();
      try {
        const { fetched, since } = await syncMailbox(connection, mailbox);
        context.log(`processEmailSync (${source}): synced ${fetched} email(s) from ${mailbox} (since=${since ?? "beginning"})`);
      } finally {
        closeConnection(connection);
      }
    } catch (err: unknown) {
      context.error("processEmailSync: sync failed:", err instanceof Error ? err.message : String(err));
      Sentry.captureException(err, { extra: { context: "processEmailSync sync failed", source } });
      await Sentry.flush(2000);
      throw err;
    }
  }

  await parseQueued("processEmailSync", context, deadline);
}

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
  const roleCheck = await requireRole(request, [AppRole.ADMIN]);
  if (roleCheck) return roleCheck;

  // Cheap per-OID throttle so a runaway admin client (or a stuck dev page on
  // a refresh loop) can't drown the Emails table in repeated full scans.
  const oid = oidFromToken(token) ?? "unknown";
  const rl = checkRateLimit(`getFlaggedEmails:${oid}`, { limit: 30, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
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

// Every 2 minutes. Singleton, so ticks never overlap; the queue check keeps
// the GPU at zero replicas when nothing is waiting.
app.timer("parseEmailsTimer", {
  handler: parseEmailsTimer,
  schedule: "0 */2 * * * *",
});

// Daily at 02:00 UTC — coincides with other daily timers so the DB only
// wakes once for the batch.
app.timer("parseEmailsDailyRetry", {
  extraOutputs: [emailSyncQueueOutput],
  handler: parseEmailsDailyRetry,
  schedule: "0 0 2 * * *",
});

// One message at a time per instance (host.json queues.batchSize 1). Three
// attempts, then email-sync-poison; the 2-minute timer still parses whatever
// is queued.
app.storageQueue("processEmailSync", {
  connection: "AzureWebJobsStorage",
  handler: processEmailSync,
  queueName: EMAIL_SYNC_QUEUE,
});

app.http("triggerEmailParse", {
  authLevel: "anonymous",
  extraOutputs: [emailSyncQueueOutput],
  handler: adminTriggerEmailParse,
  methods: ["POST"],
});

app.http("getFlaggedEmails", {
  authLevel: "anonymous",
  handler: getFlaggedEmails,
  methods: ["GET"],
});

// Unused-import silencer: SqlRow is re-exported so tests can import it via
// this module without reaching into db.ts directly.
export type { SqlRow };
