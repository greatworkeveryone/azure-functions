// The one door for the anonymous tenant endpoints (TR3). Every tenant function runs inside runTenant;
// nothing here reads a Floorplan sign-in. In order, stopping at the first refusal:
//
//   1. per-client limit (keyed hash of the address, ../access/clientIp.ts) before any work
//   2. a client that has already failed to present a working link too often is turned away (429)
//      without touching the database
//   3. the link comes from the X-Tenant-Link header ONLY (never the URL, query or body); a header
//      that is not token-shaped counts as a failed attempt and answers the uniform 404
//   4. per-link limit, keyed on a hash of the token
//   5. the tenantPage flag, read before the link is resolved so an off page records no use; off,
//      unreadable or missing all answer the same 404 as a bad link
//   6. resolveTenantLink: null for every kind of unusable link (unknown, revoked, expired, archived,
//      email-only) answers one identical 404, and counts as a failed attempt
//   6b. a link whose purpose does not open this section answers 403 link_purpose
//   7. a building with no after-hours number (its own, else the company's) answers 503 page_unavailable (fail closed)
//   8. the work, which receives ONLY the resolved identity; no client value can widen it
//
// A failure in the work is a generic 500: no SQL text, no token, no identity in the reply or the log.

import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { clientAddress, hashValue } from "../access/clientIp";
import { closeConnection, createServiceRequestConnection } from "../db";
import { isFeatureEnabledForRoles } from "../features/flags";
import { resolveTenantLink } from "../tenantLinks/resolve";
import { hashToken, isTokenShaped } from "../tenantLinks/token";
import type { TenantLinkIdentity } from "../tenantLinks/types";
import { RATE, TENANT_PAGE_FLAG } from "./constants";
import { companyAfterHours } from "../orgSettings/afterHours";
import { purposeOpens, type PageSection } from "../tenantLinks/purposes";
import { checkRateLimit, isRateLimitFull } from "../rateLimit";

export const TENANT_LINK_HEADER = "x-tenant-link";

const NO_STORE = { "Cache-Control": "no-store" };

export interface TenantWork {
  connection: Connection;
  context: InvocationContext;
  identity: TenantLinkIdentity;
  request: HttpRequest;
}

export interface TenantOptions {
  /** Hits allowed per link per window, for this endpoint. */
  perLink: { limit: number; windowMs: number };
  /** Count a link use on the ledger (the page opening). Other calls only check the link. */
  recordUse: boolean;
  /** The part of the page this endpoint serves: the link's purpose must open it (tenantLinks/purposes.ts). */
  section: PageSection;
}

export const linkNotValid = (): HttpResponseInit => ({ headers: NO_STORE, jsonBody: { error: "link_not_valid" }, status: 404 });

const tooMany = (retryAfterMs: number): HttpResponseInit => ({
  headers: { ...NO_STORE, "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
  jsonBody: { error: "rate_limited" },
  status: 429,
});

export const tenantJson = (status: number, body: unknown): HttpResponseInit => ({ headers: NO_STORE, jsonBody: body, status });

/**
 * The tenantPage flag is read from its OWN audience row (RoleName "tenant"), never from the staff roles:
 * switching the page on "for admin" to look at it must not switch it on for every link holder.
 */
export const TENANT_AUDIENCE = "tenant";

export async function isTenantPageOn(connection: Connection): Promise<boolean> {
  return isFeatureEnabledForRoles(TENANT_PAGE_FLAG, [TENANT_AUDIENCE], { connection });
}

const unavailable = (): HttpResponseInit => ({ headers: NO_STORE, jsonBody: { error: "page_unavailable" }, status: 503 });

export async function runTenant(
  request: HttpRequest,
  context: InvocationContext,
  name: string,
  options: TenantOptions,
  work: (ctx: TenantWork) => Promise<HttpResponseInit>,
): Promise<HttpResponseInit> {
  const address = clientAddress(request);
  const clientKey = address ? hashValue("ip", address) : "unknown";
  const clientLimit = address ? RATE.client : RATE.unknownClient;
  const byClient = checkRateLimit(`tenant:client:${clientKey}`, clientLimit);
  if (!byClient.allowed) return tooMany(byClient.retryAfterMs);

  const failedKey = `tenant:failed:${clientKey}`;
  const alreadyFailing = isRateLimitFull(failedKey, RATE.failedLink);
  if (!alreadyFailing.allowed) return tooMany(alreadyFailing.retryAfterMs);
  const failed = (): HttpResponseInit => {
    checkRateLimit(failedKey, RATE.failedLink);
    return linkNotValid();
  };

  const token = request.headers.get(TENANT_LINK_HEADER);
  if (!isTokenShaped(token)) return failed();

  const tokenKey = hashToken(token).toString("hex").slice(0, 24);
  const byLink = checkRateLimit(`tenant:link:${name}:${tokenKey}`, options.perLink);
  if (!byLink.allowed) return tooMany(byLink.retryAfterMs);

  let connection: Connection | undefined;
  try {
    connection = await createServiceRequestConnection();
    if (!(await isTenantPageOn(connection))) return linkNotValid();
    const identity = await resolveTenantLink(token, { connection, recordUse: options.recordUse });
    if (!identity) return failed();
    // A working link only opens what its purpose is for.
    if (!purposeOpens(identity.purpose, options.section)) return tenantJson(403, { error: "link_purpose" });
    // Fail closed: no company after-hours number means no page
    // (only a real link holder sees this).
    if ((await companyAfterHours(connection)) === null) return unavailable();
    return await work({ connection, context, identity, request });
  } catch (error) {
    context.error(`${name} failed: ${error instanceof Error ? error.name : "error"}`);
    return tenantJson(500, { error: "Something went wrong" });
  } finally {
    if (connection) closeConnection(connection);
  }
}
