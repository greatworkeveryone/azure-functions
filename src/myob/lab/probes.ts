// The lab's agreement probes (plan M5, step 10): each builds a request the
// agreement of 13 Oct 2026 forbids and asks Floorplan's own guard
// (guardMyobRequest, the first thing myobRequest does) whether it may go.
// The answer must be no. A probe never sends anything: it calls the guard, not
// the MYOB client, so even a guard that let it through would reach nothing.
//   prior_period      an order dated the day before the period starts
//   card_file         a supplier card read (Contact)
//   update_existing   a PUT to an order Floorplan didn't create
//   delete_order      a DELETE
//   chart_of_accounts an account list read (GeneralLedger)
//   file_off          a read of a company file that isn't switched on

import { myobApiBase, type MyobMethod } from "../../myob-endpoints";
import { MyobRequestRefusedError, MyobWritesDisabledError } from "../../myob-errors";
import { periodStart } from "../../myob-period";
import { guardMyobRequest } from "../../myob-request-guard";
import { installFloorplanRecordLookup } from "../floorplanRecords";

// The real "is this Floorplan's record" lookup, so update_existing meets the rule as myobRequest would.
installFloorplanRecordLookup();

/** A company file id no one can register: its mode is always off. */
export const OFF_FILE_PROBE_ID = "00000000-0000-4000-8000-000000000000";
/** An order uid Floorplan never created. */
const FOREIGN_UID = "11111111-1111-4111-8111-111111111111";

export type LabProbe = "card_file" | "chart_of_accounts" | "delete_order" | "file_off" | "prior_period" | "update_existing";

interface ProbeRequest {
  body?: string;
  method: MyobMethod;
  url: string;
}

const dayBefore = (date: string) => new Date(new Date(`${date}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);

export const LAB_PROBES: Record<LabProbe, (demo: string, now: Date) => ProbeRequest> = {
  card_file: (demo) => ({ method: "GET", url: `${myobApiBase()}/${demo}/Contact/Supplier` }),
  chart_of_accounts: (demo) => ({ method: "GET", url: `${myobApiBase()}/${demo}/GeneralLedger/Account` }),
  delete_order: (demo) => ({ method: "DELETE", url: `${myobApiBase()}/${demo}/Purchase/Order/Service/${FOREIGN_UID}` }),
  file_off: () => ({ method: "GET", url: `${myobApiBase()}/${OFF_FILE_PROBE_ID}/Purchase/Order` }),
  prior_period: (demo, now) => {
    const start = periodStart(now);
    const date = start.ok ? dayBefore(start.date) : "2000-01-01";
    return { body: JSON.stringify({ Date: `${date}T00:00:00`, Number: "LAB-PROBE" }), method: "POST", url: `${myobApiBase()}/${demo}/Purchase/Order/Service` };
  },
  update_existing: (demo, now) => ({
    body: JSON.stringify({ Date: `${new Date(now.getTime() + 9.5 * 3_600_000).toISOString().slice(0, 10)}T00:00:00`, Number: "LAB-PROBE" }),
    method: "PUT",
    url: `${myobApiBase()}/${demo}/Purchase/Order/Service/${FOREIGN_UID}`,
  }),
};

export interface ProbeResult {
  code: string | null;
  message: string;
  probe: LabProbe;
  refused: boolean;
  request: ProbeRequest;
}

export async function runLabProbe(probe: LabProbe, demo: string, now: Date): Promise<ProbeResult> {
  const request = LAB_PROBES[probe](demo, now);
  try {
    await guardMyobRequest(request, now);
    return { code: null, message: "Floorplan's guard let this through: the agreement isn't enforced here. Nothing was sent.", probe, refused: false, request };
  } catch (error) {
    if (error instanceof MyobRequestRefusedError) return { code: error.code, message: error.message, probe, refused: true, request };
    if (error instanceof MyobWritesDisabledError) return { code: "writes_disabled", message: error.message, probe, refused: true, request };
    throw error;
  }
}
