// Reading AiCallLog for Admin → AI activity (SC-AI1): the filters a request may
// send, the paged query, and the shape of a row on the wire. Reads only. A row holds
// no prompt or answer text, and its input hash is never selected: the screen needs
// who, what and how big.

import { TYPES } from "tedious";
import { executeQuery, type SqlParam } from "../db";
import { darwinDayStartUtc, darwinNextDayStartUtc, parseDarwinDate, type CalendarDate } from "../ledger/darwinTime";
import { DEFAULT_PAGE_SIZE, paginationSqlSuffix, parsePagination, type PaginationParams } from "../pagination";
import { AI_OUTCOMES, type AiOutcome } from "./types";
import type { Connection } from "tedious";

const MAX_PAGE = 100_000;
const MAX_ACTOR_CHARS = 100;
const PURPOSE_ID = /^[a-z][a-z0-9_]{0,63}$/;

export interface AiCallFilters {
  actor: string | null;
  from: CalendarDate | null;
  outcome: AiOutcome | null;
  purpose: string | null;
  to: CalendarDate | null;
}

export interface AiCallDto {
  actorEmail: string | null;
  actorName: string | null;
  actorRole: string | null;
  correlationId: string | null;
  createdAt: string;
  errorCode: string | null;
  id: number;
  inputChars: number;
  latencyMs: number | null;
  model: string | null;
  outcome: string;
  outputChars: number | null;
  promptVersion: string;
  provider: string;
  purpose: string;
  recordId: string | null;
  recordType: string | null;
  redactionCount: number;
}

export type ParsedAiCallQuery = { error: string } | { filters: AiCallFilters; page: PaginationParams };

/** purpose, outcome, actor, from, to (Darwin days, YYYY-MM-DD), page, pageSize. Anything malformed is refused, not ignored. */
export function parseAiCallQuery(query: URLSearchParams): ParsedAiCallQuery {
  const purpose = query.get("purpose")?.trim() || null;
  if (purpose !== null && !PURPOSE_ID.test(purpose)) return { error: "purpose is not a purpose id" };

  const rawOutcome = query.get("outcome")?.trim() || null;
  const outcome = AI_OUTCOMES.find((candidate) => candidate === rawOutcome) ?? null;
  if (rawOutcome !== null && outcome === null) return { error: `outcome must be one of: ${AI_OUTCOMES.join(", ")}` };

  const actor = query.get("actor")?.trim() || null;
  if (actor !== null && actor.length > MAX_ACTOR_CHARS) return { error: `actor can be at most ${MAX_ACTOR_CHARS} characters` };

  const rawFrom = query.get("from")?.trim() || null;
  const rawTo = query.get("to")?.trim() || null;
  const from = rawFrom === null ? null : parseDarwinDate(rawFrom);
  const to = rawTo === null ? null : parseDarwinDate(rawTo);
  if ((rawFrom !== null && from === null) || (rawTo !== null && to === null)) return { error: "from and to must be dates (YYYY-MM-DD)" };
  if (rawFrom !== null && rawTo !== null && rawFrom > rawTo) return { error: "from can't be after to" };

  // Always paged: the screen shows a page at a time, so no page or pageSize means the first page.
  const asked = parsePagination(query);
  const page: PaginationParams = asked.active ? asked : { active: true, limit: DEFAULT_PAGE_SIZE, offset: 0, page: 1, pageSize: DEFAULT_PAGE_SIZE };
  if (page.page > MAX_PAGE) return { error: "page is too large" };
  return { filters: { actor, from, outcome, purpose, to }, page };
}

const AI_CALL_COLUMNS =
  "Id, CreatedAt, ActorEmail, ActorName, ActorRole, Purpose, PromptVersion, Provider, Model, InputChars, OutputChars, RedactionCount, LatencyMs, Outcome, ErrorCode, RecordType, RecordId, CorrelationId";

const escapeLike = (value: string): string => value.replace(/[\\%_[]/g, (character) => `\\${character}`);

function where(filters: AiCallFilters): { params: SqlParam[]; whereSql: string } {
  const predicates: string[] = [];
  const params: SqlParam[] = [];
  if (filters.purpose) {
    predicates.push("Purpose = @Purpose");
    params.push({ name: "Purpose", type: TYPES.NVarChar, value: filters.purpose });
  }
  if (filters.outcome) {
    predicates.push("Outcome = @Outcome");
    params.push({ name: "Outcome", type: TYPES.NVarChar, value: filters.outcome });
  }
  if (filters.actor) {
    predicates.push("(ActorEmail LIKE @Actor ESCAPE '\\' OR ActorName LIKE @Actor ESCAPE '\\')");
    params.push({ name: "Actor", type: TYPES.NVarChar, value: `%${escapeLike(filters.actor)}%` });
  }
  if (filters.from) {
    predicates.push("CreatedAt >= @From");
    params.push({ name: "From", type: TYPES.DateTime2, value: darwinDayStartUtc(filters.from) });
  }
  if (filters.to) {
    predicates.push("CreatedAt < @To");
    params.push({ name: "To", type: TYPES.DateTime2, value: darwinNextDayStartUtc(filters.to) });
  }
  return { params, whereSql: predicates.length ? `WHERE ${predicates.join(" AND ")}` : "" };
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const count = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export function toAiCallDto(row: Record<string, unknown>): AiCallDto {
  return {
    actorEmail: text(row.ActorEmail),
    actorName: text(row.ActorName),
    actorRole: text(row.ActorRole),
    correlationId: text(row.CorrelationId)?.toLowerCase() ?? null,
    createdAt: row.CreatedAt instanceof Date ? row.CreatedAt.toISOString() : String(row.CreatedAt),
    errorCode: text(row.ErrorCode),
    id: Number(row.Id),
    inputChars: Number(row.InputChars ?? 0),
    latencyMs: count(row.LatencyMs),
    model: text(row.Model),
    outcome: String(row.Outcome),
    outputChars: count(row.OutputChars),
    promptVersion: String(row.PromptVersion),
    provider: String(row.Provider),
    purpose: String(row.Purpose),
    recordId: text(row.RecordId),
    recordType: text(row.RecordType),
    redactionCount: Number(row.RedactionCount ?? 0),
  };
}

/** One page of calls, newest first, and how many match in all. */
export async function queryAiCalls(
  connection: Connection,
  filters: AiCallFilters,
  page: PaginationParams,
): Promise<{ items: AiCallDto[]; total: number }> {
  const { params, whereSql } = where(filters);
  const rows = await executeQuery(
    connection,
    `SELECT ${AI_CALL_COLUMNS} FROM dbo.AiCallLog ${whereSql} ORDER BY Id DESC${paginationSqlSuffix(page)}`,
    params,
  );
  const totals = await executeQuery(connection, `SELECT COUNT_BIG(*) AS Total FROM dbo.AiCallLog ${whereSql}`, params);
  return { items: rows.map(toAiCallDto), total: Number(totals[0]?.Total ?? 0) };
}
