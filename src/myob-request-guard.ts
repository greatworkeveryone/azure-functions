// Everything myobRequest() checks before a call may leave Floorplan, in order.
// Each failure throws; myob-api-log.ts logs the refusal and, for a forbidden
// centre, raises system.health.
//   1. the allowlist (myob-endpoints.ts): Purchases only, no DELETE, no
//      Card File, Accounts, Banking, Sales or Payroll
//   2. the period (myob-period.ts) for every company-file write
//   3. MYOB_WRITES_ENABLED, Will's master switch, for every company-file write
//   4. the CFO's controls (myob-controls.ts): no controls set up for the file,
//      paused, switched off, dry run or over today's allowance → refused. The
//      OAuth token call is exempt, so a link can be made before controls exist.
//   5. an update only to a record Floorplan created: the lookup is injected by
//      the proposals pipeline (MyobProposals, sprint M3) and says no until then
// Before all of these (D9): a call about a test record is refused, reads
// included, and a company-file write must name the Floorplan record it is for
// (myob-test-records.ts). Only the OAuth token call is exempt.
// After that, myob-api-log.ts builds the caller's headers (which may refresh
// the token) and adds company-file credentials (x-myobapi-cftoken) from
// MYOB_CF_USER and MYOB_CF_PASSWORD unless the caller chose an approver's.
// The period check reads `body` as given: myobRequest passes the serialised
// bytes it is about to send.

import { assertMyobControlsAllow } from "./myob-controls";
import { MyobRequestRefusedError, MyobWritesDisabledError } from "./myob-errors";
import { classifyMyobRequest, type MyobMethod, type MyobOperation } from "./myob-endpoints";
import { checkMyobPeriod } from "./myob-period";
import { lookupMyobTestRecord, type MyobRecordRef, type MyobTestRecordLookup } from "./myob-test-records";
import { TestDataEgressError } from "./test-data";

let testRecordLookup: MyobTestRecordLookup = lookupMyobTestRecord;

/** For tests. Pass null to restore the database lookup. */
export function setMyobTestRecordLookup(lookup: MyobTestRecordLookup | null): void {
  testRecordLookup = lookup ?? lookupMyobTestRecord;
}

export interface FloorplanRecordQuery {
  companyFileId: string;
  operation: MyobOperation;
  uid: string;
}

/** True only when `uid` is a MYOB record Floorplan itself created (its UID is in MyobProposals). */
export type FloorplanRecordLookup = (query: FloorplanRecordQuery) => Promise<boolean>;

const NO_FLOORPLAN_RECORDS: FloorplanRecordLookup = async () => false;
let floorplanRecordLookup: FloorplanRecordLookup = NO_FLOORPLAN_RECORDS;

/** Installed by the proposals pipeline. Pass null to restore the default ("none"). */
export function setFloorplanRecordLookup(lookup: FloorplanRecordLookup | null): void {
  floorplanRecordLookup = lookup ?? NO_FLOORPLAN_RECORDS;
}

const CFTOKEN_HEADER = "x-myobapi-cftoken";

/** Adds x-myobapi-cftoken to a company-file call. Throws (config) when only half is set. */
export function withCompanyFileCredentials(
  headers: Record<string, string>,
  operation: GuardedRequest["operation"],
): Record<string, string> {
  if (operation === "oauth.token") return headers;
  if (Object.keys(headers).some((name) => name.toLowerCase() === CFTOKEN_HEADER)) return headers;
  const user = process.env.MYOB_CF_USER?.trim();
  const password = process.env.MYOB_CF_PASSWORD ?? "";
  if (!user && !password) return headers;
  if (!user || !password) {
    throw new MyobRequestRefusedError("config", "MYOB_CF_USER and MYOB_CF_PASSWORD must be set together");
  }
  return { ...headers, [CFTOKEN_HEADER]: Buffer.from(`${user}:${password}`, "utf8").toString("base64") };
}

export interface GuardedRequest {
  operation: MyobOperation | "oauth.token";
  companyFileId: string | null;
}

export async function guardMyobRequest(
  input: { body?: unknown; correlationId?: string; method: MyobMethod; record?: MyobRecordRef; url: string },
  now: Date = new Date(),
): Promise<GuardedRequest> {
  const classified = classifyMyobRequest(input.method, input.url);
  if (classified.kind === "refused") {
    throw new MyobRequestRefusedError("not_allowed", classified.reason, classified.forbiddenCentre);
  }
  if (classified.kind === "oauth") return { companyFileId: null, operation: "oauth.token" };

  const { companyFileId, rule, uid } = classified;
  const verdict = await testRecordLookup({ correlationId: input.correlationId ?? null, record: input.record ?? null });
  if (verdict.isTest) throw new TestDataEgressError("myob");
  if (rule.method !== "GET" && !verdict.named) {
    throw new MyobRequestRefusedError("no_record", "A MYOB write must name the Floorplan record it is for");
  }
  if (rule.dateRule) {
    const verdict = checkMyobPeriod(rule.dateRule, input.body, now);
    if (!verdict.ok) throw new MyobRequestRefusedError("outside_period", verdict.reason);
  }
  if (rule.method !== "GET" && process.env.MYOB_WRITES_ENABLED !== "true") throw new MyobWritesDisabledError();
  await assertMyobControlsAllow({ companyFileId, operation: rule.operation }, now);
  if (rule.floorplanRecordOnly) {
    // Exactly true: a lookup that answers anything else ("yes", 1, a row) is a no.
    const ours =
      uid !== null &&
      companyFileId !== null &&
      (await floorplanRecordLookup({ companyFileId, operation: rule.operation, uid })) === true;
    if (!ours) {
      throw new MyobRequestRefusedError(
        "not_floorplan_record",
        "Floorplan may amend only records it created itself; this one is not in Floorplan's MYOB proposals",
      );
    }
  }
  return { companyFileId, operation: rule.operation };
}
