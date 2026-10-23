/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "../ai/redaction";

// docs/runbooks/switches.md says exactly what the AI gateway's redaction removes, and what it
// does not (review L1). Each example the runbook gives is run here, so the words cannot say more
// than the rules do: a claim that stops being true fails this test.

const doc = readFileSync(join(__dirname, "..", "..", "docs", "runbooks", "switches.md"), "utf8");
const section = doc.slice(doc.indexOf("## AI gateway: what redaction removes"), doc.indexOf("## Migrations"));

const REMOVED = [
  "jo@example.com",
  "0412 345 678",
  "+61 412 345 678",
  "(08) 8941 2345",
  "+61 8 8941 2345",
  "1300 123 456",
  "Ph: 8981 1234",
  "P: 8981 1234",
  "062-000 1234 5678",
  "062 000 1234 5678",
  "EFT: 062000 12345678",
  "BSB 062-000",
  "Account 12345678",
  "TFN 123 456 782",
  "4111 1111 1111 1111",
];
const KEPT = ["ABN 51 824 753 556", "INV-2026-0042", "$1,233.10", "22/11/2026"];
const NOT_REMOVED = ["12345678", "0889412345", "24 Gunbar St", "Jo Bloggs"];

describe("switches.md on redaction", () => {
  it("has a section that says what is removed, what is kept and what is not removed", () => {
    expect(section.length).toBeGreaterThan(500);
    expect(section).toMatch(/^## AI gateway: what redaction removes/);
    expect(section).toMatch(/Kept on purpose/);
    expect(section).toMatch(/Not removed/);
  });

  it("says plainly that names and street addresses are not removed", () => {
    expect(section).toMatch(/names of people and companies/i);
    expect(section).toMatch(/street and postal addresses/i);
    expect(section).toMatch(/[Nn]ot removed/);
  });

  it("does not claim to remove BSB and account numbers, or bank details, without saying which forms", () => {
    expect(doc).not.toMatch(/Redaction replaces emails, Australian phone numbers, BSB and account numbers, TFNs and card numbers before any call/);
    expect(doc).not.toMatch(/replaces[^.]{0,80}bank details/i);
  });

  it.each(REMOVED)("gives %j as an example, and redaction really removes it", (example) => {
    expect(section).toContain(`\`${example}\``);
    expect(redactText(example).count).toBeGreaterThan(0);
  });

  it.each(KEPT)("gives %j as something kept, and redaction really keeps it", (example) => {
    expect(section).toContain(example);
    expect(redactText(`Supplier ${example}`).text).toBe(`Supplier ${example}`);
  });

  it.each(NOT_REMOVED)("gives %j as something not removed, and it really is not", (example) => {
    expect(section).toContain(`\`${example}\``);
    expect(redactText(`See ${example} for details`).text).toBe(`See ${example} for details`);
  });

  it("tells whoever switches AI on to turn the model server's own request logging off", () => {
    expect(section).toMatch(/request logging/);
    expect(section).toMatch(/vLLM|Ollama/);
  });
});
