// Who a tenant notice goes to (TR4, PLAN §15). Contacts come from the tenancy's own list (TR2); an archived contact
// is never used; a contact with no email can't be written to. The send core still checks every address against the
// server's records and refuses a test tenancy, and DEV_EMAIL_OVERRIDE rewrites it on staging.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { normaliseEmail } from "../tenantLinks/contacts";

export interface NoticeContact {
  authorisedForCosts: boolean;
  contactId: number;
  email: string;
  name: string;
  reportsIssues: boolean;
}

const CONTACTS_SQL = `SELECT c.ContactId, c.Name, c.Email, c.ReportsIssues, c.AuthorisedForCosts
  FROM dbo.TenancyContacts c
  JOIN dbo.Tenants t ON t.TenantId = c.TenantId
 WHERE c.TenantId = @TenantId AND c.ArchivedAt IS NULL AND t.ArchivedAt IS NULL AND NULLIF(LTRIM(RTRIM(c.Email)), N'') IS NOT NULL
 ORDER BY c.ContactId`;

const norm = normaliseEmail;

export async function loadActiveContacts(connection: Connection, tenantId: number): Promise<NoticeContact[]> {
  const rows = await executeQuery(connection, CONTACTS_SQL, [{ name: "TenantId", type: TYPES.Int, value: tenantId }]);
  return rows.map((row) => ({
    authorisedForCosts: row.AuthorisedForCosts === true,
    contactId: Number(row.ContactId),
    email: String(row.Email).trim(),
    name: String(row.Name ?? "").trim(),
    reportsIssues: row.ReportsIssues === true,
  }));
}

function distinctByEmail(contacts: readonly NoticeContact[]): NoticeContact[] {
  const seen = new Set<string>();
  return contacts.filter((contact) => !seen.has(norm(contact.email)) && seen.add(norm(contact.email)));
}

/**
 * The request's own reporting contact when the tenancy lists them (matched on email); otherwise every contact marked
 * "reports issues". Pure: `contacts` are the tenancy's active contacts with an email.
 */
export function chooseStatusContacts(contacts: readonly NoticeContact[], requestEmail: string | null): NoticeContact[] {
  const wanted = norm(requestEmail);
  if (wanted !== "") {
    const reporter = contacts.filter((contact) => norm(contact.email) === wanted);
    if (reporter.length > 0) return distinctByEmail(reporter);
  }
  return distinctByEmail(contacts.filter((contact) => contact.reportsIssues));
}

export async function resolveStatusContacts(connection: Connection, tenantId: number, requestEmail: string | null): Promise<NoticeContact[]> {
  return chooseStatusContacts(await loadActiveContacts(connection, tenantId), requestEmail);
}

/**
 * Who is asked to approve a cost a tenant would bear (a quote on a tenant-cost job): the contacts marked "authorised
 * for costs", never the person who merely reported the problem. No quote-to-tenant sending exists yet; whoever
 * builds it asks this for the recipients.
 */
export async function resolveTenantCostApprovers(connection: Connection, tenantId: number): Promise<NoticeContact[]> {
  return distinctByEmail((await loadActiveContacts(connection, tenantId)).filter((contact) => contact.authorisedForCosts));
}
