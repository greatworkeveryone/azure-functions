import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseInline, parseMarkdown, splitFields } from "./markdown";

// The frontend's src/helpers/markdown.ts reads the same subset, and its test reads this same file
// (src/helpers/__fixtures__/markdown-parity.json, byte for byte). The expected values were produced by
// the frontend's parser. If this fails, the two readers have drifted: change both, then regenerate
// the file from the frontend's parser and copy it to both repos.

const fixture = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "markdown-parity.json"), "utf8")) as {
  documents: { blocks: unknown; name: string; source: string }[];
  fields: { parts: unknown; text: string }[];
  inline: { text: string; tokens: unknown }[];
};

describe("the server reads markdown as the frontend does", () => {
  it.each(fixture.documents.map((doc) => [doc.name, doc] as const))("blocks: %s", (_name, doc) => {
    expect(parseMarkdown(doc.source)).toEqual(doc.blocks);
  });

  it.each(fixture.inline.map((entry) => [entry.text, entry] as const))("inline tokens: %j", (_text, entry) => {
    expect(parseInline(entry.text)).toEqual(entry.tokens);
  });

  it.each(fixture.fields.map((entry) => [entry.text, entry] as const))("field parts: %j", (_text, entry) => {
    expect(splitFields(entry.text)).toEqual(entry.parts);
  });

  it("covers every block kind", () => {
    const kinds = new Set(fixture.documents.flatMap((doc) => (doc.blocks as { kind: string }[]).map((block) => block.kind)));
    expect([...kinds].sort()).toEqual(["heading", "list", "paragraph", "quote", "rule", "table"]);
  });
});
