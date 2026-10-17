/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Migration 130 is applied by hand and by the startup runner, and there is no
// SQL Server in the unit tests. Pin what can be pinned: it only adds, it can
// run twice, and the signature link stays optional so every existing checkout
// (and every client that never sends a signature) keeps working.

const sql = readFileSync(join(__dirname, "..", "..", "migrations", "130_key_checkout_signature.sql"), "utf8");
const code = sql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("migration 130: key checkout signature", () => {
  it("adds a nullable SignatureAttachmentId to the checkout batch, once", () => {
    expect(code).toMatch(/IF COL_LENGTH\('dbo\.KeyCheckoutBatches', 'SignatureAttachmentId'\) IS NULL/);
    expect(code).toMatch(/ALTER TABLE dbo\.KeyCheckoutBatches\s+ADD SignatureAttachmentId INT NULL/);
  });

  it("points it at the shared Attachments table, without a cascade that could delete the evidence", () => {
    expect(code).toMatch(/FOREIGN KEY \(SignatureAttachmentId\)\s+REFERENCES dbo\.Attachments\(Id\)/);
    expect(code).not.toMatch(/ON DELETE/i);
    expect(code).toMatch(/IF NOT EXISTS \(SELECT 1 FROM sys\.foreign_keys WHERE name = 'FK_KeyCheckoutBatches_SignatureAttachment'\)/);
  });

  it("lets one signature belong to one handover only", () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX UX_KeyCheckoutBatches_SignatureAttachmentId/);
    expect(code).toMatch(/WHERE SignatureAttachmentId IS NOT NULL/);
    expect(code).toMatch(/IF NOT EXISTS \(SELECT 1 FROM sys\.indexes WHERE name = 'UX_KeyCheckoutBatches_SignatureAttachmentId'/);
  });

  it("adds the column in a batch of its own, before anything refers to it", () => {
    const batches = code.split(/^GO\s*$/m);
    const addAt = batches.findIndex((batch) => batch.includes("ADD SignatureAttachmentId INT NULL"));
    const usedAt = batches.findIndex((batch) => batch.includes("FOREIGN KEY (SignatureAttachmentId)"));
    expect(addAt).toBeGreaterThanOrEqual(0);
    expect(usedAt).toBeGreaterThan(addAt);
  });

  it("changes no existing data and removes nothing", () => {
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE|ALTER COLUMN|sp_rename)\b/i);
  });
});
