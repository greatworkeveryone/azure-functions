// The SQL side of the morning digest (N1): five reads, no writes. Every value is
// a parameter; the only literals in the SQL are status names and a row cap (TOP 1000)
// that keeps a surprise from reading the whole database. Queries run one after
// another because a tedious Connection cannot serve concurrent requests.
//
// Test data (D9, migration 127): every read leaves test records out, escalations
// about a test record are dropped, and the run gets the test-record keys so a
// digest that would still name one is refused at send time.

import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlRow } from "../db";
import { darwinDateKey } from "../escalation/businessTime";
import { normaliseRole } from "../escalation/roles";
import { listLiveEscalations } from "../escalation/store";
import { jobKindOf } from "../jobKinds";
import { darwinNextDayStartUtc, parseDarwinDate } from "../ledger/darwinTime";
import { loadTestSubjectKeys } from "../test-data";
import type { DigestFacts, DigestUser, DueJob, OverdueKey, WaitingApproval } from "./types";

const asDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
const asNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const asText = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

// ── Users ────────────────────────────────────────────────────────────────────

/** Everyone active who has a role, with whether they switched the digest off.
 *  NULL (never chose) counts as receiving it. */
export async function listDigestUsers(connection: Connection): Promise<DigestUser[]> {
  const rows = await executeQuery(
    connection,
    `SELECT UserID, DisplayName, Email, Role, DigestOptOut
       FROM dbo.AppUsers
      WHERE IsActive = 1 AND Role IS NOT NULL
      ORDER BY UserID`,
  );
  return rows.map((row) => ({
    email: asText(row.Email),
    name: asText(row.DisplayName) ?? asText(row.Email) ?? `User ${row.UserID}`,
    optedOut: Boolean(row.DigestOptOut),
    role: normaliseRole(row.Role),
    userId: Number(row.UserID),
  }));
}

// ── Approvals ────────────────────────────────────────────────────────────────

function toWaiting(subject: WaitingApproval["subject"], idColumn: string, row: SqlRow): WaitingApproval {
  return {
    amount: asNumber(row.Amount),
    buildingId: asNumber(row.BuildingID),
    buildingName: asText(row.BuildingName),
    createdAt: asDate(row.CreatedAt),
    id: Number(row[idColumn]),
    jobId: Number(row.JobID),
    jobKind: jobKindOf(row.Kind),
    jobTitle: asText(row.Title) ?? `Job #${row.JobID}`,
    status: String(row.Status),
    subject,
  };
}

/**
 * Quotes waiting on a first approver or a director, and incoming invoices
 * awaiting stage 1 or (once approved) a possible director. 'awaiting_approval'
 * is a junior's submission waiting for a senior, on both. A quote only counts
 * while its job is still at Awaiting Approval: approving one quote leaves the
 * job's other pending quotes behind, and those are not waiting on anyone.
 * Purchase orders have no approval status at this base, so none are read.
 */
export async function listWaitingApprovals(connection: Connection): Promise<WaitingApproval[]> {
  const quotes = await executeQuery(
    connection,
    `SELECT TOP (1000) q.QuoteID, q.JobID, q.Amount, q.Status, q.CreatedAt, j.Title, j.Kind, j.BuildingID, b.BuildingName
       FROM dbo.Quotes q
       JOIN dbo.Jobs j ON j.JobID = q.JobID
       LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
      WHERE q.Status IN ('pending', 'awaiting_approval', 'awaiting_director')
        AND j.Status = 'Awaiting Approval'
        AND j.IsArchived = 0
        AND q.IsTest = 0
        AND j.IsTest = 0
      ORDER BY q.CreatedAt, q.QuoteID`,
  );
  const invoices = await executeQuery(
    connection,
    `SELECT TOP (1000) ji.JobInvoiceID, ji.JobID, ji.Amount, ji.Status, ji.CreatedAt, j.Title, j.Kind, j.BuildingID, b.BuildingName
       FROM dbo.JobInvoices ji
       JOIN dbo.Jobs j ON j.JobID = ji.JobID
       LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
      WHERE ji.Direction = 'incoming'
        AND ji.Status IN ('pending', 'awaiting_approval', 'approved')
        AND j.IsArchived = 0
        AND j.Status <> 'Done'
        AND ji.IsTest = 0
        AND j.IsTest = 0
      ORDER BY ji.CreatedAt, ji.JobInvoiceID`,
  );
  return [...quotes.map((row) => toWaiting("quote", "QuoteID", row)), ...invoices.map((row) => toWaiting("invoice", "JobInvoiceID", row))];
}

