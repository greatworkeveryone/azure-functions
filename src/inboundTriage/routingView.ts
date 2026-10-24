// Inbound email triage (EB3): what Incoming shows about who owns an email and why. Reads only.
// An email is "assigned" (it has an owner, with the reasons recorded then), "needs_triage" (the
// newest triage left it for a manager, with its top three), or "none" (triage never saw it).

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import type { Lane, Reason, Suggestion } from "./types";

export type RoutingState = "assigned" | "needs_triage" | "none";

export interface RoutingView {
  assignedAt: string | null;
  assignedBy: string | null;
  assignee: { name: string; userId: number } | null;
  emailId: number;
  linkedSendSubject: string | null;
  mailbox: string | null;
  /** Plain sentences, most telling first. */
  reasons: string[];
  /** Exchange verified the From address. False: the email may not be from who it says, and was not given out automatically. */
  senderVerified: boolean;
  state: RoutingState;
  suggestions: Suggestion[];
}

const EMAILS_SQL = `SELECT e.EmailID, e.Mailbox, e.AssignedToUserId, e.AssignedAt, e.AssignedBy, e.AssignmentReason, e.LinkedSendSubject,
    u.DisplayName AS AssigneeName, CASE WHEN e.SenderAuthenticated = 1 THEN 1 ELSE 0 END AS SenderVerified,
    (SELECT TOP (1) s.Decision FROM dbo.EmailRoutingSets s WHERE s.EmailId = e.EmailID ORDER BY s.SetId DESC) AS LatestDecision
  FROM dbo.Emails e
  LEFT JOIN dbo.AppUsers u ON u.UserID = e.AssignedToUserId
  WHERE e.EmailID IN (SELECT CAST([value] AS INT) FROM OPENJSON(@Ids))`;

// The newest set's top three for each email. Only emails with no owner are shown suggestions.
const SUGGESTIONS_SQL = `SELECT s.EmailId, i.CandidateUserId, i.[Rank], i.Score, i.ReasonsJson, u.DisplayName
  FROM dbo.EmailRoutingSets s
  JOIN dbo.EmailRoutingItems i ON i.SetId = s.SetId AND i.[Rank] <= 3
  LEFT JOIN dbo.AppUsers u ON u.UserID = i.CandidateUserId
  WHERE s.SetId IN (SELECT MAX(SetId) FROM dbo.EmailRoutingSets WHERE EmailId IN (SELECT CAST([value] AS INT) FROM OPENJSON(@Ids)) GROUP BY EmailId)
  ORDER BY s.EmailId, i.[Rank]`;

function reasonsOf(json: unknown): Reason[] {
  if (typeof json !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((item): item is Reason => typeof item?.text === "string") : [];
  } catch {
    return [];
  }
}

export async function loadRouting(connection: Connection, emailIds: readonly number[]): Promise<Map<number, RoutingView>> {
  const out = new Map<number, RoutingView>();
  if (emailIds.length === 0) return out;
  const ids = { name: "Ids", type: TYPES.NVarChar, value: JSON.stringify(emailIds) };
  const rows = await executeQuery(connection, EMAILS_SQL, [ids]);
  for (const row of rows) {
    const assigned = row.AssignedToUserId !== null && row.AssignedToUserId !== undefined;
    out.set(Number(row.EmailID), {
      assignedAt: row.AssignedAt ? new Date(row.AssignedAt as Date | string).toISOString() : null,
      assignedBy: (row.AssignedBy as string | null) ?? null,
      assignee: assigned ? { name: String(row.AssigneeName ?? "Someone"), userId: Number(row.AssignedToUserId) } : null,
      emailId: Number(row.EmailID),
      linkedSendSubject: (row.LinkedSendSubject as string | null) ?? null,
      mailbox: (row.Mailbox as string | null) ?? null,
      reasons: assigned && typeof row.AssignmentReason === "string" ? row.AssignmentReason.split("\n").filter((line: string) => line.trim() !== "") : [],
      senderVerified: Number(row.SenderVerified) === 1,
      state: assigned ? "assigned" : row.LatestDecision === "queued" ? "needs_triage" : "none",
      suggestions: [],
    });
  }
  const suggestions = await executeQuery(connection, SUGGESTIONS_SQL, [ids]);
  for (const row of suggestions) {
    const view = out.get(Number(row.EmailId));
    if (!view || view.state !== "needs_triage") continue;
    view.suggestions.push({
      name: String(row.DisplayName ?? "Someone"),
      rank: Number(row.Rank),
      reasons: reasonsOf(row.ReasonsJson),
      score: Number(row.Score),
      userId: Number(row.CandidateUserId),
    });
  }
  return out;
}

