// D11: an info sheet write changes the one entry it names and keeps every other
// entry in Tenants.InfoSheetSections as stored, byte for byte (the WP26c
// appendRelief rule). A column that isn't a JSON array is never written over.
import { editInfoSheet, jsonArrayElements, type InfoSheetOp } from "./infoSheetWrite";

// Stored the way an older writer or a hand fix might have left it: odd spacing,
// a field this code doesn't know, a number written 1.50, an escaped character,
// and brackets, braces, commas and quotes inside strings.
const A = `{"id":"a","title":"Keys, [spare] {x}","rows":[{"id":"r1","subheader":"S","body":"say \\"hi\\"","displayOrder":0}],"displayOrder":0,"legacy":1.50}`;
const B = `{"id":"b","title":"Caf\\u00e9","rows":[],"displayOrder":1}`;
const C = `{"id":"c","title":"C","rows":[{"id":"r2","subheader":"T","body":"b","displayOrder":0},{"id":"r3","subheader":"U","body":"c","displayOrder":1}],"displayOrder":2,"strikethrough":true}`;
const STORED = `[ ${A} ,\n  ${B},${C} ]`;

describe("jsonArrayElements", () => {
  it("finds each top-level entry's own text, whatever is inside its strings", () => {
    expect(jsonArrayElements(STORED)?.map((element) => element.raw)).toEqual([A, B, C]);
    expect(jsonArrayElements("[]")).toEqual([]);
    expect(jsonArrayElements("  [ ]  ")).toEqual([]);
  });

  it.each(['{"id":"a"}', '"[]"', "[1,", "not json", "[1] x"])("is null for %p, which isn't a JSON array", (text) => {
    expect(jsonArrayElements(text)).toBeNull();
  });
});

