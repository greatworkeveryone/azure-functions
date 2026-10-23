/// <reference types="jest" />
import { interpretOutput } from "./output";
import { purpose as echoTest } from "./purposes/echoTest";
import { definePurpose } from "./types";
import { accept, boundedNumber, boundedString, isRecord, oneOf, refuse, unknownKeys } from "./validate";

const asText = definePurpose({ ...echoTest, expectsJson: false, validate: (value) => (typeof value === "string" ? accept(value) : refuse("not text")) });

describe("interpretOutput for a JSON purpose", () => {
  it("parses the text and hands the value to the validator", () => {
    expect(interpretOutput(echoTest, '{"echo":"hi"}')).toEqual({ ok: true, value: { echo: "hi" } });
    expect(interpretOutput(echoTest, '  \n{"echo":"hi"}\n ')).toEqual({ ok: true, value: { echo: "hi" } });
  });

  it("accepts one code fence round the whole answer, which models add even in JSON mode", () => {
    expect(interpretOutput(echoTest, '```json\n{"echo":"hi"}\n```')).toEqual({ ok: true, value: { echo: "hi" } });
    expect(interpretOutput(echoTest, '```\n{"echo":"hi"}```')).toEqual({ ok: true, value: { echo: "hi" } });
  });

  it.each([
    ["prose before the JSON", 'Sure! {"echo":"hi"}'],
    ["prose after the JSON", '{"echo":"hi"} Hope that helps'],
    ["two objects", '{"echo":"a"}{"echo":"b"}'],
    ["a fence that is not the whole answer", 'Here:\n```json\n{"echo":"hi"}\n```'],
    ["single quotes", "{'echo':'hi'}"],
    ["a trailing comma", '{"echo":"hi",}'],
    ["nothing", ""],
    ["a function call", 'process.exit(1)'],
  ])("refuses %s", (_label, text) => {
    expect(interpretOutput(echoTest, text)).toMatchObject({ ok: false });
  });

  it("refuses an answer far longer than the purpose can have asked for, without parsing it", () => {
    const huge = `{"echo":"${"x".repeat(echoTest.maxOutputTokens * 8)}"}`;
    expect(interpretOutput(echoTest, huge)).toEqual({ ok: false, reason: "The answer is far longer than the purpose allows." });
  });

  it("treats a __proto__ key as plain data and the validator drops it", () => {
    const result = interpretOutput(echoTest, '{"echo":"hi","__proto__":{"admin":true}}');
    expect(result).toMatchObject({ ok: false });
    expect(({} as { admin?: boolean }).admin).toBeUndefined();
  });

  it("turns a throwing validator, or one that returns nonsense, into a refusal", () => {
    const throwing = definePurpose({ ...echoTest, validate: () => { throw new Error("boom"); } });
    expect(interpretOutput(throwing, '{"echo":"hi"}')).toMatchObject({ ok: false });
    const vague = definePurpose({ ...echoTest, validate: (() => undefined) as never });
    expect(interpretOutput(vague, '{"echo":"hi"}')).toMatchObject({ ok: false });
    const wrongShape = definePurpose({ ...echoTest, validate: (() => ({ ok: "yes" })) as never });
    expect(interpretOutput(wrongShape, '{"echo":"hi"}')).toMatchObject({ ok: false });
  });
});

describe("interpretOutput for a text purpose", () => {
  it("hands the validator the trimmed text, unparsed", () => {
    expect(interpretOutput(asText, '  {"echo":"hi"}  ')).toEqual({ ok: true, value: '{"echo":"hi"}' });
  });

  it("does not strip a code fence: text is text", () => {
    expect(interpretOutput(asText, "```\nhello\n```")).toEqual({ ok: true, value: "```\nhello\n```" });
  });
});

describe("the validator helpers", () => {
  it("isRecord: an object, not null or an array", () => {
    expect([{}, { a: 1 }].every(isRecord)).toBe(true);
    expect([null, undefined, [], "x", 1].some(isRecord)).toBe(false);
  });

  it("unknownKeys names the fields a model added", () => {
    expect(unknownKeys({ a: 1, b: 2, c: 3 }, ["a"])).toEqual(["b", "c"]);
    expect(unknownKeys({ a: 1 }, ["a", "b"])).toEqual([]);
  });

  it("boundedString: a string up to the limit with no control characters", () => {
    expect(boundedString("hello", 5)).toBe("hello");
    expect(boundedString("hello!", 5)).toBeNull();
    expect(boundedString(5, 5)).toBeNull();
    expect(boundedString("a\u0000b", 10)).toBeNull();
    expect(boundedString("a\u001bb", 10)).toBeNull();
    expect(boundedString("line one\nline two\ttabbed", 100)).toBe("line one\nline two\ttabbed");
    expect(boundedString("", 5)).toBe("");
  });

  it("boundedNumber: a finite number in range, never a numeric string", () => {
    expect(boundedNumber(5, 0, 10)).toBe(5);
    expect(boundedNumber(0, 0, 10)).toBe(0);
    expect(boundedNumber(10, 0, 10)).toBe(10);
    for (const bad of [11, -1, "5", NaN, Infinity, null, undefined]) expect(boundedNumber(bad, 0, 10)).toBeNull();
  });

  it("oneOf: a listed string", () => {
    expect(oneOf("a", ["a", "b"])).toBe("a");
    for (const bad of ["c", 1, null, "A"]) expect(oneOf(bad, ["a", "b"])).toBeNull();
  });
});