/** The lanes a manager's queue holds: their own team's work and the work either team may take. Admin, directors and the CFO see all. */
export function lanesFor(roles: readonly string[]): Lane[] {
  if (roles.some((role) => role === "admin" || role === "director" || role === "cfo")) return ["facilities", "accounts", "both"];
  const lanes = new Set<Lane>(["both"]);
  if (roles.includes("facilities_manager")) lanes.add("facilities");
  if (roles.includes("accounts_manager")) lanes.add("accounts");
  return [...lanes];
}

export interface QueueItem {
  category: string | null;
  emailId: number;
  fromAddress: string | null;
  fromName: string | null;
  intent: string;
  lane: Lane;
  mailbox: string | null;
  receivedAt: string | null;
  senderVerified: boolean;
  subject: string | null;
  suggestions: Suggestion[];
  urgency: string | null;
}

export const QUEUE_PAGE = 50;

const QUEUE_SQL = `SELECT TOP (${QUEUE_PAGE}) e.EmailID, e.Mailbox, e.FromAddress, e.FromName, e.Subject, e.ReceivedAt,
    CASE WHEN e.SenderAuthenticated = 1 THEN 1 ELSE 0 END AS SenderVerified,
    s.Intent, s.Category, s.Lane, s.Urgency
  FROM dbo.Emails e
  JOIN dbo.EmailRoutingSets s ON s.SetId = (SELECT MAX(SetId) FROM dbo.EmailRoutingSets WHERE EmailId = e.EmailID)
  WHERE e.AssignedToUserId IS NULL AND s.Decision = 'queued'
    AND e.Status IN ('unread', 'matched') AND e.ArchivedAt IS NULL
    AND (e.IsTest = 0 OR @ShowTest = 1)
    AND s.Lane IN (SELECT [value] FROM OPENJSON(@Lanes))
  ORDER BY e.ReceivedAt`;

/** Emails waiting for a manager, oldest first, with their top three suggestions. */
export async function loadQueue(connection: Connection, lanes: readonly Lane[], showTest: boolean): Promise<QueueItem[]> {
  const rows = await executeQuery(connection, QUEUE_SQL, [
    { name: "ShowTest", type: TYPES.Bit, value: showTest },
    { name: "Lanes", type: TYPES.NVarChar, value: JSON.stringify(lanes) },
  ]);
  const views = await loadRouting(connection, rows.map((row) => Number(row.EmailID)));
  return rows.map((row) => ({
    category: (row.Category as string | null) ?? null,
    emailId: Number(row.EmailID),
    fromAddress: (row.FromAddress as string | null) ?? null,
    fromName: (row.FromName as string | null) ?? null,
    intent: String(row.Intent),
    lane: row.Lane as Lane,
    mailbox: (row.Mailbox as string | null) ?? null,
    receivedAt: row.ReceivedAt ? new Date(row.ReceivedAt as Date | string).toISOString() : null,
    senderVerified: Number(row.SenderVerified) === 1,
    subject: (row.Subject as string | null) ?? null,
    suggestions: views.get(Number(row.EmailID))?.suggestions ?? [],
    urgency: (row.Urgency as string | null) ?? null,
  }));
}
