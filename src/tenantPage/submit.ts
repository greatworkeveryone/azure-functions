// Report a problem (TR3). The client supplies words and two choices; everything about WHO is reporting
// and WHERE comes from the resolved link: tenancy, building, company, suite, contact name and phone are
// read from the database by that identity, and any tenant/building/contact id in the body is never
// looked at. The request is a native work request (workRequestsNative.ts, the same path staff
// requests take while myBuildings pushes are off) marked SourceKind='tenant_link' with the tenancy
// and contact it came from, so Incoming shows it already matched to the tenancy.

import { TYPES, type Connection } from "tedious";
import { beginTransaction, commitTransaction, executeQuery, rollbackTransaction } from "../db";
import { record } from "../ledger";
import type { TenantLinkIdentity } from "../tenantLinks/types";
import { insertNativeWorkRequest } from "../workRequestsNative";
import { CATEGORY_KEYS, categoryLabel, LIMITS, URGENCIES, URGENCY_PRIORITY, type Urgency } from "./constants";
import { referenceFor } from "./list";
import { cleanText } from "./text";
import { rulesTriage, suggestTriage } from "./triage";

export interface SubmitInput {
  accessNotes: string;
  category: string;
  description: string;
  location: string;
  /** Client-generated id of this report; a retry with the same id returns the original request. */
  requestKey: string | null;
  urgency: Urgency;
}

const REQUEST_KEY = /^[A-Za-z0-9_-]{16,40}$/;

export type ParsedSubmit = { ok: true; value: SubmitInput } | { error: string; ok: false };

/** Only these four keys are read; anything else in the body (including any id) is ignored. */
export function parseSubmit(body: Record<string, unknown>): ParsedSubmit {
  const category = typeof body.category === "string" ? body.category : "";
  if (!CATEGORY_KEYS.includes(category)) return { error: "Choose what the problem is about", ok: false };
  const urgency = typeof body.urgency === "string" ? body.urgency : "";
  if (!(URGENCIES as readonly string[]).includes(urgency)) return { error: "Choose how urgent it is", ok: false };
  const description = cleanText(body.description);
  if (description === null || description.length < LIMITS.descriptionMin) return { error: "Describe the problem in a few words", ok: false };
  if (description.length > LIMITS.descriptionMax) return { error: `Keep the description under ${LIMITS.descriptionMax} characters`, ok: false };
  const location = cleanText(body.location ?? "");
  if (location === null || location.length > LIMITS.location) return { error: `Keep the location under ${LIMITS.location} characters`, ok: false };
  const accessNotes = cleanText(body.accessNotes ?? "");
  if (accessNotes === null || accessNotes.length > LIMITS.accessNotes) return { error: `Keep the access notes under ${LIMITS.accessNotes} characters`, ok: false };
  const key = body.requestKey === undefined || body.requestKey === null ? null : body.requestKey;
  if (key !== null && (typeof key !== "string" || !REQUEST_KEY.test(key))) return { error: "That report reference is not valid", ok: false };
  return { ok: true, value: { accessNotes, category, description, location, requestKey: key, urgency: urgency as Urgency } };
}

export type SubmitResult =
  | { ok: true; reference: string; repeat: boolean; requestId: number }
  | { error: string; ok: false; status: 403 | 404 | 429 };

const WHO_SQL = `SELECT t.TenantName, t.Levels, b.BuildingName, c.Name AS ContactName, c.Phone, c.Email, c.ReportsIssues
  FROM dbo.Tenants t
  JOIN dbo.TenancyContacts c ON c.ContactId = @ContactId AND c.TenantId = t.TenantId
  LEFT JOIN dbo.Buildings b ON b.BuildingID = t.BuildingID
 WHERE t.TenantId = @TenantId AND t.BuildingID = @BuildingId`;

const SOURCE_SQL = `UPDATE dbo.WorkRequests
   SET SourceKind = N'tenant_link', SourceTenantId = @TenantId, SourceContactId = @ContactId, TenantCategory = @Category,
       TriageCategory = @TriageCategory, TriageUrgency = @TriageUrgency, TriageSource = @TriageSource, ClientRequestId = @ClientRequestId
 WHERE WorkRequestID = @Id AND SourceKind IS NULL`;

const identityParams = (id: TenantLinkIdentity) => [
  { name: "TenantId", type: TYPES.Int, value: id.tenantId },
  { name: "ContactId", type: TYPES.Int, value: id.contactId },
  { name: "BuildingId", type: TYPES.Int, value: id.buildingId },
];

function suiteText(levels: unknown): string {
  if (typeof levels !== "string") return "";
  try {
    const parsed: unknown = JSON.parse(levels);
    if (Array.isArray(parsed)) return parsed.filter((l): l is string => typeof l === "string").slice(0, 10).join(", ");
  } catch {
    // plain text
  }
  return levels.slice(0, 200);
}

