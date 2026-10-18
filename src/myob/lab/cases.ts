// The scripted lab cases for Johanne's sessions on a demonstration company
// file (plan M5, decision 11): each says what to do and what MYOB, or
// Floorplan, should answer. She records the result of each with her note
// (results.ts). Create-only quotes and orders, Purchases only, current period;
// the agreement's refusals are demonstrated by probes (probes.ts) that ask
// Floorplan's own guard and never reach MYOB.

import type { LabProbe } from "./probes";

export type LabArea = "agreement" | "create" | "readback" | "setup";

export interface LabCase {
  area: LabArea;
  expected: string;
  id: string;
  /** A probe she can run from the lab screen; the others she does in Floorplan and MYOB. */
  probe?: LabProbe;
  steps: string[];
  title: string;
}

export const LAB_CASES: readonly LabCase[] = [
  { area: "setup", expected: "The lab shows ready: one demonstration file, not RP's (named on the card), the only one set to read and create.", id: "setup.file", steps: ["Admin → MYOB → Entities: flag the demonstration file and set it to read and create; every other file off or read only."], title: "Only the demonstration file can be written" },
  { area: "setup", expected: "Linked to the demonstration file as your restricted MYOB user; scope exactly sme-company-file sme-purchases; in MYOB the user can reach Purchases only.", id: "setup.user", steps: ["Check the link shown on this page.", "In MYOB, open the user's role and confirm Purchases only."], title: "Floorplan acts as your restricted user" },
  { area: "setup", expected: "Three contractors map to their MYOB supplier cards; the charge codes used map to accounts; the test building maps to the demonstration file.", id: "setup.mappings", steps: ["Admin → MYOB → Mappings: import or check suppliers, accounts and buildings."], title: "Mappings are confirmed" },
  { area: "create", expected: "MYOB has the order, dated today, with the amount, supplier and account shown; Floorplan says “In MYOB, matches” with a link.", id: "create.order", steps: ["On a test job's purchase order: Propose to MYOB.", "As CFO: Approve and send to MYOB.", "Open the order in MYOB from the link."], title: "Create an order" },
  { area: "create", expected: "MYOB has the quote, read back and matching.", id: "create.quote", steps: ["On an approved test quote: Propose to MYOB, then Approve and send."], title: "Create a quote" },
  { area: "create", expected: "No second order in MYOB: Floorplan finds the first by its number and links it.", id: "create.retry", steps: ["After a send whose answer was lost (the push shows as sending for 15 minutes), Approve and send again."], title: "A retried send never duplicates" },
  { area: "create", expected: "The memo and comment name the proposer and approver; MYOB's audit log names the integration user.", id: "create.attribution", steps: ["Open the created order in MYOB: read the memo and comment, then its audit history."], title: "Who did it is in MYOB" },
  { area: "create", expected: "Refused in Floorplan with “Ask Johanne to add … to the supplier export”; nothing in MYOB.", id: "create.unmapped", steps: ["Propose an order for a contractor with no supplier mapping."], title: "An unmapped contractor is refused" },
  { area: "agreement", expected: "Refused inside Floorplan: dated before the current period.", id: "refuse.prior_period", probe: "prior_period", steps: ["Run the probe."], title: "No new data in a prior period" },
  { area: "agreement", expected: "Refused inside Floorplan: the agreement keeps Floorplan out of the Card File.", id: "refuse.card_file", probe: "card_file", steps: ["Run the probe."], title: "No Card File" },
  { area: "agreement", expected: "Refused inside Floorplan: Floorplan amends only records it created.", id: "refuse.update_existing", probe: "update_existing", steps: ["Run the probe (with orders.update switched on, so the record rule is what refuses)."], title: "No change to a record Floorplan didn't create" },
  { area: "agreement", expected: "Refused inside Floorplan: Floorplan never deletes anything in MYOB.", id: "refuse.delete", probe: "delete_order", steps: ["Run the probe."], title: "No delete" },
  { area: "agreement", expected: "Refused inside Floorplan: the agreement keeps Floorplan out of Accounts.", id: "refuse.accounts", probe: "chart_of_accounts", steps: ["Run the probe."], title: "No chart of accounts" },
  { area: "agreement", expected: "Refused inside Floorplan: the company file is off.", id: "refuse.file_off", probe: "file_off", steps: ["Run the probe."], title: "No file that is switched off" },
  { area: "readback", expected: "The order shows “Differs from what Floorplan sent” with both amounts. Accept isn't offered for an amount: Floorplan says to put it right in MYOB or in Floorplan.", id: "readback.edit", steps: ["Edit the amount of the created order in MYOB.", "Admin → MYOB → Reconciliation: Check against MYOB."], title: "A hand edit in MYOB is flagged" },
  { area: "readback", expected: "Floorplan takes MYOB's record as the baseline and the ledger records your note. Update in MYOB on that order is then refused: change it in MYOB by hand.", id: "readback.accept", steps: ["Edit the memo of another created order in MYOB.", "Reconciliation: Check against MYOB, then Accept MYOB's record, with your note.", "On its purchase order: Update in MYOB."], title: "Accept MYOB's record" },
  { area: "readback", expected: "After two checks the record shows “Missing in MYOB”.", id: "readback.missing", steps: ["Delete the created order in MYOB, then check twice."], title: "A deleted record shows as missing" },
  { area: "readback", expected: "Approving a quote, completing work, approving an invoice and closing the job make no MYOB call (Activity → Calls is empty for them).", id: "readback.unbundled", steps: ["Do those four on a test job, then open Activity → Calls."], title: "Nothing else touches MYOB" },
  { area: "readback", expected: "The next morning's email lists exactly the records created in the lab.", id: "readback.email", steps: ["Read the “What Floorplan did in MYOB” email the morning after."], title: "The daily email is complete" },
];

export const labCase = (id: string) => LAB_CASES.find((c) => c.id === id) ?? null;
