// The MYOB Activity view (SPR-M4), in the CFO's words, and the same rows as
// CSV. Proposals: what was proposed, by whom, approved by whom, sent when, and
// MYOB's answer. Calls: every MYOB call with who made it and what MYOB said,
// for registered company files or the MYOB account only (the daily email's
// callScope), with an unregistered file's id never printed (its redact).

import type { SqlRow } from "../../db";
import { darwinDateKey } from "../../escalation/businessTime";
import { callScope } from "../daily/callScope";
import { redactUnregisteredFiles } from "../daily/redact";
import { darwinStamp } from "../darwinClock";
import { toCsv } from "../mappingsAdmin/csv";

export interface ActivityView {
  columns: { key: string; label: string }[];
  rows: { id: string; values: Record<string, string> }[];
}

const s = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const stamp = (value: unknown) => (value instanceof Date ? darwinStamp(value) : "");
const json = (value: unknown): Record<string, unknown> => {
  try {
    const parsed: unknown = typeof value === "string" && value ? JSON.parse(value) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const WHAT: Record<string, string> = {
  "bills.create": "Create bill", "orders.create": "Create order", "orders.update": "Update order", "quotes.create": "Create quote", "quotes.update": "Update quote",
};

function answer(row: SqlRow): string {
  switch (row.State) {
    case "proposed":
      return "Waiting for the CFO";
    case "approved":
      return "Approved; held back by Floorplan's controls";
    case "pushed":
      return "Sent; waiting for MYOB's answer";
    case "withdrawn":
      return "Withdrawn";
    case "exception":
      return `Exception: ${s(row.MyobError) || "MYOB didn't accept it"}`;
    default: {
      const discrepancy = json(row.Discrepancy);
      if (discrepancy.missing === true) return "Missing in MYOB";
      const fields = Array.isArray(discrepancy.fields) ? (discrepancy.fields as Record<string, unknown>[]).map((field) => s(field.label)) : [];
      if (fields.length > 0) return `In MYOB · differs: ${fields.join(", ")}`;
      return row.MyobStatus === "NotFound" ? "In MYOB · not found on the last check" : "In MYOB, matches";
    }
  }
}

const PROPOSAL_COLUMNS: [string, string][] = [
  ["proposal", "Proposal"], ["record", "Record"], ["file", "Company file"], ["what", "What"], ["proposed", "Proposed by"], ["approved", "Approved by"], ["sent", "Sent"],
  ["answer", "MYOB's answer"],
];

export function proposalView(rows: SqlRow[]): ActivityView {
  return {
    columns: PROPOSAL_COLUMNS.map(([key, label]) => ({ key, label })),
    rows: rows.map((row) => {
      const rendered = json(row.Rendered);
      const record = [`${s(rendered.document) || "Record"} ${s(row.MyobNumber) || s(rendered.number)}`, s(rendered.supplier), s(rendered.amount)].filter(Boolean).join(" · ");
      return {
        id: s(row.ProposalId),
        values: {
          answer: answer(row),
          approved: row.ReviewedBy ? `${s(row.ReviewedBy)} · ${stamp(row.ReviewedAt)}` : "",
          file: s(row.FileName),
          proposal: `#${s(row.ProposalId)}`,
          proposed: `${s(row.ProposedBy)} · ${stamp(row.ProposedAt)}`,
          record,
          sent: stamp(row.PushedAt),
          what: WHAT[s(row.Operation)] ?? s(row.Operation),
        },
      };
    }),
  };
}

const CALL_COLUMNS: [string, string][] = [
  ["when", "When"], ["who", "Who"], ["request", "Request"], ["file", "Company file"], ["outcome", "MYOB's answer"], ["took", "Took"], ["proposal", "Proposal"],
];

export function callView(rows: SqlRow[], files: Map<string, string>, apiBase: string, onlyFile: string | null = null): ActivityView {
  const registered = new Set(files.keys());
  const known = [process.env.MYOB_COMPANY_FILE_ID ?? ""].map((id) => id.trim()).filter(Boolean);
  const listed: ActivityView["rows"] = [];
  for (const row of rows) {
    const scope = callScope(s(row.Method), s(row.Path), apiBase);
    if (scope.kind === "unknown" || (scope.kind === "file" && !registered.has(scope.file))) continue;
    if (onlyFile && !(scope.kind === "file" && scope.file === onlyFile)) continue;
    const error = row.Phase === "error" ? redactUnregisteredFiles(s(row.ErrorMessage) || "no reason recorded", registered, known) : null;
    listed.push({
      id: s(row.LogId),
      values: {
        file: scope.kind === "file" ? (files.get(scope.file) ?? scope.file) : "MYOB account",
        outcome: error ? `Refused or failed: ${error}` : `HTTP ${s(row.HttpStatus) || "?"}`,
        proposal: row.ProposalId ? `#${s(row.ProposalId)}` : "",
        request: `${s(row.Method)} ${s(row.Purpose)}`,
        took: row.DurationMs == null ? "" : `${s(row.DurationMs)} ms`,
        when: stamp(row.OccurredAt),
        who: s(row.ActorName),
      },
    });
  }
  return { columns: CALL_COLUMNS.map(([key, label]) => ({ key, label })), rows: listed };
}

export function activityCsv(view: ActivityView, kind: string, now = new Date()): { filename: string; text: string } {
  return {
    filename: `floorplan-myob-${kind}-${darwinDateKey(now)}.csv`,
    text: toCsv(view.columns.map((column) => column.label), view.rows.map((row) => view.columns.map((column) => row.values[column.key] ?? ""))),
  };
}
