import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { runControllerAction } from "../myob-controller-handler";
import { importMappings } from "../myob/mappingsAdmin/importMappings";
import { parseImport } from "../myob/mappingsAdmin/input";

// POST /api/importMyobMappings — the CFO imports one CSV of MYOB mappings
// (plan M2): { kind: suppliers|accounts|buildings, csv, mode: preview|apply,
// previewHash, note }. A preview writes nothing and says what every row would
// do; an apply must match the preview's fingerprint, needs a note to change an
// existing mapping, writes only rows for registered company files, and is
// ledgered as myob.control_change. Role cfo only (the M9 controller gate).

export function importMyobMappings(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return runControllerAction(request, context, {
    failure: "Failed to import the MYOB mappings",
    forbidden: "Only the CFO can import MYOB mappings",
    moneyGate: true,
    name: "importMyobMappings",
    parse: parseImport,
    work: async (tx, actor, input) => {
      const { applied, plan } = await importMappings(tx, actor, input);
      return {
        applied,
        counts: plan.counts,
        hash: plan.hash,
        kind: plan.kind,
        rows: plan.rows.map(({ changes, line, message, outcome }) => ({ changes, line, message, outcome })),
      };
    },
  });
}

app.http("importMyobMappings", { authLevel: "anonymous", handler: importMyobMappings, methods: ["POST"] });
