// The lab's agreement probes (plan M5, step 10): each builds a request the
// agreement of 13 Oct 2026 forbids and asks Floorplan's own guard
// (guardMyobRequest, the first thing myobRequest does) whether it may go.
// The answer must be no, from the rule the case checks: a refusal by another
// rule (the write switch, the CFO's controls) would hide whether that rule
// works, so it is reported as not refused (M5 review). A probe never sends
// anything: it calls the guard, not the MYOB client, so even a guard that let
// it through would reach nothing. A write probe names a synthetic order on the
// demonstration file (LAB_PROBE_RECORD), not a test record, answered here
// without a database read, so D9's "a write must name its record" rule lets
// the case's own rule answer; a probe that named nothing would read
// "refused, but not by the rule this case checks (no_record …)". Its evidence is the lab_result row she
// records; it isn't in MyobApiLog, because going through myobRequest would
// raise the agreement health alert for the Card File and Accounts probes and
// put lab refusals in the daily email.
//   prior_period      an order dated the day before the period starts  outside_period
//   card_file         a supplier card read (Contact)                   not_allowed
//   update_existing   a PUT to an order Floorplan didn't create       not_floorplan_record
//   delete_order      a DELETE                                         not_allowed
//   chart_of_accounts an account list read (GeneralLedger)             not_allowed
//   file_off          a read of a company file that isn't switched on  controls

import { myobApiBase, type MyobMethod } from "../../myob-endpoints";
import { MyobRequestRefusedError, MyobWritesDisabledError, type MyobRefusalCode } from "../../myob-errors";
import { periodStart } from "../../myob-period";
import { guardMyobRequest } from "../../myob-request-guard";
import type { MyobRecordRef, MyobTestRecordLookup } from "../../myob-test-records";
import { installFloorplanRecordLookup } from "../floorplanRecords";

// The real "is this Floorplan's record" lookup, so update_existing meets the rule as myobRequest would.
installFloorplanRecordLookup();

/** A company file id no one can register: its mode is always off. */
export const OFF_FILE_PROBE_ID = "00000000-0000-4000-8000-000000000000";
/** The synthetic order a write probe names: on the demonstration file, never a test record, never in the database. */
export const LAB_PROBE_RECORD: MyobRecordRef = Object.freeze({ id: 0, kind: "purchase_order" as const });
/** D9's question for a probe, answered without a database read: named only when it is the probe's record. */
const labProbeRecords: MyobTestRecordLookup = async ({ record }) => ({ isTest: false, named: record === LAB_PROBE_RECORD });

/** An order uid Floorplan never created. */
const FOREIGN_UID = "11111111-1111-4111-8111-111111111111";

export type LabProbe = "card_file" | "chart_of_accounts" | "delete_order" | "file_off" | "prior_period" | "update_existing";

interface ProbeRequest {
  body?: string;
  method: MyobMethod;
  url: string;
}

const dayBefore = (date: string) => new Date(new Date(`${date}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);

interface LabProbeSpec {
  build: (demo: string, now: Date) => ProbeRequest;
  /** The refusal code of the rule this probe's case checks; any other refusal isn't a pass. */
  expect: MyobRefusalCode;
}

export const LAB_PROBES: Record<LabProbe, LabProbeSpec> = {
  card_file: { build: (demo) => ({ method: "GET", url: `${myobApiBase()}/${demo}/Contact/Supplier` }), expect: "not_allowed" },
  chart_of_accounts: { build: (demo) => ({ method: "GET", url: `${myobApiBase()}/${demo}/GeneralLedger/Account` }), expect: "not_allowed" },
  delete_order: { build: (demo) => ({ method: "DELETE", url: `${myobApiBase()}/${demo}/Purchase/Order/Service/${FOREIGN_UID}` }), expect: "not_allowed" },
  file_off: { build: () => ({ method: "GET", url: `${myobApiBase()}/${OFF_FILE_PROBE_ID}/Purchase/Order` }), expect: "controls" },
  prior_period: {
    build: (demo, now) => {
      const start = periodStart(now);
      const date = start.ok ? dayBefore(start.date) : "2000-01-01";
      return { body: JSON.stringify({ Date: `${date}T00:00:00`, Number: "LAB-PROBE" }), method: "POST", url: `${myobApiBase()}/${demo}/Purchase/Order/Service` };
    },
    expect: "outside_period",
  },
  update_existing: {
    build: (demo, now) => ({
      body: JSON.stringify({ Date: `${new Date(now.getTime() + 9.5 * 3_600_000).toISOString().slice(0, 10)}T00:00:00`, Number: "LAB-PROBE" }),
      method: "PUT",
      url: `${myobApiBase()}/${demo}/Purchase/Order/Service/${FOREIGN_UID}`,
    }),
    expect: "not_floorplan_record",
  },
};

export interface ProbeResult {
  code: string | null;
  /** The refusal code the case checks for. */
  expected: MyobRefusalCode;
  message: string;
  probe: LabProbe;
  /** True only when the rule this case checks refused it. */
  refused: boolean;
  request: ProbeRequest;
}

function refusal(error: unknown): { code: string; message: string } | null {
  if (error instanceof MyobRequestRefusedError) return { code: error.code, message: error.message };
  if (error instanceof MyobWritesDisabledError) return { code: "writes_disabled", message: error.message };
  return null;
}

export async function runLabProbe(probe: LabProbe, demo: string, now: Date): Promise<ProbeResult> {
  const { build, expect: expected } = LAB_PROBES[probe];
  const request = build(demo, now);
  try {
    await guardMyobRequest({ ...request, record: LAB_PROBE_RECORD }, now, { testRecords: labProbeRecords });
    return { code: null, expected, message: "Floorplan's guard let this through: the agreement isn't enforced here. Nothing was sent.", probe, refused: false, request };
  } catch (error) {
    const refused = refusal(error);
    if (!refused) throw error;
    if (refused.code === expected) return { ...refused, expected, probe, refused: true, request };
    const message = `Refused, but not by the rule this case checks (${refused.code}: ${refused.message}). Nothing was sent.`;
    return { code: refused.code, expected, message, probe, refused: false, request };
  }
}
