import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrationFromSql, validateMigration } from "../migrate-files";
import { canMove, intakePriority, isClosed, storedState, viewState } from "./state";
import { blocksToMarkdown } from "./template";
import { dueAtFor } from "./overdue";
import { parseTargets } from "./targets";

describe("intake state", () => {
  it("reads NULL as received and a linked job as converted", () => {
    expect(storedState(null)).toBe("received");
    expect(storedState("nonsense")).toBe("received");
    expect(viewState(null, false)).toBe("received");
    expect(viewState("acknowledged", true)).toBe("converted");
  });

  it("moves Received → Acknowledged → Assessing, and closes from any open state, never back", () => {
    expect(canMove("received", "acknowledged")).toBe(true);
    expect(canMove("received", "assessing")).toBe(false);
    expect(canMove("acknowledged", "assessing")).toBe(true);
    expect(canMove("assessing", "acknowledged")).toBe(false);
    expect(canMove("assessing", "closed_duplicate")).toBe(true);
    expect(canMove("closed_not_ours", "received")).toBe(false);
    expect(isClosed("closed_duplicate")).toBe(true);
  });

  it("treats an unknown priority as Normal", () => {
    expect(intakePriority("critical")).toBe("Critical");
    expect(intakePriority("Urgent!")).toBe("Normal");
    expect(intakePriority(null)).toBe("Normal");
  });
});

describe("response targets", () => {
  it("accepts whole business hours or null per priority, and nothing else", () => {
    expect(parseTargets({ targets: { High: 4, Low: null } })).toEqual({ ok: true, value: { High: 4, Low: null } });
    for (const bad of [{ targets: {} }, { targets: { High: 0 } }, { targets: { High: 1.5 } }, { targets: { High: "4" } }, { targets: { Urgent: 4 } }, { targets: [] }, { targets: { High: 4 }, extra: 1 }]) {
      expect(parseTargets(bad as Record<string, unknown>).ok).toBe(false);
    }
  });

  it("has no clock without a target, or for a request that came before the target was set", () => {
    const created = new Date("2026-10-26T01:00:00Z");
    expect(dueAtFor(created, null, new Date("2026-10-01T00:00:00Z"))).toBeNull();
    expect(dueAtFor(created, 4, null)).toBeNull();
    expect(dueAtFor(created, 4, new Date("2026-10-27T00:00:00Z"))).toBeNull();
    expect(dueAtFor(created, 4, new Date("2026-10-01T00:00:00Z"))).toBeInstanceOf(Date);
  });
});

describe("the request_ack template", () => {
  it("turns letter blocks into the Markdown the send core renders", () => {
    const md = blocksToMarkdown([
      { id: "a", kind: "paragraph", text: "Dear {{tenant.addressee}}," },
      { id: "b", items: ["one", "two"], kind: "list", ordered: false },
      { id: "c", kind: "diagram", items: ["x"] },
    ]);
    expect(md).toBe("Dear {{tenant.addressee}},\n\n- one\n- two");
  });
});

describe("migration 182", () => {
  const sql = readFileSync(join(__dirname, "..", "..", "migrations", "182_tenant_request_intake.sql"), "utf8");
  const code = sql.replace(/--[^\n]*/g, "");

  it("passes the migration validator", () => {
    expect(validateMigration(migrationFromSql("182_tenant_request_intake.sql", sql))).toEqual([]);
  });

  it("is additive: nullable columns behind guards, no destructive statement", () => {
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE)\b/i);
    expect(code).not.toMatch(/\bUPDATE\s+dbo\./i);
    const adds = code.match(/ALTER TABLE dbo\.WorkRequests ADD \w+ [^;]*?NULL;/g) ?? [];
    expect(adds).toHaveLength(7);
    for (const add of adds) expect(add).not.toMatch(/NOT NULL/);
    expect((code.match(/COL_LENGTH/g) ?? []).length).toBe(7);
  });

  it("seeds every target unset, so no clock runs until Facilities sets one", () => {
    expect(code).toMatch(/INSERT \(Priority, AckWithinBusinessHours\) VALUES \(source\.Priority, NULL\)/);
  });
});
