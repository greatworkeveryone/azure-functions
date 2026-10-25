import { DEFAULT_RANKER, RANKERS, resolveRanker } from "./registry";
import { rulesRanker } from "./rulesRanker";
import type { Ranker } from "./types";

const standIn: Ranker = { rank: () => [], version: "standin@1" };

describe("resolveRanker", () => {
  it("answers the rules ranker when nothing is set", () => {
    expect(resolveRanker({})).toEqual({ fellBack: false, ranker: rulesRanker, requested: DEFAULT_RANKER });
    expect(Object.keys(RANKERS)).toEqual(["rules"]);
  });

  it("picks a registered ranker by name, without regard to case or spaces, with no change for any caller", () => {
    const registry = { ...RANKERS, learned: standIn };
    expect(resolveRanker({ TRIAGE_RANKER: " Learned " }, registry)).toEqual({ fellBack: false, ranker: standIn, requested: "learned" });
    expect(resolveRanker({ TRIAGE_RANKER: "rules" }, registry).ranker).toBe(rulesRanker);
  });

  it("falls back to rules, and says it did, when the setting names nothing registered", () => {
    expect(resolveRanker({ TRIAGE_RANKER: "learned" })).toEqual({ fellBack: true, ranker: rulesRanker, requested: "learned" });
    expect(resolveRanker({ TRIAGE_RANKER: "toString" }).fellBack).toBe(true);
  });
});
