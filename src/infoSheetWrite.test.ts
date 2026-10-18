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
  it("removes a section and keeps the others byte for byte, with the whole array before", () => {
    const edit = editInfoSheet(STORED, { kind: "deleteSection", sectionId: "a" });
    if (!edit.ok) throw new Error("expected ok");
    expect(edit.json).toBe(`[${B},${C}]`);
    expect(edit.before).toEqual(JSON.parse(STORED));
    expect(edit.sections.map((section) => section.id)).toEqual(["b", "c"]);
  });

  it("removes a row by rewriting only its section; the section keeps fields this code doesn't know", () => {
    const edit = editInfoSheet(STORED, { kind: "deleteRow", rowId: "r2", sectionId: "c" });
    if (!edit.ok) throw new Error("expected ok");
    const [first, second, third] = jsonArrayElements(edit.json)?.map((element) => element.raw) ?? [];
    expect([first, second]).toEqual([A, B]);
    expect(JSON.parse(third)).toEqual({ ...JSON.parse(C), rows: [JSON.parse(C).rows[1]] });
    expect(edit.before).toEqual(JSON.parse(STORED));
  });

  it("updates a section in place, merged over what is stored, and appends a new one, leaving the rest alone", () => {
    const updated = editInfoSheet(STORED, { kind: "upsertSection", section: { displayOrder: 1, id: "b", rows: [], title: "Café 2" } });
    if (!updated.ok) throw new Error("expected ok");
    const raws = jsonArrayElements(updated.json)?.map((element) => element.raw) ?? [];
    expect([raws[0], raws[2]]).toEqual([A, C]);
    expect(JSON.parse(raws[1]).title).toBe("Café 2");

    const added = editInfoSheet(STORED, { kind: "upsertSection", section: { displayOrder: 3, id: "d", rows: [], title: "D" } });
    if (!added.ok) throw new Error("expected ok");
    expect(added.json.startsWith(`[${A},${B},${C},`)).toBe(true);
  });

  it("puts a row into its section only, leaving the other sections as stored", () => {
    const edit = editInfoSheet(STORED, { kind: "upsertRow", row: { body: "new", displayOrder: 2, id: "r9", subheader: "V" }, sectionId: "c" });
    if (!edit.ok) throw new Error("expected ok");
    const raws = jsonArrayElements(edit.json)?.map((element) => element.raw) ?? [];
    expect([raws[0], raws[1]]).toEqual([A, B]);
    expect(JSON.parse(raws[2]).rows.map((row: { id: string }) => row.id)).toEqual(["r2", "r3", "r9"]);
  });

  it("starts an empty or missing column as an empty list for a new section", () => {
    for (const raw of [null, undefined, "", "  "]) {
      const edit = editInfoSheet(raw, { kind: "upsertSection", section: { displayOrder: 0, id: "a", rows: [], title: "A" } });
      expect(edit).toEqual(expect.objectContaining({ before: [], ok: true }));
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
      { kind: "upsertSection", section: { displayOrder: 0, id: "a", rows: [], title: "A" } },
      { kind: "upsertRow", row: { body: "b", displayOrder: 0, id: "r1", subheader: "S" }, sectionId: "a" },
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
      editInfoSheet(STORED, { kind: "upsertRow", row: { body: "b", displayOrder: 0, id: "r1", subheader: "S" }, sectionId: "zz" }),
    ).toEqual(expect.objectContaining({ ok: false, status: 404 }));
  });
});
