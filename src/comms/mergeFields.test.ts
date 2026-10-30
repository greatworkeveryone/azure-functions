import { fieldsNamed, isServerField, mergeEmail, mergeText, MERGE_FIELDS, missingSentence, type MissingField } from "./mergeFields";
import { parseInline, restoreInline } from "./markdown";

const values = { "building.address": "1 Smith St, Darwin", "building.name": "Smith Tower", "tenant.name": "Acme Pty Ltd" };

describe("mergeText: fail closed", () => {
  it("fills known fields", () => {
    const missing: MissingField[] = [];
    expect(restoreInline(mergeText("Hello {{tenant.name}} at {{building.name}}", values, missing))).toBe("Hello Acme Pty Ltd at Smith Tower");
    expect(missing).toEqual([]);
  });

  it("leaves a blank field as its token and names it", () => {
    const missing: MissingField[] = [];
    expect(mergeText("Dear {{tenant.contact}},", values, missing)).toBe("Dear {{tenant.contact}},");
    expect(missing).toEqual([{ label: "Primary contact", path: "tenant.contact", reason: "blank" }]);
  });

  it("treats whitespace-only as blank and undefined as missing", () => {
    const missing: MissingField[] = [];
    mergeText("{{tenant.name}} {{building.name}}", { "tenant.name": "   " }, missing);
    expect(missing.map((field) => field.path)).toEqual(["tenant.name", "building.name"]);
  });

  it("reports a field Floorplan doesn't have as unknown, by what was written", () => {
    const missing: MissingField[] = [];
    mergeText("{{tenant.shoeSize}}", values, missing);
    expect(missing).toEqual([{ label: '"tenant.shoeSize"', path: "tenant.shoeSize", reason: "unknown" }]);
  });

  it("reports unmatched brackets", () => {
    const missing: MissingField[] = [];
    mergeText("Dear {{tenant.name", values, missing);
    expect(missing[0]).toMatchObject({ reason: "unknown" });
  });

  it("uses the greeting fallback only where the catalogue says so", () => {
    const missing: MissingField[] = [];
    expect(restoreInline(mergeText("Dear {{tenant.addressee}}", values, missing))).toBe("Dear Acme Pty Ltd");
    expect(missing).toEqual([]);
    expect(mergeText("{{tenant.contact}}", values, missing)).toBe("{{tenant.contact}}");
  });

  it("never lets a value act as markup or as a field of its own", () => {
    const merged = mergeText("Dear {{tenant.name}}", { "tenant.name": "**Evil** [x](http://e.com) {{building.name}}" }, []);
    const tokens = parseInline(merged);
    expect(tokens).toEqual([{ kind: "text", text: "Dear **Evil** [x](http://e.com) {{building.name}}" }]);
  });
});

describe("mergeEmail", () => {
  it("merges the subject and every block, and is ok when nothing is missing", () => {
    const merged = mergeEmail("Notice for {{building.name}}", "## {{building.name}}\n\nDear {{tenant.name}},\n\n- at {{building.address}}\n\n| A |\n|---|\n| {{tenant.name}} |", values);
    expect(merged.ok).toBe(true);
    expect(merged.missing).toEqual([]);
    expect(restoreInline(merged.subject)).toBe("Notice for Smith Tower");
  });

  it("is not ok, and names each missing field once in order, when something is blank", () => {
    const merged = mergeEmail("{{tenant.contact}}", "Dear {{tenant.contact}} of {{tenant.suite}}, {{tenant.contact}}", {});
    expect(merged.ok).toBe(false);
    expect(merged.missing.map((field) => field.path)).toEqual(["tenant.contact", "tenant.suite"]);
    expect(missingSentence(merged.missing)).toBe("Primary contact, Suite or level");
  });

  it("is not ok when there is no wording", () => {
    expect(mergeEmail("Subject", "   \n", values).ok).toBe(false);
  });
});

describe("the catalogue", () => {
  it("marks the sender, the date and the recipient's name as the server's", () => {
    expect(MERGE_FIELDS.filter((field) => field.server).map((field) => field.path).sort()).toEqual(["recipient.name", "request.reference", "request.summary", "sender.name", "sender.title", "today", "today.long"]);
    expect(isServerField("sender.name")).toBe(true);
    expect(isServerField("tenant.name")).toBe(false);
  });

  it("lists the fields a text names, once each", () => {
    expect(fieldsNamed("{{a.b}} x {{a.b}}", "**{{c}}** [t]({{d}})")).toEqual(["a.b", "c", "d"]);
  });
});
