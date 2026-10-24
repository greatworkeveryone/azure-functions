/// <reference types="jest" />
import { buildTitlesInput, TIDY_LIMITS } from "./input";
import { parseTidyTitlesBody } from "./request";

const job = (over: Record<string, unknown> = {}) => ({ findings: ["Light flickering"], title: "Electrical: Level 2 kitchen (1 finding)", ...over });
const body = (over: Record<string, unknown> = {}) => ({ titles: [job(), job({ findings: undefined, title: "Ground floor / Plant room" })], ...over });

describe("the request tidyInspectionJobTitles accepts", () => {
  it("is a list of titles, each with the findings it came from, and nothing else is taken", () => {
    expect(parseTidyTitlesBody({ ...body(), inspectionId: 7, purpose: "echo_test" })).toEqual({
      jobs: [
        { findings: ["Light flickering"], title: "Electrical: Level 2 kitchen (1 finding)" },
        { findings: [], title: "Ground floor / Plant room" },
      ],
    });
  });

  it("trims titles and findings", () => {
    expect(parseTidyTitlesBody({ titles: [{ findings: ["  a finding  "], title: "  A title  " }] })).toEqual({ jobs: [{ findings: ["a finding"], title: "A title" }] });
  });

  it("takes findings with line breaks, which the model's input then puts on one line", () => {
    expect(parseTidyTitlesBody({ titles: [{ findings: ["Two\nlines"], title: "T" }] })).toEqual({ jobs: [{ findings: ["Two\nlines"], title: "T" }] });
  });

  it("takes the most it allows: 40 titles at 200 characters, and 8 findings of 300 on one job", () => {
    const titles = Array.from({ length: TIDY_LIMITS.maxTitles }, () => ({ title: "t".repeat(TIDY_LIMITS.titleChars) }));
    expect(parseTidyTitlesBody({ titles })).toMatchObject({ jobs: expect.any(Array) });
    const findings = Array.from({ length: TIDY_LIMITS.maxFindings }, () => "f".repeat(TIDY_LIMITS.findingChars));
    expect(parseTidyTitlesBody({ titles: [{ findings, title: "T" }] })).toMatchObject({ jobs: expect.any(Array) });
  });
});

describe("a request that is refused", () => {
  const BAD: [string, unknown][] = [
    ["a body that is not an object", "just text"],
    ["a body that is a list", [job()]],
    ["no titles", {}],
    ["titles that are not a list", { titles: "A title" }],
    ["an empty list of titles", { titles: [] }],
    ["more titles than allowed", { titles: Array.from({ length: TIDY_LIMITS.maxTitles + 1 }, () => job()) }],
    ["a job that is a string", { titles: ["A title"] }],
    ["a job with no title", { titles: [{ findings: [] }] }],
    ["a blank title", { titles: [job({ title: "   " })] }],
    ["a title that is a number", { titles: [job({ title: 7 })] }],
    ["a title that is too long", { titles: [job({ title: "t".repeat(TIDY_LIMITS.titleChars + 1) })] }],
    ["a title with a control character", { titles: [job({ title: "Lights\u0007" })] }],
    ["findings that are not a list", { titles: [job({ findings: "Light flickering" })] }],
    ["too many findings", { titles: [job({ findings: Array.from({ length: TIDY_LIMITS.maxFindings + 1 }, () => "f") })] }],
    ["a blank finding", { titles: [job({ findings: [" "] })] }],
    ["a finding that is a number", { titles: [job({ findings: [3] })] }],
    ["a finding that is too long", { titles: [job({ findings: ["f".repeat(TIDY_LIMITS.findingChars + 1)] })] }],
    ["a finding with a control character", { titles: [job({ findings: ["Tile\u0000"] })] }],
    ["more text than one call takes", { titles: Array.from({ length: TIDY_LIMITS.maxTitles }, () => job({ findings: Array.from({ length: TIDY_LIMITS.maxFindings }, () => "f".repeat(TIDY_LIMITS.findingChars)) })) }],
  ];

  it.each(BAD)("says what is wrong, in a sentence, for %s", (_label, value) => {
    const parsed = parseTidyTitlesBody(value);
    expect(parsed).toHaveProperty("error");
    expect(typeof (parsed as { error: string }).error).toBe("string");
  });

  it("names the job a mistake is in, by its position", () => {
    expect(parseTidyTitlesBody({ titles: [job(), job({ title: "" })] })).toEqual({ error: `Job 2 needs a title of up to ${TIDY_LIMITS.titleChars} characters.` });
  });

  it("refuses a request whose text is over what the purpose accepts, rather than cutting it", () => {
    const tooMuch = { titles: Array.from({ length: 20 }, () => job({ findings: Array.from({ length: 8 }, () => "f".repeat(TIDY_LIMITS.findingChars)) })) };
    expect(parseTidyTitlesBody(tooMuch)).toEqual({ error: "That is more text than can be tidied at once. Send fewer jobs, or fewer and shorter findings." });
    const fits = { titles: Array.from({ length: 10 }, () => job({ findings: Array.from({ length: 3 }, () => "f".repeat(150)) })) };
    const parsed = parseTidyTitlesBody(fits);
    expect(parsed).toHaveProperty("jobs");
    expect(buildTitlesInput((parsed as { jobs: never[] }).jobs).length).toBeLessThanOrEqual(TIDY_LIMITS.maxInputChars);
  });
});
