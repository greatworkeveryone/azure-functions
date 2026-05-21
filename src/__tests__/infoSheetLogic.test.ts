import assert from "node:assert";
import {
  deleteInfoSheetRow,
  deleteInfoSheetSection,
  parseInfoSheetSections,
  upsertInfoSheetRow,
  upsertInfoSheetSection,
} from "../infoSheetLogic";
import type { InfoSheetRow, InfoSheetSection } from "../infoSheetLogic";

// ── fixtures ──────────────────────────────────────────────────────────────────

function row(overrides: Partial<InfoSheetRow> & { id: string }): InfoSheetRow {
  return { subheader: "Sub", body: "Body", displayOrder: 0, ...overrides };
}

function section(overrides: Partial<InfoSheetSection> & { id: string }): InfoSheetSection {
  return { title: "Title", displayOrder: 0, rows: [], ...overrides };
}

// ── parseInfoSheetSections ────────────────────────────────────────────────────

describe("parseInfoSheetSections", () => {
  it("returns [] for null", () => {
    assert.deepStrictEqual(parseInfoSheetSections(null), []);
  });

  it("returns [] for undefined", () => {
    assert.deepStrictEqual(parseInfoSheetSections(undefined), []);
  });

  it("returns [] for empty string", () => {
    assert.deepStrictEqual(parseInfoSheetSections(""), []);
  });

  it("returns [] for invalid JSON", () => {
    assert.deepStrictEqual(parseInfoSheetSections("{not json}"), []);
  });

  it("returns [] when JSON is an object, not an array", () => {
    assert.deepStrictEqual(parseInfoSheetSections('{"id":"a"}'), []);
  });

  it("parses a valid JSON array", () => {
    const s = section({ id: "a", title: "Lease Terms" });
    const result = parseInfoSheetSections(JSON.stringify([s]));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, "a");
    assert.strictEqual(result[0].title, "Lease Terms");
  });

  it("parses multiple sections preserving order", () => {
    const sections = [section({ id: "a" }), section({ id: "b" })];
    const result = parseInfoSheetSections(JSON.stringify(sections));
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].id, "a");
    assert.strictEqual(result[1].id, "b");
  });

  it("parses sections with nested rows", () => {
    const s = section({ id: "a", rows: [row({ id: "r1", subheader: "Permitted Use", body: "Office" })] });
    const result = parseInfoSheetSections(JSON.stringify([s]));
    assert.strictEqual(result[0].rows.length, 1);
    assert.strictEqual(result[0].rows[0].subheader, "Permitted Use");
  });
});

// ── upsertInfoSheetSection ────────────────────────────────────────────────────

describe("upsertInfoSheetSection", () => {
  it("appends when id is new", () => {
    const existing = [section({ id: "a" })];
    const result = upsertInfoSheetSection(existing, section({ id: "b", title: "New" }));
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[1].id, "b");
  });

  it("replaces in place when id matches", () => {
    const existing = [section({ id: "a", title: "Old" })];
    const result = upsertInfoSheetSection(existing, section({ id: "a", title: "Updated" }));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].title, "Updated");
  });

  it("preserves other sections when updating one", () => {
    const existing = [section({ id: "a" }), section({ id: "b" }), section({ id: "c" })];
    const result = upsertInfoSheetSection(existing, section({ id: "b", title: "Changed" }));
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].id, "a");
    assert.strictEqual(result[1].title, "Changed");
    assert.strictEqual(result[2].id, "c");
  });

  it("preserves existing rows when updating title", () => {
    const r = row({ id: "r1" });
    const existing = [section({ id: "a", rows: [r] })];
    const result = upsertInfoSheetSection(existing, section({ id: "a", title: "Renamed", rows: [r] }));
    assert.strictEqual(result[0].rows.length, 1);
  });

  it("sets strikethrough when toggling", () => {
    const existing = [section({ id: "a" })];
    const result = upsertInfoSheetSection(existing, section({ id: "a", strikethrough: true }));
    assert.strictEqual(result[0].strikethrough, true);
  });

  it("does not mutate the input array", () => {
    const existing = [section({ id: "a" })];
    upsertInfoSheetSection(existing, section({ id: "b" }));
    assert.strictEqual(existing.length, 1);
  });
});

// ── deleteInfoSheetSection ────────────────────────────────────────────────────

