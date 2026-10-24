/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

// docs/runbooks/switches.md says what every COMMS_* setting does (EB1). A setting added to
// src/comms/config.ts or read by the send timer without a row fails here, so Will is never left to
// find it in the code.

const ROOT = join(__dirname, "..", "..");
const doc = readFileSync(join(ROOT, "docs", "runbooks", "switches.md"), "utf8");
const readers = ["src/comms/config.ts", "src/functions/commsSendTimer.ts", "src/comms/worker.ts"].map((file) => readFileSync(join(ROOT, file), "utf8")).join("\n");

const settingsRead = [...new Set([...readers.matchAll(/\b(COMMS_[A-Z_]+)\b/g)].map((found) => found[1]))].sort();
const rows = doc.split("\n").filter((line) => /^\|\s*`COMMS_/.test(line));

describe("switches.md rows for the send core", () => {
  it("finds the settings the send core reads", () => {
    expect(settingsRead).toEqual(
      expect.arrayContaining(["COMMS_APPROVAL_THRESHOLD", "COMMS_FOOTER_ADDRESS", "COMMS_FROM_ADDRESS", "COMMS_FROM_NAME", "COMMS_MAX_PER_MINUTE", "COMMS_SEND_DRY_RUN", "COMMS_SEND_ENABLED"]),
    );
  });

  it.each(settingsRead)("has a row for %s", (name) => {
    // "COMMS_SEND_ENABLED · _DRY_RUN" shares one row, as the other paired switches do.
    const row = rows.find((line) => line.includes(`\`${name}\``) || (name.endsWith("_DRY_RUN") && line.includes(`\`${name.replace("_DRY_RUN", "_ENABLED")}\` · \`_DRY_RUN\``)));
    expect(row).toBeDefined();
    expect((row ?? "").length).toBeGreaterThan(60);
  });

  it("says the dry run wins, the queue never sends twice and a test record never leaves", () => {
    const row = rows.find((line) => line.includes("`COMMS_SEND_ENABLED`")) ?? "";
    expect(row).toMatch(/wins over ENABLED/);
    expect(row).toMatch(/send_unconfirmed/);
    expect(row).toMatch(/test record never leaves/);
    expect(row).toMatch(/DEV_EMAIL_OVERRIDE/);
  });

  it("lists Will's infrastructure steps with the flag", () => {
    expect(doc).toMatch(/notices@randazzo\.properties`\s*\(no licence\)/);
    expect(doc).toMatch(/floorplan-graph-readers@/);
    expect(doc).toMatch(/DKIM and DMARC/);
  });
});
