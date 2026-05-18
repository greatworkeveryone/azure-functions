import assert from "node:assert";
import {
  validateStep,
  parseSteps,
  upsertStep,
  deleteStep,
  NOT_FOUND,
} from "../scheduledRateStepLogic";

const validId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

describe("validateStep", () => {
  it("accepts a valid step", () => {
    const r = validateStep({ id: validId, effectiveFrom: "2026-07-01", ratePercent: 6 });
    assert.strictEqual(r.ok, true);
    if (!r.ok) throw new Error();
    assert.strictEqual(r.step.ratePercent, 6);
    assert.strictEqual(r.step.effectiveFrom, "2026-07-01");
  });

  it("accepts a step with a note", () => {
    const r = validateStep({ id: validId, effectiveFrom: "2026-07-01", ratePercent: 5, note: "Year 2" });
    assert.strictEqual(r.ok, true);
    if (!r.ok) throw new Error();
    assert.strictEqual(r.step.note, "Year 2");
  });

  it("mints a UUID when id is blank", () => {
    const r = validateStep({ id: "", effectiveFrom: "2026-07-01", ratePercent: 3 });
    assert.strictEqual(r.ok, true);
    if (!r.ok) throw new Error();
    assert.match(r.step.id, /^[0-9a-f-]{36}$/i);
    assert.notStrictEqual(r.step.id, "");
  });

  it("rejects a non-ISO date", () => {
    const r = validateStep({ id: validId, effectiveFrom: "01/07/2026", ratePercent: 6 });
    assert.strictEqual(r.ok, false);
    if (r.ok) throw new Error();
    assert.match(r.error, /effectiveFrom/);
  });

  it("rejects ratePercent = 0", () => {
    const r = validateStep({ id: validId, effectiveFrom: "2026-07-01", ratePercent: 0 });
    assert.strictEqual(r.ok, false);
  });

  it("rejects ratePercent > 100", () => {
    const r = validateStep({ id: validId, effectiveFrom: "2026-07-01", ratePercent: 150 });
    assert.strictEqual(r.ok, false);
  });

  it("rejects unknown keys", () => {
    const r = validateStep({ id: validId, effectiveFrom: "2026-07-01", ratePercent: 5, mystery: true });
    assert.strictEqual(r.ok, false);
    if (r.ok) throw new Error();
    assert.match(r.error, /Unknown key/);
  });
});

describe("parseSteps", () => {
  it("parses valid JSON array", () => {
    const json = JSON.stringify([{ id: validId, effectiveFrom: "2026-07-01", ratePercent: 5 }]);
    assert.strictEqual(parseSteps(json).length, 1);
  });

  it("returns [] for null", () => {
    assert.deepStrictEqual(parseSteps(null), []);
  });

  it("drops rows missing required fields", () => {
    const json = JSON.stringify([{ id: validId, ratePercent: 5 }]); // missing effectiveFrom
    assert.strictEqual(parseSteps(json).length, 0);
  });
});

describe("upsertStep", () => {
  it("appends when id is new", () => {
    const existing = [{ id: "aaa", effectiveFrom: "2026-07-01", ratePercent: 6 }];
    const incoming = { id: "bbb", effectiveFrom: "2027-07-01", ratePercent: 5 };
    const result = upsertStep(existing, incoming);
    assert.strictEqual(result.length, 2);
  });

  it("replaces in place when id matches", () => {
    const existing = [{ id: "aaa", effectiveFrom: "2026-07-01", ratePercent: 6 }];
    const incoming = { id: "aaa", effectiveFrom: "2026-07-01", ratePercent: 4 };
    const result = upsertStep(existing, incoming);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].ratePercent, 4);
  });
});

describe("deleteStep", () => {
  it("removes by id", () => {
    const existing = [{ id: "aaa", effectiveFrom: "2026-07-01", ratePercent: 6 }];
    const result = deleteStep(existing, "aaa");
    assert.notStrictEqual(result, NOT_FOUND);
    if (result === NOT_FOUND) throw new Error();
    assert.strictEqual(result.length, 0);
  });

  it("returns NOT_FOUND when id is absent", () => {
    assert.strictEqual(deleteStep([], "missing"), NOT_FOUND);
  });
});