describe("deleteInfoSheetSection", () => {
  it("removes a section by id", () => {
    const existing = [section({ id: "a" }), section({ id: "b" })];
    const result = deleteInfoSheetSection(existing, "a");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, "b");
  });

  it("returns [] when the only section is deleted", () => {
    const result = deleteInfoSheetSection([section({ id: "a" })], "a");
    assert.deepStrictEqual(result, []);
  });

  it("leaves array unchanged when id is not found", () => {
    const existing = [section({ id: "a" })];
    const result = deleteInfoSheetSection(existing, "missing");
    assert.strictEqual(result.length, 1);
  });

  it("does not mutate the input array", () => {
    const existing = [section({ id: "a" }), section({ id: "b" })];
    deleteInfoSheetSection(existing, "a");
    assert.strictEqual(existing.length, 2);
  });
});

// ── upsertInfoSheetRow ────────────────────────────────────────────────────────

describe("upsertInfoSheetRow", () => {
  it("appends a new row to the correct section", () => {
    const existing = [section({ id: "sec-a" }), section({ id: "sec-b" })];
    const result = upsertInfoSheetRow(existing, "sec-a", row({ id: "r1" }));
    assert.strictEqual(result[0].rows.length, 1);
    assert.strictEqual(result[1].rows.length, 0);
  });

  it("replaces an existing row in place", () => {
    const r = row({ id: "r1", subheader: "Old" });
    const existing = [section({ id: "sec-a", rows: [r] })];
    const result = upsertInfoSheetRow(existing, "sec-a", row({ id: "r1", subheader: "New" }));
    assert.strictEqual(result[0].rows.length, 1);
    assert.strictEqual(result[0].rows[0].subheader, "New");
  });

  it("preserves row order when inserting at the end", () => {
    const existing = [
      section({ id: "sec-a", rows: [row({ id: "r1" }), row({ id: "r2" })] }),
    ];
    const result = upsertInfoSheetRow(existing, "sec-a", row({ id: "r3" }));
    assert.deepStrictEqual(result[0].rows.map((r) => r.id), ["r1", "r2", "r3"]);
  });

  it("leaves other sections untouched", () => {
    const existing = [section({ id: "sec-a" }), section({ id: "sec-b", rows: [row({ id: "r99" })] })];
    const result = upsertInfoSheetRow(existing, "sec-a", row({ id: "r1" }));
    assert.strictEqual(result[1].rows[0].id, "r99");
  });

  it("is a no-op when sectionId is not found", () => {
    const existing = [section({ id: "sec-a" })];
    const result = upsertInfoSheetRow(existing, "missing", row({ id: "r1" }));
    assert.strictEqual(result[0].rows.length, 0);
  });

  it("does not mutate the input array or rows", () => {
    const existing = [section({ id: "sec-a", rows: [row({ id: "r1" })] })];
    upsertInfoSheetRow(existing, "sec-a", row({ id: "r2" }));
    assert.strictEqual(existing[0].rows.length, 1);
  });
});

// ── deleteInfoSheetRow ────────────────────────────────────────────────────────

describe("deleteInfoSheetRow", () => {
  it("removes a row by id from the correct section", () => {
    const existing = [section({ id: "sec-a", rows: [row({ id: "r1" }), row({ id: "r2" })] })];
    const result = deleteInfoSheetRow(existing, "sec-a", "r1");
    assert.strictEqual(result[0].rows.length, 1);
    assert.strictEqual(result[0].rows[0].id, "r2");
  });

  it("returns empty rows array when the only row is deleted", () => {
    const existing = [section({ id: "sec-a", rows: [row({ id: "r1" })] })];
    const result = deleteInfoSheetRow(existing, "sec-a", "r1");
    assert.deepStrictEqual(result[0].rows, []);
  });

  it("leaves other sections untouched", () => {
    const existing = [
      section({ id: "sec-a", rows: [row({ id: "r1" })] }),
      section({ id: "sec-b", rows: [row({ id: "r2" })] }),
    ];
    const result = deleteInfoSheetRow(existing, "sec-a", "r1");
    assert.strictEqual(result[1].rows[0].id, "r2");
  });

  it("is a no-op when rowId is not found in the section", () => {
    const existing = [section({ id: "sec-a", rows: [row({ id: "r1" })] })];
    const result = deleteInfoSheetRow(existing, "sec-a", "missing");
    assert.strictEqual(result[0].rows.length, 1);
  });

  it("is a no-op when sectionId is not found", () => {
    const existing = [section({ id: "sec-a", rows: [row({ id: "r1" })] })];
    const result = deleteInfoSheetRow(existing, "missing", "r1");
    assert.strictEqual(result[0].rows.length, 1);
  });

  it("does not mutate the input array", () => {
    const existing = [section({ id: "sec-a", rows: [row({ id: "r1" })] })];
    deleteInfoSheetRow(existing, "sec-a", "r1");
    assert.strictEqual(existing[0].rows.length, 1);
  });
});
