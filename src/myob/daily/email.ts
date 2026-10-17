// The daily "What Floorplan did in MYOB" email to the CFO (plan M4, decision
// 13c). Plain text, like the morning digest. A summary line, then the company
// files, then each part that has lines: the records Floorplan created in MYOB;
// every proposal state change; what Floorplan may do in MYOB (controls, a
// file's mode, the link); what changed in MYOB since (discrepancies seen or
// cleared); every MYOB call. Each line names who acted. The read-back timer's
// successful reads are counted on one line per kind; its refusals and
// failures are listed. An approval says "approved": what MYOB then did is the
// push or exception line, and a send Floorplan held back is a refused call.
//
// Only company files the CFO registered are reported: a proposal, control or
// call for any other file is dropped here, whatever the query returned. A
// call's file comes from the request classifier under the configured API base
// (callScope.ts); a call it can't place is not listed. The subject shows on a
// lock screen, so it carries the date and nothing else.

import { myobApiBase } from "../../myob-endpoints";
import { darwinDisplayDate, darwinStamp } from "../darwinClock";
import { callScope } from "./callScope";
import { controlLine } from "./controlLines";
import type { DailyFacts, MyobCall, ProposalEvent } from "./types";

export interface DailyEmailOptions {
  /** MYOB_API_BASE, for placing each call in a company file; the configured one by default. */
  apiBase?: string;
  /** APP_BASE_URL; null gives relative paths (a dry run without it set). */
  baseUrl: string | null;
  firstName: string;
  /** Most call lines shown; the rest are "and N more". */
  maxCallLines?: number;
  /** The real address when DEV_EMAIL_OVERRIDE redirected this email. */
  overriddenFrom: string | null;
}

export interface DailyEmail {
  body: string;
  counts: { calls: number; changes: number; controls: number; created: number; discrepancies: number };
  subject: string;
}

export const MAX_CALL_LINES = 100;
const link = (baseUrl: string | null, path: string) => (baseUrl === null ? path : `${baseUrl.replace(/\/+$/, "")}${path}`);
const recordName = (event: ProposalEvent) => `${event.rendered.document ?? "Record"} ${event.myobNumber ?? event.rendered.number ?? `#${event.proposalId}`}`;

const VERBS: Record<string, (event: ProposalEvent) => string> = {
  "myob.approve": () => "approved",
  "myob.exception": (event) => `exception${event.reason ? ` (${event.reason})` : ""}`,
  "myob.propose": (event) => (event.operation.endsWith(".update") ? "proposed an update" : "proposed"),
  "myob.push": () => "in MYOB, read back and matches",
  "myob.withdraw": (event) => `withdrew${event.reason ? ` (${event.reason})` : ""}`,
};

function createdLines(events: ProposalEvent[], baseUrl: string | null): string[] {
  return events.flatMap((event) => {
    const parts = [recordName(event), event.rendered.supplier, event.rendered.amount, `proposed by ${event.proposedBy}`, `approved by ${event.reviewedBy ?? event.actorName}`, event.companyFileName];
    const lines = [`- ${parts.filter(Boolean).join(" · ")}`];
    if (event.jobId) lines.push(`  ${link(baseUrl, `/jobs?jobId=${event.jobId}`)}`);
    if (event.myobUrl) lines.push(`  View in MYOB: ${event.myobUrl}`);
    return lines;
  });
}

function discrepancyLine(event: ProposalEvent): string {
  const head = `- ${darwinStamp(event.occurredAt)} · ${recordName(event)}`;
  if (event.ruleApplied === "cleared") return `${head} · matches Floorplan again`;
  if (event.ruleApplied === "missing" || event.after?.missing === true) return `${head} · missing in MYOB`;
  const fields = Array.isArray(event.after?.fields) ? (event.after.fields as Record<string, unknown>[]) : [];
  const described = fields.map((field) => `${String(field.label)}: MYOB ${String(field.myob)} · Floorplan ${String(field.floorplan)}`);
  return `${head} · ${described.join("; ") || "differs from what Floorplan sent"}`;
}

const answered = (call: MyobCall) => call.phase === "response" && call.httpStatus !== null && call.httpStatus < 400;

