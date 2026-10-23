/// <reference types="jest" />
import { interpretOutput } from "../output";
import { getPurpose } from "../registry";
import { buildTitlesInput } from "./input";
import { checkJobTitles, MAX_TITLE_CHARS } from "./validate";

const INPUT = buildTitlesInput([
  { findings: ["Light flickering"], title: "Electrical: Level 2 kitchen (1 finding)" },
  { findings: [], title: "Ground floor / Plant room" },
]);
const check = (value: unknown, input: string | undefined = INPUT) => checkJobTitles(value, input);
const good = { titles: ["Fix the kitchen light", "Plant room"] };

describe("a reply that is accepted", () => {
  it("is one plain title for each job, in the order given", () => {
    expect(check(good)).toEqual({ ok: true, value: good });
  });

  it("is trimmed, and copies out the titles and nothing else", () => {
    expect(check({ titles: ["  Fix the kitchen light ", "Plant room\u00a0"] })).toEqual({ ok: true, value: { titles: ["Fix the kitchen light", "Plant room"] } });
  });

  it("may be exactly as long as allowed, and use accents, dashes, quotes and an ellipsis", () => {
    const longest = "a".repeat(MAX_TITLE_CHARS);
    expect(check({ titles: [longest, "Café – lift lobby: \u201clights\u201d out (L2)…"] })).toMatchObject({ ok: true });
  });

  it("is accepted through the gateway's own parsing, bare or in one code fence", () => {
    const purpose = getPurpose("inspection_job_titles")!;
    expect(interpretOutput(purpose, JSON.stringify(good), INPUT)).toEqual({ ok: true, value: good });
    expect(interpretOutput(purpose, `\`\`\`json\n${JSON.stringify(good)}\n\`\`\``, INPUT)).toEqual({ ok: true, value: good });
  });
});

describe("a reply that is refused", () => {
  it.each([
    ["fewer titles than jobs", { titles: ["Only one"] }],
    ["more titles than jobs", { titles: ["One", "Two", "Three"] }],
    ["no titles at all", { titles: [] }],
    ["no titles field", { names: ["One", "Two"] }],
    ["a field it should not have", { note: "done", titles: ["One", "Two"] }],
    ["titles that are not a list", { titles: "One, Two" }],
    ["a title that is not text", { titles: ["One", 2] }],
    ["a title that is null", { titles: ["One", null] }],
    ["a title that is an object", { titles: ["One", { text: "Two" }] }],
    ["an empty title", { titles: ["One", ""] }],
    ["a title of only spaces", { titles: ["One", "   "] }],
    ["a title over the limit", { titles: ["One", "t".repeat(MAX_TITLE_CHARS + 1)] }],
    ["a title with a line break", { titles: ["One", "Two\nand more"] }],
    ["a title with a tab", { titles: ["One", "Two\tand more"] }],
    ["a title with a control character", { titles: ["One", "Two\u0007"] }],
    ["a title with a line separator", { titles: ["One", "Two\u2028More"] }],
    ["a title with hidden characters", { titles: ["One", "Tw\u200bo"] }],
    ["a title that reorders text", { titles: ["One", "Two\u202eevil"] }],
    ["a title with a tag", { titles: ["One", "<b>Two</b>"] }],
    ["a title with a backtick", { titles: ["One", "Run `rm`"] }],
    ["a title with emphasis marks", { titles: ["One", "**Two**"] }],
    ["a title with a heading mark", { titles: ["One", "# Two"] }],
    ["a title with square brackets", { titles: ["One", "[Two]"] }],
    ["a title with braces", { titles: ["One", "{Two}"] }],
    ["a title with a link", { titles: ["One", "See https://evil.example"] }],
    ["a title with a bare scheme", { titles: ["One", "x://y"] }],
  ])("refuses %s", (_label, value) => {
    expect(check(value)).toMatchObject({ ok: false });
  });

  it.each([null, undefined, 42, true, "text", [], ["One", "Two"]])("refuses an answer that is %j and not an object", (value) => {
    expect(check(value)).toMatchObject({ ok: false });
  });

  it("refuses a title for a job that is not in the input, even when a title is right for another", () => {
    expect(check({ titles: ["One", "Two", "Three"] }, buildTitlesInput([{ findings: [], title: "A" }, { findings: [], title: "B" }]))).toMatchObject({ ok: false });
  });

  it("gives a reason in words and none of the model's text", () => {
    const refused = check({ titles: ["One", "<script>alert(1)</script>"] });
    expect(refused).toMatchObject({ ok: false });
    expect(JSON.stringify(refused)).not.toContain("script");
  });

  it("refuses text that is not JSON, prose round JSON, and JSON that is not an object, when it comes through the gateway", () => {
    const purpose = getPurpose("inspection_job_titles")!;
    for (const text of ["Here are your titles: " + JSON.stringify(good), "One\nTwo", "[\"One\",\"Two\"]", "", "{not json"]) {
      expect(interpretOutput(purpose, text, INPUT)).toMatchObject({ ok: false });
    }
  });
});

describe("a reply checked with no readable input", () => {
  it("passes only an empty list, so nothing a model said can pass outside the gateway", () => {
    expect(checkJobTitles({ titles: [] })).toEqual({ ok: true, value: { titles: [] } });
    expect(checkJobTitles(good)).toMatchObject({ ok: false });
    expect(checkJobTitles(good, "sample text")).toMatchObject({ ok: false });
  });
});
