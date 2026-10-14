// Everything myobRequest() checks before a call may leave Floorplan, in order.
// Each failure throws; myob-api-log.ts logs the refusal and, for a forbidden
// centre, raises system.health.
//   1. the allowlist (myob-endpoints.ts): Purchases only, no DELETE, no
//      Card File, Accounts, Banking, Sales or Payroll
//   2. the period (myob-period.ts) for every company-file write
//   3. MYOB_WRITES_ENABLED, Will's master switch, for every company-file write
//   4. the boot guard (myob-controls.ts): no request reaches a company file
//      whose MyobControls rows have never been set up. The OAuth token call is
//      exempt, so a link can be made before the controls exist.
//   5. an update only to a record Floorplan created: the lookup is injected by
//      the proposals pipeline (MyobProposals, sprint M3) and says no until then
//   6. company-file credentials (x-myobapi-cftoken) from MYOB_CF_USER and
//      MYOB_CF_PASSWORD, unless the caller already chose an approver's

import { assertMyobControlsPresent } from "./myob-controls";
import { MyobRequestRefusedError, MyobWritesDisabledError } from "./myob-errors";
import { classifyMyobRequest, type MyobMethod, type MyobOperation } from "./myob-endpoints";
import { checkMyobPeriod } from "./myob-period";

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

function companyFileCredentials(headers: Record<string, string>): Record<string, string> {
  if (Object.keys(headers).some((name) => name.toLowerCase() === CFTOKEN_HEADER)) return {};
  const user = process.env.MYOB_CF_USER?.trim();
  const password = process.env.MYOB_CF_PASSWORD ?? "";
  if (!user && !password) return {};
  if (!user || !password) {
    throw new MyobRequestRefusedError("config", "MYOB_CF_USER and MYOB_CF_PASSWORD must be set together");
  }
  return { [CFTOKEN_HEADER]: Buffer.from(`${user}:${password}`, "utf8").toString("base64") };
}

export interface GuardedRequest {
  /** Headers to add to the caller's (company-file credentials). Never logged. */
  extraHeaders: Record<string, string>;
  operation: MyobOperation | "oauth.token";
  companyFileId: string | null;
}

export async function guardMyobRequest(
  input: { body?: unknown; headers: Record<string, string>; method: MyobMethod; url: string },
  now: Date = new Date(),
): Promise<GuardedRequest> {
  const classified = classifyMyobRequest(input.method, input.url);
  if (classified.kind === "refused") {
    throw new MyobRequestRefusedError("not_allowed", classified.reason, classified.forbiddenCentre);
  }
  if (classified.kind === "oauth") return { companyFileId: null, extraHeaders: {}, operation: "oauth.token" };

  const { companyFileId, rule, uid } = classified;
  if (rule.dateRule) {
    const verdict = checkMyobPeriod(rule.dateRule, input.body, now);
    if (!verdict.ok) throw new MyobRequestRefusedError("outside_period", verdict.reason);
  }
  if (rule.method !== "GET" && process.env.MYOB_WRITES_ENABLED !== "true") throw new MyobWritesDisabledError();
  await assertMyobControlsPresent(companyFileId);
  if (rule.floorplanRecordOnly) {
    const ours = Boolean(uid && companyFileId && (await floorplanRecordLookup({ companyFileId, operation: rule.operation, uid })));
    if (!ours) {
      throw new MyobRequestRefusedError(
        "not_floorplan_record",
        "Floorplan may amend only records it created itself; this one is not in Floorplan's MYOB proposals",
      );
    }
  }
  return { companyFileId, extraHeaders: companyFileCredentials(input.headers), operation: rule.operation };
}
