// dbo.AiCallLog: the one place AI calls are written and counted (SC-AI1). The
// table is append-only (migration 170) and so is this module: it inserts and it
// selects, and nothing in src ever updates or deletes a row (ai-call-log-guards).
// Column names are the contract with the migration; a test keeps the two in step.

import { TYPES } from "tedious";
import { executeQuery, type SqlParam } from "../db";
import type { AiActor, AiOutcome, AiRefusalCode } from "./types";
import type { Connection } from "tedious";

export interface AiLogEntry {
  actor: AiActor;
  correlationId: string;
  errorCode: AiRefusalCode | null;
  inputChars: number;
  /** SHA-256 (hex) of the redacted input: ties a row to a document without keeping the text. */
  inputSha256: string;
  /** The redacted input as sent; only when AI_LOG_CONTENT is "true". Append-only: it can never be removed. */
  inputText: string | null;
  latencyMs: number | null;
  model: string | null;
  outcome: AiOutcome;
  outputChars: number | null;
  /** The model's text, redacted; only when AI_LOG_CONTENT is "true". */
  outputText: string | null;
  promptVersion: string;
  provider: string;
  purpose: string;
  recordId: string | null;
  recordType: string | null;
  redactionCount: number;
}

export const RATE_WINDOW_SECONDS = 60;

// Same order as the VALUES below and the columns of migration 170.
export const AI_CALL_INSERT_COLUMNS = [
  "ActorKind", "ActorUserId", "ActorEmail", "ActorName", "ActorRole", "Purpose", "PromptVersion", "Provider", "Model",
  "InputChars", "OutputChars", "RedactionCount", "LatencyMs", "Outcome", "ErrorCode", "RecordType", "RecordId",
  "CorrelationId", "InputSha256", "InputText", "OutputText",
] as const;

const INSERT_AI_CALL = `INSERT INTO dbo.AiCallLog (${AI_CALL_INSERT_COLUMNS.join(", ")})
  OUTPUT INSERTED.Id
  VALUES (${AI_CALL_INSERT_COLUMNS.map((column) => `@${column}`).join(", ")})`;

// A person is counted by their AppUsers id, else their email, else (a system actor) by name. Calls refused before
// anything was sent (switched off, too long, rate limited) don't count: the limit is on calls to the model.
const COUNT_RECENT_CALLS = `SELECT COUNT(*) AS Calls FROM dbo.AiCallLog
  WHERE CreatedAt >= DATEADD(SECOND, -${RATE_WINDOW_SECONDS}, SYSUTCDATETIME())
    AND Outcome IN (N'ok', N'failed')
    AND ((@UserId IS NOT NULL AND ActorUserId = @UserId)
      OR (@UserId IS NULL AND @Email IS NOT NULL AND ActorEmail = @Email)
      OR (@UserId IS NULL AND @Email IS NULL AND ActorKind = @Kind AND ActorName = @Name))`;

/** Widths of the text columns in migration 170: a value is cut to fit, never allowed to fail the insert. */
export const COLUMN_LIMITS = {
  ActorEmail: 320,
  ActorName: 200,
  ActorRole: 32,
  Model: 200,
  PromptVersion: 80,
  Provider: 40,
  Purpose: 64,
  RecordId: 64,
  RecordType: 40,
} as const;

const clip = (value: string | null, column: keyof typeof COLUMN_LIMITS): string | null => (value === null ? null : value.slice(0, COLUMN_LIMITS[column]));

export async function insertAiCall(connection: Connection, entry: AiLogEntry): Promise<number | null> {
  const { actor } = entry;
  const params: SqlParam[] = [
    { name: "ActorKind", type: TYPES.NVarChar, value: actor.kind },
    { name: "ActorUserId", type: TYPES.Int, value: actor.userId },
    { name: "ActorEmail", type: TYPES.NVarChar, value: clip(actor.email, "ActorEmail") },
    { name: "ActorName", type: TYPES.NVarChar, value: clip(actor.name, "ActorName") },
    { name: "ActorRole", type: TYPES.NVarChar, value: clip(actor.role, "ActorRole") },
    { name: "Purpose", type: TYPES.NVarChar, value: clip(entry.purpose, "Purpose") },
    { name: "PromptVersion", type: TYPES.NVarChar, value: clip(entry.promptVersion, "PromptVersion") },
    { name: "Provider", type: TYPES.NVarChar, value: clip(entry.provider, "Provider") },
    { name: "Model", type: TYPES.NVarChar, value: clip(entry.model, "Model") },
    { name: "InputChars", type: TYPES.Int, value: entry.inputChars },
    { name: "OutputChars", type: TYPES.Int, value: entry.outputChars },
    { name: "RedactionCount", type: TYPES.Int, value: entry.redactionCount },
    { name: "LatencyMs", type: TYPES.Int, value: entry.latencyMs },
    { name: "Outcome", type: TYPES.NVarChar, value: entry.outcome },
    { name: "ErrorCode", type: TYPES.NVarChar, value: entry.errorCode },
    { name: "RecordType", type: TYPES.NVarChar, value: clip(entry.recordType, "RecordType") },
    { name: "RecordId", type: TYPES.NVarChar, value: clip(entry.recordId, "RecordId") },
    { name: "CorrelationId", type: TYPES.UniqueIdentifier, value: entry.correlationId },
    { name: "InputSha256", type: TYPES.VarChar, value: entry.inputSha256 },
    { name: "InputText", type: TYPES.NVarChar, value: entry.inputText },
    { name: "OutputText", type: TYPES.NVarChar, value: entry.outputText },
  ];
  const rows = await executeQuery(connection, INSERT_AI_CALL, params);
  const id = rows[0]?.Id;
  return typeof id === "number" ? id : typeof id === "string" && /^\d+$/.test(id) ? Number(id) : null;
}

/** Calls this person has made to the model in the last 60 seconds. */
export async function countRecentAiCalls(connection: Connection, actor: AiActor): Promise<number> {
  const rows = await executeQuery(connection, COUNT_RECENT_CALLS, [
    { name: "UserId", type: TYPES.Int, value: actor.userId },
    { name: "Email", type: TYPES.NVarChar, value: actor.email },
    { name: "Kind", type: TYPES.NVarChar, value: actor.kind },
    { name: "Name", type: TYPES.NVarChar, value: clip(actor.name, "ActorName") },
  ]);
  return Number(rows[0]?.Calls ?? 0);
}
