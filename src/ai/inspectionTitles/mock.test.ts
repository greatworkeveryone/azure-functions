/// <reference types="jest" />
import { interpretOutput } from "../output";
import { redactText } from "../redaction";
import { getPurpose } from "../registry";
import { buildTitlesInput, TIDY_LIMITS, type TidyJob } from "./input";
import { mockJobTitles } from "./mock";
import { checkJobTitles, MAX_TITLE_CHARS } from "./validate";

// What a provider is sent: the input, with personal details already replaced by the gateway.
const sentFor = (jobs: TidyJob[]): string => redactText(buildTitlesInput(jobs)).text;
const titlesOf = (jobs: TidyJob[]): string[] => (JSON.parse(mockJobTitles(sentFor(jobs))) as { titles: string[] }).titles;
const tidy = (title: string): string => titlesOf([{ findings: [], title }])[0];

describe("the mock model", () => {
  it("drops a trailing finding count, however many", () => {
    expect(tidy("Electrical: Level 2 kitchen and corridor (3 findings)")).toBe("Electrical: Level 2 kitchen and corridor");
    expect(tidy("Level 2 kitchen (1 finding)")).toBe("Level 2 kitchen");
    expect(tidy("Level 2 kitchen (12 Findings)")).toBe("Level 2 kitchen");
  });

  it("leaves a count that is not at the end alone, and a number that is not a count", () => {
    expect(tidy("Level 2 (3 findings) kitchen")).toBe("Level 2 (3 findings) kitchen");
    expect(tidy("Replace 3 lights")).toBe("Replace 3 lights");
  });

  it("squeezes whitespace and capitalises the first letter, and changes nothing else", () => {
    expect(tidy("  fix   the\t kitchen   light ")).toBe("Fix the kitchen light");
    expect(tidy("electrical: Level 2 / Plant Room")).toBe("Electrical: Level 2 / Plant Room");
    expect(tidy("Already Fine")).toBe("Already Fine");
  });

  it("takes out markup, links and placeholders, which a title may not hold", () => {
    expect(tidy("<b>Fix</b> the door")).toBe("Fix the door");
    expect(tidy("Ring 0412 345 678 about the lift")).toBe("Ring about the lift");
    expect(tidy("Email ops@example.com about the lift")).toBe("Email about the lift");
    expect(tidy("See https://evil.example now")).not.toContain("://");
    expect(tidy("Use *bold* and `code` and {braces}")).toBe("Use bold and code and braces");
  });

  it("cuts a long title at a word, inside the limit", () => {
    const long = "Replace the corridor lights and the kitchen switch and check the emergency exit signs on every level";
    const fitted = tidy(long);
    expect(fitted.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(long.startsWith(fitted)).toBe(true);
    expect(long[fitted.length]).toBe(" ");
  });

  it("cuts a title that is one long word where it must", () => {
    expect(tidy("a".repeat(200))).toBe("A" + "a".repeat(MAX_TITLE_CHARS - 1));
  });

  it("never answers with an empty title", () => {
    expect(tidy("<<<>>>")).toBe("Inspection job");
    expect(tidy("ops@example.com")).toBe("Inspection job");
    expect(tidy("(3 findings)")).toBe("Inspection job");
  });

  it("is deterministic, and tidies a title the same way the second time", () => {
    const input = buildTitlesInput([{ findings: ["a"], title: "Fix the light (2 findings)" }]);
    expect(mockJobTitles(input)).toBe(mockJobTitles(input));
    expect(tidy(tidy("Fix the light (2 findings)"))).toBe(tidy("Fix the light (2 findings)"));
  });

  it("gives one title for each job in the order given, whatever the findings", () => {
    expect(titlesOf([
      { findings: ["a", "b", "c"], title: "second job first (3 findings)" },
      { findings: [], title: "Ground floor / Plant room" },
      { findings: ["x"], title: "Level 2 corridor (1 finding)" },
    ])).toEqual(["Second job first", "Ground floor / Plant room", "Level 2 corridor"]);
  });

  it("answers with no titles for text that is not an input, so the checks refuse it", () => {
    expect(JSON.parse(mockJobTitles("sample text"))).toEqual({ titles: [] });
  });
});

describe("the mock's answer always passes the checks, through the gateway's own parsing", () => {
  const purpose = getPurpose("inspection_job_titles")!;
  const pass = (jobs: TidyJob[]) => {
    const input = sentFor(jobs);
    const verdict = interpretOutput(purpose, mockJobTitles(input), input);
    expect({ jobs: jobs.map((job) => job.title), verdict }).toMatchObject({ verdict: { ok: true } });
    return verdict.ok ? (verdict.value as { titles: string[] }).titles : [];
  };

  it("for realistic jobs", () => {
    expect(pass([
      { findings: ["Light flickering", "Corridor lights out", "Switch loose"], title: "Electrical: Level 2 kitchen and corridor (3 findings)" },
      { findings: ["Leaking valve"], title: "Leaking valve, Ground floor Plant room" },
      { findings: [], title: "Level 1 reception (2 findings)" },
    ])).toHaveLength(3);
  });

  it("for awkward ones: no findings, a very long title, a count at the end, markup, placeholders, a long single word", () => {
    const jobs: TidyJob[] = [
      { findings: [], title: "x" },
      { findings: [], title: "word ".repeat(TIDY_LIMITS.titleChars / 5).trim() + " (40 findings)" },
      { findings: ["f".repeat(TIDY_LIMITS.findingChars)], title: "t".repeat(TIDY_LIMITS.titleChars) },
      { findings: ["<script>"], title: "<script>alert(1)</script> (2 findings)" },
      { findings: ["Contact ops@example.com"], title: "Call 0412 345 678 or ops@example.com about account 123456789012" },
      { findings: [], title: "[Walk] (Level 2) [EMAIL]" },
      { findings: [], title: "Tabs\tand\nbreaks\u2028here\u200b" },
      { findings: [], title: "(1 finding)" },
      { findings: [], title: "https://a.example/x://y" },
      { findings: [], title: "Café – lift lobby: “lights” out (L2)… 💡" },
    ];
    expect(pass(jobs)).toHaveLength(jobs.length);
  });

  it("for the most jobs allowed", () => {
    const jobs = Array.from({ length: TIDY_LIMITS.maxTitles }, (_, i) => ({ findings: ["f"], title: `Job number ${i} (${i} findings)` }));
    expect(pass(jobs)).toHaveLength(TIDY_LIMITS.maxTitles);
  });

  it("and the validator holds it to the same count", () => {
    const input = buildTitlesInput([{ findings: [], title: "One" }, { findings: [], title: "Two" }]);
    expect(checkJobTitles(JSON.parse(mockJobTitles(input)), input)).toMatchObject({ ok: true });
    expect(checkJobTitles(JSON.parse(mockJobTitles(input)), buildTitlesInput([{ findings: [], title: "One" }]))).toMatchObject({ ok: false });
  });
});
