/// <reference types="jest" />
import { absent, item } from "../__tests__/fixtures/absenceCover";
import { decideMove, fallsDueBeforeReturn } from "./policy";
import type { AbsenceKind, Importance } from "./types";

// Planned and unplanned leave return on Monday 2 Nov 2026; an inactive person has no known return.
const away = (kind: AbsenceKind) => absent(kind === "inactive" ? { endDate: null, kind, returnDate: null } : { kind });
const dueOn = (iso: string | null) => (iso === null ? null : new Date(`${iso}T02:00:00Z`)); // 11:30 in Darwin that day
const KINDS: AbsenceKind[] = ["planned", "unplanned", "inactive"];
const IMPORTANCES: Importance[] = ["high", "medium", "low"];

describe("decideMove: falls due before they are back", () => {
  it.each(IMPORTANCES.flatMap((importance) => (["planned", "unplanned"] as const).map((kind) => [importance, kind] as const)))(
    "moves a %s item at once for %s leave",
    (importance, kind) => {
      expect(decideMove(item({ dueAt: dueOn("2026-10-30"), importance }), away(kind))).toEqual({ action: "move", reasonCode: "due_before_return" });
    },
  );

  it("moves something already overdue", () => {
    expect(decideMove(item({ dueAt: dueOn("2026-10-20") }), away("planned"))).toEqual({ action: "move", reasonCode: "due_before_return" });
  });

  it("counts the return day itself as back in time: due that day is not due before they return", () => {
    expect(fallsDueBeforeReturn({ dueAt: dueOn("2026-11-01") }, { returnDate: "2026-11-02" })).toBe(true);
    expect(fallsDueBeforeReturn({ dueAt: dueOn("2026-11-02") }, { returnDate: "2026-11-02" })).toBe(false);
    expect(decideMove(item({ dueAt: dueOn("2026-11-02") }), away("planned"))).toEqual({ action: "suggest", reasonCode: "due_after_return" });
  });

  it("uses the Darwin day: 06:00 UTC on 1 Nov is already 2 Nov in Darwin", () => {
    expect(fallsDueBeforeReturn({ dueAt: new Date("2026-11-01T20:00:00Z") }, { returnDate: "2026-11-02" })).toBe(false);
  });
});

describe("decideMove: due after they are back", () => {
  it.each([
    ["high", "planned", { action: "suggest", reasonCode: "due_after_return" }],
    ["medium", "planned", { action: "suggest", reasonCode: "due_after_return" }],
    ["low", "planned", { action: "suggest", reasonCode: "due_after_return" }],
    ["high", "unplanned", { action: "move", reasonCode: "urgent_unplanned" }],
    ["medium", "unplanned", { action: "suggest", reasonCode: "due_after_return" }],
    ["low", "unplanned", { action: "suggest", reasonCode: "due_after_return" }],
    ["high", "inactive", { action: "suggest", reasonCode: "inactive_suggest_only" }],
    ["medium", "inactive", { action: "suggest", reasonCode: "inactive_suggest_only" }],
    ["low", "inactive", { action: "suggest", reasonCode: "inactive_suggest_only" }],
  ] as const)("%s importance, %s absence", (importance, kind, expected) => {
    expect(decideMove(item({ dueAt: dueOn("2026-11-10"), importance }), away(kind))).toEqual(expected);
  });
});

describe("decideMove: no due date", () => {
  it.each([
    ["high", "planned", { action: "suggest", reasonCode: "no_due_date" }],
    ["medium", "planned", { action: "suggest", reasonCode: "no_due_date" }],
    ["high", "unplanned", { action: "move", reasonCode: "urgent_unplanned" }],
    ["medium", "unplanned", { action: "suggest", reasonCode: "no_due_date" }],
    ["high", "inactive", { action: "suggest", reasonCode: "inactive_suggest_only" }],
    ["medium", "inactive", { action: "suggest", reasonCode: "inactive_suggest_only" }],
  ] as const)("%s importance, %s absence", (importance, kind, expected) => {
    expect(decideMove(item({ dueAt: null, importance }), away(kind))).toEqual(expected);
  });
});

describe("decideMove: inactivity only ever suggests", () => {
  it.each(IMPORTANCES.flatMap((importance) => [true, false].map((overdue) => [importance, overdue] as const)))("a %s item, overdue %s, is never moved automatically for someone who has not signed in", (importance, overdue) => {
    expect(decideMove(item({ dueAt: overdue ? dueOn("2026-10-01") : dueOn("2026-12-01"), importance }), away("inactive"))).toEqual({ action: "suggest", reasonCode: "inactive_suggest_only" });
  });
});

describe("decideMove: an unknown return", () => {
  it("never says something falls due before someone who has not signed in returns", () => {
    expect(fallsDueBeforeReturn({ dueAt: dueOn("2026-10-20") }, { returnDate: null })).toBe(false);
    expect(decideMove(item({ dueAt: dueOn("2026-10-20"), importance: "medium" }), away("inactive"))).toEqual({ action: "suggest", reasonCode: "inactive_suggest_only" });
  });
});

describe("decideMove: personal items", () => {
  it.each(KINDS)("leaves an item only its owner can answer where it is (%s)", (kind) => {
    expect(decideMove(item({ dueAt: dueOn("2026-10-20"), importance: "high", personal: true }), away(kind))).toEqual({ action: "stay", reasonCode: "personal" });
  });
});
