import { DEFAULT_RANKER, RANKERS, resolveRanker } from "./registry";
import { rulesRanker } from "./rulesRanker";
import type { Candidate, Ranker, ScoredCandidate, SuggestionContext } from "./types";

// A second ranker, written the way a learned or LLM ranker would be: its own
// version, its own order, and nothing else in the module knows about it.
const reversed: Ranker = {
  rank: (candidates: readonly Candidate[], _context: SuggestionContext): ScoredCandidate[] =>
    [...candidates].reverse().map((candidate, index) => ({ ...candidate, reasons: [{ caution: false, text: "Chosen by the stand-in" }], score: 100 - index })),
  version: "stand-in@1",
};

describe("the ranker registry", () => {
  it("lists the rules ranker under the default name", () => {
    expect(DEFAULT_RANKER).toBe("rules");
    expect(RANKERS[DEFAULT_RANKER]).toBe(rulesRanker);
  });

  it("answers with the rules ranker when CONTRACTOR_RANKER is unset or blank", () => {
    expect(resolveRanker({})).toEqual({ fellBack: false, ranker: rulesRanker, requested: "rules" });
    expect(resolveRanker({ CONTRACTOR_RANKER: "   " }).ranker).toBe(rulesRanker);
  });

  it("is not case sensitive about the setting", () => {
    expect(resolveRanker({ CONTRACTOR_RANKER: " Rules " }).fellBack).toBe(false);
  });

  it("falls back to the default, and says so, when the setting names nothing registered", () => {
    expect(resolveRanker({ CONTRACTOR_RANKER: "learned" })).toEqual({ fellBack: true, ranker: rulesRanker, requested: "learned" });
    expect(resolveRanker({ CONTRACTOR_RANKER: "constructor" }).fellBack).toBe(true);
    expect(resolveRanker({ CONTRACTOR_RANKER: "__proto__" }).fellBack).toBe(true);
  });

  it("picks up a ranker added to the registry with no change to the caller", () => {
    const registry = { ...RANKERS, "stand-in": reversed };
    const chosen = resolveRanker({ CONTRACTOR_RANKER: "stand-in" }, registry);
    expect(chosen).toEqual({ fellBack: false, ranker: reversed, requested: "stand-in" });
    expect(chosen.ranker.version).not.toBe(rulesRanker.version);
  });

  it("reads process.env by default", () => {
    const before = process.env.CONTRACTOR_RANKER;
    process.env.CONTRACTOR_RANKER = "nothing-registered";
    try {
      expect(resolveRanker().fellBack).toBe(true);
    } finally {
      if (before === undefined) delete process.env.CONTRACTOR_RANKER;
      else process.env.CONTRACTOR_RANKER = before;
    }
  });
});