// ── Due jobs ─────────────────────────────────────────────────────────────────

/** Live assigned jobs whose next-update date falls before tomorrow in Darwin.
 *  Jobs have no separate due date; ExpectedProgressUpdate is the date the
 *  escalation engine's job.past_due policy reads too. */
export async function listDueJobs(connection: Connection, now: Date): Promise<DueJob[]> {
  const today = parseDarwinDate(darwinDateKey(now));
  if (!today) throw new RangeError("Could not read today's Darwin date");
  const before = darwinNextDayStartUtc(today);
  const rows = await executeQuery(
    connection,
    `SELECT TOP (1000) j.JobID, j.Title, j.Kind, j.AssignedToUserID, j.ExpectedProgressUpdate, b.BuildingName
       FROM dbo.Jobs j
       LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
      WHERE j.IsArchived = 0
        AND j.Status <> 'Done'
        AND j.AssignedToUserID IS NOT NULL
        AND j.ExpectedProgressUpdate < @Before
        AND j.IsTest = 0
      ORDER BY j.ExpectedProgressUpdate, j.JobID`,
    [{ name: "Before", options: { scale: 3 }, type: TYPES.DateTime2, value: before }],
  );
  return rows.map((row) => ({
    assignedToUserId: Number(row.AssignedToUserID),
    buildingName: asText(row.BuildingName),
    expectedProgressUpdate: asDate(row.ExpectedProgressUpdate),
    jobId: Number(row.JobID),
    kind: jobKindOf(row.Kind),
    title: asText(row.Title) ?? `Job #${row.JobID}`,
  }));
}

// ── Overdue keys ─────────────────────────────────────────────────────────────

/** Keys still checked out past the batch's expected return (the same test as
 *  IsOverdue in keys.ts), one row per key. */
export async function listOverdueKeys(connection: Connection, now: Date): Promise<OverdueKey[]> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP (1000) kb.Id AS BatchId, kb.ExpectedReturnAt, k.Id AS KeyId, k.KeyNumber, b.BuildingName
       FROM dbo.KeyCheckoutBatches kb
       JOIN dbo.KeyCheckouts kco ON kco.BatchId = kb.Id AND kco.CheckedInAt IS NULL
       JOIN dbo.Keys k ON k.Id = kco.KeyId AND k.IsDeleted = 0
       LEFT JOIN dbo.Buildings b ON b.BuildingID = k.BuildingId
      WHERE kb.ExpectedReturnAt < @Now
        AND kco.IsTest = 0
        AND k.IsTest = 0
      ORDER BY kb.ExpectedReturnAt, kb.Id, k.Id`,
    [{ name: "Now", options: { scale: 3 }, type: TYPES.DateTime2, value: now }],
  );
  return rows.map((row) => ({
    batchId: Number(row.BatchId),
    buildingName: asText(row.BuildingName),
    expectedReturnAt: asDate(row.ExpectedReturnAt),
    keyId: Number(row.KeyId),
    keyNumber: String(row.KeyNumber),
  }));
}

// ── Everything ───────────────────────────────────────────────────────────────

export async function loadDigestFacts(connection: Connection, now: Date): Promise<DigestFacts> {
  const users = await listDigestUsers(connection);
  const testKeys = await loadTestSubjectKeys(connection);
  const escalations = (await listLiveEscalations(connection)).filter(
    (row) => !testKeys.has(`${row.subjectType}:${row.subjectId}`),
  );
  const waitingApprovals = await listWaitingApprovals(connection);
  const dueJobs = await listDueJobs(connection, now);
  const overdueKeys = await listOverdueKeys(connection, now);
  return { dueJobs, escalations, overdueKeys, testKeys, users, waitingApprovals };
}
