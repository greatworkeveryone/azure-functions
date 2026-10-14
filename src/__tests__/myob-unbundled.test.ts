/// <reference types="jest" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Decision 12: a MYOB write is its own explicit action, never bundled.
// Approving a quote, marking work complete, approving an invoice, closing a
// job or an escalation never touches MYOB. So only the dedicated proposal
// endpoints may reach the proposal pipeline or the purchases client, and no
// code anywhere issues a DELETE to MYOB.

const SRC = join(__dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : walk(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

const files = walk(SRC).map((file) => ({ name: relative(SRC, file).split("\\").join("/"), text: readFileSync(file, "utf8") }));
const PIPELINE = /from\s+["'](\.\.?\/)+(myob\/(propose|send|sendSteps|withdraw|draft)|myob-purchase-order)["']/;

const MAY_REACH_PIPELINE = new Set([
  "functions/approveAndSendToMyob.ts",
  "functions/previewMyobProposal.ts",
  "functions/proposeToMyob.ts",
  "functions/withdrawMyobProposal.ts",
  "myob/draft.ts",
  "myob/proposalHttp.ts",
  "myob/propose.ts",
  "myob/send.ts",
  "myob/sendSteps.ts",
  "myob/withdraw.ts",
]);

describe("MYOB writes are never bundled into another action (decision 12)", () => {
  it("lets only the dedicated proposal endpoints reach the pipeline and the purchases client", () => {
    const reaching = files.filter((file) => PIPELINE.test(file.text)).map((file) => file.name);
    expect(reaching.filter((name) => !MAY_REACH_PIPELINE.has(name))).toEqual([]);
  });

  it.each([
    "functions/quotes.ts",
    "functions/invoices.ts",
    "functions/purchaseOrders.ts",
    "functions/jobs.ts",
    "jobStatusMachine.ts",
    "escalation/engine.ts",
    "escalation/sweep.ts",
  ])("%s doesn't import the pipeline or the purchases client", (name) => {
    const file = files.find((f) => f.name === name);
    expect(file).toBeDefined();
    expect(file!.text).not.toMatch(PIPELINE);
    expect(file!.text).not.toMatch(/from\s+["'](\.\.?\/)+myob\//);
  });
});

describe("no DELETE reaches MYOB from anywhere", () => {
  it("no source file asks myobRequest for a DELETE", () => {
    expect(files.filter((file) => /method:\s*["']DELETE["']/.test(file.text)).map((file) => file.name)).toEqual([]);
  });
});
