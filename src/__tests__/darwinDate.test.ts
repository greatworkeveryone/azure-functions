import assert from "node:assert";
import { addDaysIso, addMonthsClamped, daysBetweenIso, isIsoDate, todayInDarwin } from "../darwinDate";

describe("todayInDarwin", () => {
  it("rolls over at midnight in Darwin (14:30 UTC), not at UTC midnight", () => {
    assert.strictEqual(todayInDarwin(new Date("2026-06-30T14:29:59Z")), "2026-06-30");
    assert.strictEqual(todayInDarwin(new Date("2026-06-30T14:30:00Z")), "2026-07-01");
    assert.strictEqual(todayInDarwin(new Date("2026-12-31T20:00:00Z")), "2027-01-01");
  });
});

describe("calendar arithmetic", () => {
  it("adds days across month and year ends", () => {
    assert.strictEqual(addDaysIso("2026-06-30", 1), "2026-07-01");
    assert.strictEqual(addDaysIso("2026-12-31", 1), "2027-01-01");
    assert.strictEqual(addDaysIso("2026-07-01", -1), "2026-06-30");
  });

  it("clamps months to the end of a shorter month, from the original date", () => {
    assert.strictEqual(addMonthsClamped("2026-01-31", 1), "2026-02-28");
    assert.strictEqual(addMonthsClamped("2024-02-29", 12), "2025-02-28");
    assert.strictEqual(addMonthsClamped("2026-01-31", 2), "2026-03-31");
    assert.strictEqual(addMonthsClamped("2026-08-31", -6), "2026-02-28");
  });

  it("counts whole days between dates", () => {
    assert.strictEqual(daysBetweenIso("2026-06-30", "2026-07-01"), 1);
    assert.strictEqual(daysBetweenIso("2026-07-01", "2026-06-30"), -1);
    assert.strictEqual(daysBetweenIso("2026-01-01", "2027-01-01"), 365);
  });

  it("recognises real calendar dates only", () => {
    assert.strictEqual(isIsoDate("2024-02-29"), true);
    assert.strictEqual(isIsoDate("2026-02-29"), false);
    assert.strictEqual(isIsoDate("2026-13-01"), false);
    assert.strictEqual(isIsoDate("01/07/2026"), false);
  });
});