describe("editInfoSheet", () => {
  it("removes a section and keeps the others byte for byte, naming the one removed and where it was (S3-6)", () => {
    const edit = editInfoSheet(STORED, { kind: "deleteSection", sectionId: "a" });
    if (!edit.ok) throw new Error("expected ok");
    expect(edit.json).toBe(`[${B},${C}]`);
    expect(edit.removed).toEqual({ position: 0, section: JSON.parse(A) });
    expect(edit.sections.map((section) => section.id)).toEqual(["b", "c"]);
  });

  it("removes a row by rewriting only its section; the section keeps fields this code doesn't know", () => {
    const edit = editInfoSheet(STORED, { kind: "deleteRow", rowId: "r2", sectionId: "c" });
    if (!edit.ok) throw new Error("expected ok");
    const [first, second, third] = jsonArrayElements(edit.json)?.map((element) => element.raw) ?? [];
    expect([first, second]).toEqual([A, B]);
    expect(JSON.parse(third)).toEqual({ ...JSON.parse(C), rows: [JSON.parse(C).rows[1]] });
    expect(edit.removed).toEqual({ position: 0, row: JSON.parse(C).rows[0], sectionId: "c", sectionTitle: "C" });
  });

  it("updates a section's own fields in place, and appends a new one, leaving the rest alone", () => {
    const updated = editInfoSheet(STORED, { isNew: false, kind: "upsertSection", section: { displayOrder: 1, id: "b", rows: [], title: "Café 2" } });
    if (!updated.ok) throw new Error("expected ok");
    const raws = jsonArrayElements(updated.json)?.map((element) => element.raw) ?? [];
    expect([raws[0], raws[2]]).toEqual([A, C]);
    expect(JSON.parse(raws[1]).title).toBe("Café 2");

    const added = editInfoSheet(STORED, { isNew: true, kind: "upsertSection", section: { displayOrder: 3, id: "d", rows: [], title: "D" } });
    if (!added.ok) throw new Error("expected ok");
    expect(added.json.startsWith(`[${A},${B},${C},`)).toBe(true);
  });

  // The D11 review's three proven losses, each from a screen that is out of date.
  it("a rename keeps the rows as stored: a stale screen's rows never replace them (a colleague's new row survives)", () => {
    const stale = { ...JSON.parse(C), rows: [JSON.parse(C).rows[0]], title: "C renamed" };
    const edit = editInfoSheet(STORED, { isNew: false, kind: "upsertSection", section: stale });
    if (!edit.ok) throw new Error("expected ok");
    const [, , third] = JSON.parse(edit.json);
    expect(third.title).toBe("C renamed");
    expect(third.rows).toEqual(JSON.parse(C).rows);
    expect(third.strikethrough).toBe(true);
  });

  it("editing a section a colleague deleted doesn't bring it back (404)", () => {
    expect(editInfoSheet(STORED, { isNew: false, kind: "upsertSection", section: { displayOrder: 9, id: "gone", rows: [], title: "Gone" } })).toEqual(
      expect.objectContaining({ ok: false, status: 404 }),
    );
  });

  it("editing a row a colleague deleted doesn't add it again (404); a new row is added only when it says so", () => {
    const row = { body: "x", displayOrder: 5, id: "r-gone", subheader: "X" };
    expect(editInfoSheet(STORED, { isNew: false, kind: "upsertRow", row, sectionId: "c" })).toEqual(expect.objectContaining({ ok: false, status: 404 }));
    expect(editInfoSheet(STORED, { isNew: true, kind: "upsertRow", row, sectionId: "c" })).toEqual(expect.objectContaining({ ok: true }));
  });

  it("refuses (409) a 'new' section or row whose id is already there", () => {
    expect(editInfoSheet(STORED, { isNew: true, kind: "upsertSection", section: { displayOrder: 0, id: "a", rows: [], title: "A" } })).toEqual(
      expect.objectContaining({ ok: false, status: 409 }),
    );
    expect(
      editInfoSheet(STORED, { isNew: true, kind: "upsertRow", row: { body: "b", displayOrder: 0, id: "r2", subheader: "S" }, sectionId: "c" }),
    ).toEqual(expect.objectContaining({ ok: false, status: 409 }));
  });

  it("puts a row into its section only, leaving the other sections as stored", () => {
    const edit = editInfoSheet(STORED, { isNew: true, kind: "upsertRow", row: { body: "new", displayOrder: 2, id: "r9", subheader: "V" }, sectionId: "c" });
    if (!edit.ok) throw new Error("expected ok");
    const raws = jsonArrayElements(edit.json)?.map((element) => element.raw) ?? [];
    expect([raws[0], raws[1]]).toEqual([A, B]);
    expect(JSON.parse(raws[2]).rows.map((row: { id: string }) => row.id)).toEqual(["r2", "r3", "r9"]);
  });

  // S2-4: Undo puts a removed entry back where it was, through the same versioned write.
  it("puts a new row back at the position it names, clamped to the section's rows", () => {
    const row = { body: "back", displayOrder: 0, id: "r-back", subheader: "Back" };
    const at = (position: number | undefined) => {
      const edit = editInfoSheet(STORED, { isNew: true, kind: "upsertRow", position, row, sectionId: "c" });
      if (!edit.ok) throw new Error("expected ok");
      return JSON.parse(edit.json)[2].rows.map((r: { id: string }) => r.id);
    };
    expect(at(0)).toEqual(["r-back", "r2", "r3"]);
    expect(at(1)).toEqual(["r2", "r-back", "r3"]);
    expect(at(2)).toEqual(["r2", "r3", "r-back"]);
    expect(at(99)).toEqual(["r2", "r3", "r-back"]);
    expect(at(undefined)).toEqual(["r2", "r3", "r-back"]);
  });

  it("puts a new section back at the position it names, every other section as stored, rows and unknown fields as sent", () => {
    const section = { displayOrder: 1, id: "back", legacy: "kept", rows: [{ body: "x", displayOrder: 0, id: "rb", subheader: "X" }], title: "Back" };
    const edit = editInfoSheet(STORED, { isNew: true, kind: "upsertSection", position: 1, section });
    if (!edit.ok) throw new Error("expected ok");
    const raws = jsonArrayElements(edit.json)?.map((element) => element.raw) ?? [];
    expect([raws[0], raws[2], raws[3]]).toEqual([A, B, C]);
    expect(JSON.parse(raws[1])).toEqual(section);
    const first = editInfoSheet(STORED, { isNew: true, kind: "upsertSection", position: 0, section });
    if (!first.ok) throw new Error("expected ok");
    expect(JSON.parse(first.json).map((entry: { id: string }) => entry.id)).toEqual(["back", "a", "b", "c"]);
  });

  // S3-2: what Undo put back is returned for the ledger: the entry as stored and the place it actually took.
  it("names what a restore put back and where, clamped to the list; an ordinary add names nothing", () => {
    const row = { body: "back", displayOrder: 0, id: "r-back", subheader: "Back" };
    const section = { displayOrder: 1, id: "back", legacy: "kept", rows: [{ body: "x", displayOrder: 0, id: "rb", subheader: "X" }], title: "Back" };
    const restoredRow = editInfoSheet(STORED, { isNew: true, kind: "upsertRow", position: 1, restore: true, row, sectionId: "c" });
    expect(restoredRow).toEqual(expect.objectContaining({ ok: true, restored: { position: 1, row, sectionId: "c", sectionTitle: "C" } }));
    const past = editInfoSheet(STORED, { isNew: true, kind: "upsertRow", position: 99, restore: true, row, sectionId: "c" });
    expect(past).toEqual(expect.objectContaining({ restored: expect.objectContaining({ position: 2 }) }));
    const restoredSection = editInfoSheet(STORED, { isNew: true, kind: "upsertSection", position: 1, restore: true, section });
    expect(restoredSection).toEqual(expect.objectContaining({ ok: true, restored: { position: 1, section } }));
    expect(editInfoSheet(STORED, { isNew: true, kind: "upsertRow", position: 1, row, sectionId: "c" })).toEqual(expect.objectContaining({ restored: null }));
    expect(editInfoSheet(STORED, { isNew: true, kind: "upsertSection", section })).toEqual(expect.objectContaining({ restored: null }));
  });

  it("ignores a position for something that isn't new", () => {
    const edit = editInfoSheet(STORED, { isNew: false, kind: "upsertRow", position: 0, row: { body: "z", displayOrder: 1, id: "r3", subheader: "U" }, sectionId: "c" });
    if (!edit.ok) throw new Error("expected ok");
    expect(JSON.parse(edit.json)[2].rows.map((r: { id: string }) => r.id)).toEqual(["r2", "r3"]);
  });

  it("starts an empty or missing column as an empty list for a new section", () => {
    for (const raw of [null, undefined, "", "  "]) {
      const edit = editInfoSheet(raw, { isNew: true, kind: "upsertSection", section: { displayOrder: 0, id: "a", rows: [], title: "A" } });
      expect(edit).toEqual(expect.objectContaining({ ok: true }));
    }
  });

  it.each([
    ["a JSON object", '{"id":"a"}'],
    ["a string", '"sections"'],
    ["broken JSON", '[{"id":"a"'],
    ["not text at all", 42],
  ])("refuses (422) %s, so nothing is written over it", (_label, raw) => {
    const ops: InfoSheetOp[] = [
      { kind: "deleteSection", sectionId: "a" },
      { kind: "deleteRow", rowId: "r1", sectionId: "a" },
      { isNew: true, kind: "upsertSection", section: { displayOrder: 0, id: "a", rows: [], title: "A" } },
      { isNew: false, kind: "upsertRow", row: { body: "b", displayOrder: 0, id: "r1", subheader: "S" }, sectionId: "a" },
    ];
    for (const op of ops) {
      expect(editInfoSheet(raw, op)).toEqual({ error: expect.stringMatching(/can't be changed safely/), ok: false, status: 422 });
    }
  });

  it("refuses (422) a row change in a section whose rows aren't a list", () => {
    const stored = `[{"id":"a","title":"A","rows":"r1","displayOrder":0}]`;
    expect(editInfoSheet(stored, { kind: "deleteRow", rowId: "r1", sectionId: "a" })).toEqual(expect.objectContaining({ ok: false, status: 422 }));
  });

  it("answers 404 for a section or row that is no longer there, rather than writing the sheet back unchanged", () => {
    expect(editInfoSheet(STORED, { kind: "deleteSection", sectionId: "zz" })).toEqual(expect.objectContaining({ ok: false, status: 404 }));
    expect(editInfoSheet(STORED, { kind: "deleteRow", rowId: "zz", sectionId: "c" })).toEqual(expect.objectContaining({ ok: false, status: 404 }));
    expect(editInfoSheet(STORED, { kind: "deleteRow", rowId: "r2", sectionId: "zz" })).toEqual(expect.objectContaining({ ok: false, status: 404 }));
    expect(editInfoSheet(null, { kind: "deleteSection", sectionId: "a" })).toEqual(expect.objectContaining({ ok: false, status: 404 }));
    expect(
      editInfoSheet(STORED, { isNew: true, kind: "upsertRow", row: { body: "b", displayOrder: 0, id: "r1", subheader: "S" }, sectionId: "zz" }),
    ).toEqual(expect.objectContaining({ ok: false, status: 404 }));
  });
});
