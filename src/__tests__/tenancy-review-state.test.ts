import assert from "node:assert";
import { computeReviewState } from "../functions/tenancy";

// PLAN D11 (WP23b): red once the review date has passed (Darwin date), amber
// within 90 days, green beyond; grey with no date or once vacated.

const TODAY = "2026-07-15";

describe("computeReviewState", () => {
  test("returns grey for vacated tenants even when a NextReviewDate is set", () => {
    assert.strictEqual(computeReviewState("2026-08-01", "vacated", TODAY), "grey");
    assert.strictEqual(computeReviewState("2026-01-01", "vacated", TODAY), "grey");
  });

  test("returns grey when NextReviewDate is undefined", () => {
    assert.strictEqual(computeReviewState(undefined, "current", TODAY), "grey");
  });

  test("returns grey for an unparseable date string", () => {
    assert.strictEqual(computeReviewState("not-a-date", "current", TODAY), "grey");
  });

  test("returns green when the next review is more than 90 days away", () => {
    assert.strictEqual(computeReviewState("2026-11-13", "current", TODAY), "green");
  });

  test("returns amber within 90 days, including the 90th day and the review day itself", () => {
    assert.strictEqual(computeReviewState("2026-08-14", "current", TODAY), "amber");
    assert.strictEqual(computeReviewState("2026-10-13", "current", TODAY), "amber");
    assert.strictEqual(computeReviewState(TODAY, "current", TODAY), "amber");
  });

  test("returns red once the review date has passed", () => {
    assert.strictEqual(computeReviewState("2026-07-14", "current", TODAY), "red");
    assert.strictEqual(computeReviewState("2026-05-31", "current", TODAY), "red");
  });

  test("treats holdover status the same as current", () => {
    assert.strictEqual(computeReviewState("2026-08-14", "holdover", TODAY), "amber");
    assert.strictEqual(computeReviewState("2027-01-15", "holdover", TODAY), "green");
    assert.strictEqual(computeReviewState("2026-07-01", "holdover", TODAY), "red");
  });

  test("reads a full ISO timestamp by its date", () => {
    assert.strictEqual(computeReviewState("2026-07-14T00:00:00.000Z", "current", TODAY), "red");
  });

  describe("with no date passed in", () => {
    afterEach(() => jest.useRealTimers());

    test("counts from the Darwin date, not UTC", () => {
      // 15:00 UTC on 30 June is 00:30 on 1 July in Darwin: a 30 June review is overdue.
      jest.useFakeTimers().setSystemTime(new Date("2026-06-30T15:00:00Z"));
      assert.strictEqual(computeReviewState("2026-06-30", "current"), "red");
      assert.strictEqual(computeReviewState("2026-07-01", "current"), "amber");
    });
  });
});
