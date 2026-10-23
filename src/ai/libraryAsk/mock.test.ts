/// <reference types="jest" />
import { checkLibraryAnswer } from "./answer";
import { buildLibraryInput, NOT_COVERED_MARKER, type AskPassage } from "./input";
import { mockLibraryAnswer } from "./mock";

const KEYS: AskPassage = {
  heading: "What you do in it",
  text: "Mostly two things: check out and check in.\nChecking in is the same in reverse, with a photo of what came back.\nReport lost when one goes missing.",
  title: "Key Register",
};
const OFFLINE: AskPassage = {
  heading: "Offline",
  text: "Inspections work with no signal. Edits and photos queue on your phone and sync when you are back in range.",
  title: "Inspections",
};
const JOBS: AskPassage = {
  heading: "Who does what",
  text: "Facilities raises jobs. Above a threshold, a director has to approve as well.",
  title: "Jobs",
};

const ask = (question: string, passages: AskPassage[]) => buildLibraryInput(question, passages);
const answerTo = (question: string, passages: AskPassage[]) => {
  const input = ask(question, passages);
  const text = mockLibraryAnswer(input);
  return { text, verdict: checkLibraryAnswer(text, input) };
};

describe("the mock library answer", () => {
  it("cites the passage that covers the question, with a sentence of it", () => {
    const { text, verdict } = answerTo("How do I check a key in?", [OFFLINE, KEYS, JOBS]);
    expect(text).toBe("Mostly two things: check out and check in [2].");
    expect(verdict).toEqual({
      ok: true,
      value: { covered: true, sentences: [{ cites: [2], text: "Mostly two things: check out and check in." }] },
    });
  });

  it("says NOT_COVERED when no passage shares half of what was asked", () => {
    expect(answerTo("What is the capital of France?", [KEYS, OFFLINE]).text).toBe(NOT_COVERED_MARKER);
    expect(answerTo("Who arranges after hours leak repairs for a tenant?", [KEYS, OFFLINE, JOBS]).text).toBe(NOT_COVERED_MARKER);
  });

  it("says NOT_COVERED when the question has no words to match, or the input is not in the layout", () => {
    expect(answerTo("what is it?", [KEYS]).text).toBe(NOT_COVERED_MARKER);
    expect(mockLibraryAnswer("sample text")).toBe(NOT_COVERED_MARKER);
    expect(mockLibraryAnswer("")).toBe(NOT_COVERED_MARKER);
    expect(mockLibraryAnswer("Passages: 2\nQuestion: key\n=== Passage 1 ===\nSource: a\nkey")).toBe(NOT_COVERED_MARKER);
  });

  it("answers from at most two passages, the closest first", () => {
    const { text, verdict } = answerTo("When does a director approve a job?", [KEYS, JOBS, OFFLINE, { ...JOBS, heading: "Board" }]);
    expect(text.match(/\[\d\]/g)).toEqual(["[2]", "[4]"]);
    expect(verdict).toMatchObject({ ok: true });
  });

  it("is the same every time", () => {
    const input = ask("How do I check a key in?", [KEYS, JOBS]);
    expect(mockLibraryAnswer(input)).toBe(mockLibraryAnswer(input));
  });

  it("cites only passages it was given, however many that is", () => {
    for (const count of [1, 2, 3, 5]) {
      const passages = Array.from({ length: count }, () => KEYS);
      const { text, verdict } = answerTo("check a key in", passages);
      expect({ count, ok: verdict.ok }).toEqual({ count, ok: true });
      for (const [, n] of text.matchAll(/\[(\d)\]/g)) expect(Number(n)).toBeLessThanOrEqual(count);
    }
  });

  it("gives an answer the checks accept even when the passage holds markup, addresses or brackets", () => {
    const messy: AskPassage = {
      heading: "",
      text: "Open <b>the app</b> at https://floorplan.example/keys and see [1] for the key list. Then log it.",
      title: "Keys",
    };
    const { verdict } = answerTo("open the key app", [messy]);
    expect(verdict).toMatchObject({ ok: true });
  });

  it("copes with a long sentence and a passage of only list items", () => {
    const long: AskPassage = { heading: "", text: `Keys ${"are checked in and out with a photo ".repeat(20)}end.`, title: "Keys" };
    const list: AskPassage = { heading: "", text: "- check the key in\n- photograph the key\n1. log the key", title: "Keys" };
    expect(answerTo("check keys in", [long]).verdict).toMatchObject({ ok: true });
    expect(answerTo("photograph the key", [list]).verdict).toMatchObject({ ok: true });
  });

  it("never throws, whatever it is given", () => {
    for (const input of ["", "Passages: 1\n", "Passages: 3\nQuestion: \n=== Passage 1 ===\n", "\u0000\n\n", "x".repeat(50_000), ask("key", [{ heading: "", text: "x", title: "y" }])]) {
      expect(() => mockLibraryAnswer(input)).not.toThrow();
    }
  });
});