function callLine(call: MyobCall): string {
  const outcome = call.phase === "error" ? `refused or failed: ${call.errorMessage ?? "no reason recorded"}` : `HTTP ${call.httpStatus ?? "?"}`;
  return `- ${darwinStamp(call.occurredAt)} · ${call.actorName} · ${call.method} ${call.purpose} · ${outcome}`;
}

function callLines(calls: MyobCall[], max: number, baseUrl: string | null): string[] {
  const routine = new Map<string, number>();
  const listed: string[] = [];
  for (const call of calls) {
    if (call.actorKind === "system" && answered(call) && call.purpose.startsWith("read-back")) {
      const key = `${call.actorName} (automatic) · ${call.method} ${call.purpose}`;
      routine.set(key, (routine.get(key) ?? 0) + 1);
    } else listed.push(callLine(call));
  }
  const lines = [...[...routine].map(([key, count]) => `- ${key} · ${count} ${count === 1 ? "call" : "calls"}, all answered`), ...listed];
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `and ${lines.length - max} more calls: ${link(baseUrl, "/admin/myob")}`];
}

export function buildMyobDailyEmail(facts: DailyFacts, options: DailyEmailOptions): DailyEmail | null {
  const registered = new Set(facts.files.map((file) => file.id.toLowerCase()));
  const names = new Map(facts.files.map((file) => [file.id.toLowerCase(), file.name ?? file.id]));
  const apiBase = options.apiBase ?? myobApiBase();
  const events = facts.events.filter((event) => registered.has(event.companyFileId.toLowerCase()));
  const controls = facts.controls.filter((event) => registered.has(event.companyFileId.toLowerCase()));
  const calls = facts.calls.filter((call) => {
    const scope = callScope(call.method, call.path, apiBase);
    return scope.kind === "account" || (scope.kind === "file" && registered.has(scope.file));
  });
  if (events.length === 0 && controls.length === 0 && calls.length === 0) return null;

  const created = events.filter((event) => event.action === "myob.push" && event.operation.endsWith(".create"));
  const discrepancies = events.filter((event) => event.action === "myob.discrepancy");
  const changes = events.filter((event) => event.action !== "myob.discrepancy");
  const files = facts.files.map((file) => file.name ?? file.id).join(", ") || "none registered";

  const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const summary = [
    counted(created.length, "record created", "records created"),
    counted(changes.length, "proposal change", "proposal changes"),
    counted(controls.length, "control change", "control changes"),
    counted(discrepancies.length, "change in MYOB", "changes in MYOB"),
    counted(calls.length, "MYOB call", "MYOB calls"),
  ].join(", ");
  const lines = [
    `Good morning ${options.firstName},`,
    "",
    `What Floorplan did in MYOB from ${darwinStamp(facts.since)} to ${darwinStamp(facts.until)} (Darwin time): ${summary}.`,
    `Company files: ${files}.`,
  ];
  const section = (title: string, body: string[]) => body.length > 0 && lines.push("", title, ...body);
  section(`Records created in MYOB (${created.length})`, createdLines(created, options.baseUrl));
  section(
    `Proposals (${changes.length} ${changes.length === 1 ? "change" : "changes"})`,
    changes.map((event) => `- ${darwinStamp(event.occurredAt)} · ${event.actorName} · ${(VERBS[event.action] ?? (() => event.action))(event)} · ${recordName(event)}`),
  );
  section(
    `What Floorplan may do in MYOB (${counted(controls.length, "change", "changes")})`,
    controls.map((event) => controlLine(event, names.get(event.companyFileId.toLowerCase()) ?? event.companyFileId)),
  );
  section(`Changed in MYOB since (${discrepancies.length})`, discrepancies.map(discrepancyLine));
  section(`MYOB calls (${calls.length})`, callLines(calls, options.maxCallLines ?? MAX_CALL_LINES, options.baseUrl));
  lines.push("", `Admin → MYOB: ${link(options.baseUrl, "/admin/myob")}`);
  if (options.overriddenFrom) lines.push("", `(Redirected by DEV_EMAIL_OVERRIDE; this was meant for ${options.overriddenFrom}.)`);

  return {
    body: `${lines.join("\n")}\n`,
    counts: { calls: calls.length, changes: changes.length, controls: controls.length, created: created.length, discrepancies: discrepancies.length },
    subject: `What Floorplan did in MYOB, ${darwinDisplayDate(facts.until)}`,
  };
}