export async function submitRequest(connection: Connection, identity: TenantLinkIdentity, input: SubmitInput): Promise<SubmitResult> {
  const [who] = await executeQuery(connection, WHO_SQL, identityParams(identity));
  if (!who) return { error: "link_not_valid", ok: false, status: 404 };
  if (who.ReportsIssues !== true) return { error: "This link cannot report problems", ok: false, status: 403 };

  // A retry of a report that already went through returns that report, before any cap is looked at.
  if (input.requestKey !== null) {
    const original = await findByKey(connection, identity, input.requestKey);
    if (original !== null) return { ok: true, reference: referenceFor(original), repeat: true, requestId: original };
  }

  // A cap read from the table itself, so it holds across Function App instances.
  const [recent] = await executeQuery(
    connection,
    `SELECT COUNT(*) AS N FROM dbo.WorkRequests WHERE SourceTenantId = @TenantId AND SourceKind = N'tenant_link' AND CreatedAt > DATEADD(HOUR, -24, GETUTCDATE())`,
    [{ name: "TenantId", type: TYPES.Int, value: identity.tenantId }],
  );
  const triage = rulesTriage(input.description, input);
  // The daily cap never stands between a tenant and an emergency report (what they chose, or what the
  // words say): it goes through and is flagged on the ledger for staff.
  const overCap = Number(recent?.N ?? 0) >= LIMITS.requestsPerTenancyPerDay;
  const emergency = input.urgency === "emergency" || triage.urgency === "emergency";
  if (overCap && !emergency) return { error: "rate_limited", ok: false, status: 429 };
  const details = input.accessNotes ? `${input.description}\n\nAccess: ${input.accessNotes}` : input.description;
  await beginTransaction(connection);
  let requestId: number;
  try {
    requestId = await insertNativeWorkRequest(connection, {
      BuildingID: identity.buildingId,
      BuildingName: String(who.BuildingName ?? ""),
      Category: categoryLabel(input.category),
      ContactEmail: typeof who.Email === "string" ? who.Email : undefined,
      ContactName: String(who.ContactName ?? ""),
      ContactPhone: typeof who.Phone === "string" ? who.Phone : undefined,
      Details: details,
      ExactLocation: input.location,
      LevelName: suiteText(who.Levels),
      Priority: URGENCY_PRIORITY[input.urgency],
      TenantName: String(who.TenantName ?? ""),
    });
    await executeQuery(connection, SOURCE_SQL, [
      { name: "Id", type: TYPES.Int, value: requestId },
      { name: "TenantId", type: TYPES.Int, value: identity.tenantId },
      { name: "ContactId", type: TYPES.Int, value: identity.contactId },
      { name: "Category", type: TYPES.NVarChar, value: input.category },
      { name: "TriageCategory", type: TYPES.NVarChar, value: triage.category },
      { name: "TriageUrgency", type: TYPES.NVarChar, value: triage.urgency },
      { name: "TriageSource", type: TYPES.NVarChar, value: triage.source },
      { name: "ClientRequestId", type: TYPES.NVarChar, value: input.requestKey },
    ]);
    await record(connection, {
      action: "tenancy.request_submit",
      actor: { kind: "system", name: "tenantPage" },
      after: { category: input.category, contactId: identity.contactId, reference: referenceFor(requestId), urgency: input.urgency, ...(overCap ? { overDailyCap: true } : {}) },
      buildingId: identity.buildingId,
      subject: { id: identity.tenantId, type: "tenancy" },
      tenantId: identity.tenantId,
    });
    await commitTransaction(connection);
  } catch (error) {
    await rollbackTransaction(connection).catch(() => undefined);
    // Two submits of the same report racing: the unique index lets one win; the other returns it.
    if (input.requestKey !== null && isUniqueViolation(error)) {
      const original = await findByKey(connection, identity, input.requestKey);
      if (original !== null) return { ok: true, reference: referenceFor(original), repeat: true, requestId: original };
    }
    throw error;
  }

  await upgradeTriage(connection, requestId, input);
  return { ok: true, reference: referenceFor(requestId), repeat: false, requestId };
}

const isUniqueViolation = (error: unknown): boolean => {
  const number = (error as { number?: unknown } | null)?.number;
  return number === 2601 || number === 2627 || (error instanceof Error && /duplicate key|unique/i.test(error.message));
};

async function findByKey(connection: Connection, identity: TenantLinkIdentity, key: string): Promise<number | null> {
  const [row] = await executeQuery(
    connection,
    `SELECT WorkRequestID FROM dbo.WorkRequests WHERE SourceTenantId = @TenantId AND ClientRequestId = @Key`,
    [
      { name: "TenantId", type: TYPES.Int, value: identity.tenantId },
      { name: "Key", type: TYPES.NVarChar, value: key },
    ],
  );
  return row ? Number(row.WorkRequestID) : null;
}

/** Best effort and after the commit: a failure here never touches the submitted request. */
async function upgradeTriage(connection: Connection, requestId: number, input: SubmitInput): Promise<void> {
  try {
    const suggestion = await suggestTriage(input.description, input);
    if (suggestion.source !== "ai") return;
    await executeQuery(connection, `UPDATE dbo.WorkRequests SET TriageCategory = @C, TriageUrgency = @U, TriageSource = N'ai' WHERE WorkRequestID = @Id AND SourceKind = N'tenant_link'`, [
      { name: "Id", type: TYPES.Int, value: requestId },
      { name: "C", type: TYPES.NVarChar, value: suggestion.category },
      { name: "U", type: TYPES.NVarChar, value: suggestion.urgency },
    ]);
  } catch {
    // keep the rules' suggestion
  }
}
