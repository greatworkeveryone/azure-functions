/// <reference types="jest" />
import { ASK_LIMITS } from "./input";
import { parseAskLibraryBody } from "./request";

const passage = (over: Record<string, unknown> = {}) => ({ heading: "Offline", id: "inspections:1", text: "Inspections work with no signal.", title: "Inspections", ...over });
const body = (over: Record<string, unknown> = {}) => ({ passages: [passage()], question: "Can I inspect with no signal?", ...over });
const errorOf = (value: unknown) => {
  const parsed = parseAskLibraryBody(value);
  return "error" in parsed ? parsed.error : null;
};

describe("a good request", () => {
  it("gives the trimmed question and each passage's title, heading and text", () => {
    expect(parseAskLibraryBody(body({ question: "  Can I inspect with no signal?  " }))).toEqual({
      passages: [{ heading: "Offline", text: "Inspections work with no signal.", title: "Inspections" }],
      question: "Can I inspect with no signal?",
    });
  });

  it("does not need a heading or an id, and drops the id: it is the browser's own label", () => {
    const parsed = parseAskLibraryBody(body({ passages: [{ text: "T", title: "A" }] }));
    expect(parsed).toEqual({ passages: [{ heading: "", text: "T", title: "A" }], question: "Can I inspect with no signal?" });
    const withId = parseAskLibraryBody(body({ passages: [passage({ id: "'; DROP TABLE x; --" })] }));
    expect(JSON.stringify(withId)).not.toContain("DROP TABLE");
  });

  it("ignores fields it does not know, and keeps a passage's own line breaks", () => {
    const parsed = parseAskLibraryBody({ ...body({ passages: [passage({ extra: 1, text: "- one\n- two" })] }), role: "admin" });
    expect(parsed).toMatchObject({ passages: [{ text: "- one\n- two" }] });
    expect(parsed).not.toHaveProperty("role");
  });

  it("takes the most the limits allow", () => {
    const biggest = passage({ heading: "h".repeat(ASK_LIMITS.headingChars), id: "i".repeat(ASK_LIMITS.idChars), text: "t".repeat(ASK_LIMITS.textChars), title: "T".repeat(ASK_LIMITS.titleChars) });
    const parsed = parseAskLibraryBody({ passages: Array.from({ length: ASK_LIMITS.maxPassages }, () => biggest), question: "q".repeat(ASK_LIMITS.questionMaxChars) });
    expect(errorOf({ passages: Array.from({ length: ASK_LIMITS.maxPassages }, () => biggest), question: "q".repeat(ASK_LIMITS.questionMaxChars) })).toBeNull();
    expect(parsed).toHaveProperty("passages");
  });
});

describe("a request that is refused, with a sentence that says why", () => {
  it.each([
    ["no body", undefined],
    ["a string", "hello"],
    ["an array", []],
    ["null", null],
  ])("when the body is %s", (_label, value) => {
    expect(errorOf(value)).toBe("Send a question and the passages to answer it from.");
  });

  it("when the question is missing, not text, too short, too long or holds control characters", () => {
    expect(errorOf(body({ question: undefined }))).toBe("Send the question as text.");
    expect(errorOf(body({ question: 42 }))).toBe("Send the question as text.");
    expect(errorOf(body({ question: "  hi " }))).toMatch(/at least 3 characters/);
    expect(errorOf(body({ question: "" }))).toMatch(/at least 3 characters/);
    expect(errorOf(body({ question: "q".repeat(ASK_LIMITS.questionMaxChars + 1) }))).toMatch(/300 characters/);
    expect(errorOf(body({ question: "what\u0000 now" }))).toMatch(/plain text/);
  });

  it("when there are no passages, too many, or they are not a list", () => {
    expect(errorOf(body({ passages: [] }))).toBe("Send between 1 and 5 passages to answer from.");
    expect(errorOf(body({ passages: undefined }))).toBe("Send between 1 and 5 passages to answer from.");
    expect(errorOf(body({ passages: "text" }))).toBe("Send between 1 and 5 passages to answer from.");
    expect(errorOf(body({ passages: { 0: passage() } }))).toBe("Send between 1 and 5 passages to answer from.");
    expect(errorOf(body({ passages: Array.from({ length: 6 }, () => passage()) }))).toBe("Send between 1 and 5 passages to answer from.");
  });

  it.each([
    ["is not an object", "text", /Passage 1 must be an object/],
    ["has no title", passage({ title: undefined }), /Passage 1 needs a title/],
    ["has a blank title", passage({ title: "   " }), /Passage 1 needs a title/],
    ["has a title that is not text", passage({ title: 5 }), /needs a title/],
    ["has a title over the limit", passage({ title: "T".repeat(ASK_LIMITS.titleChars + 1) }), /up to 160 characters/],
    ["has a heading that is not text", passage({ heading: 5 }), /heading that is not text/],
    ["has a heading over the limit", passage({ heading: "h".repeat(ASK_LIMITS.headingChars + 1) }), /over 240 characters/],
    ["has no text", passage({ text: undefined }), /needs text of up to 1,500 characters/],
    ["has blank text", passage({ text: " \n " }), /needs text/],
    ["has text over the limit", passage({ text: "t".repeat(ASK_LIMITS.textChars + 1) }), /1,500 characters/],
    ["has text with a control character", passage({ text: "a\u0007b" }), /needs text/],
    ["has an id that is not text", passage({ id: 5 }), /id that is not short text/],
    ["has an id over the limit", passage({ id: "i".repeat(ASK_LIMITS.idChars + 1) }), /id that is not short text/],
  ])("when a passage %s", (_label, bad, message) => {
    expect(errorOf(body({ passages: [bad] }))).toMatch(message);
  });

  it("naming the passage that is wrong", () => {
    expect(errorOf(body({ passages: [passage(), passage({ text: "" })] }))).toMatch(/^Passage 2 /);
  });
});
