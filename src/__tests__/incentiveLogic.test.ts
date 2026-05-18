import assert from "node:assert";
import { validateIncentive, parseIncentives } from "../incentiveLogic";

describe("validateIncentive — perSqmRate", () => {
  it("accepts a valid perSqmRate with duration", () => {
    const result = validateIncentive({
      id: "",
      kind: "perSqmRate",
      ratePerSqm: 90,
      durationMonths: 6,
    });
    assert.strictEqual(result.ok, true);
    if (!result.ok) throw new Error("expected ok");
    assert.strictEqual(result.incentive.ratePerSqm, 90);
    assert.strictEqual(result.incentive.durationMonths, 6);
  });

  it("accepts perSqmRate with null duration (whole lease)", () => {
    const result = validateIncentive({
      id: "",
      kind: "perSqmRate",
      ratePerSqm: 120,
      durationMonths: null,
    });
    assert.strictEqual(result.ok, true);
  });

  it("accepts perSqmRate with no duration field (whole lease)", () => {
    const result = validateIncentive({ id: "", kind: "perSqmRate", ratePerSqm: 75 });
    assert.strictEqual(result.ok, true);
  });

  it("rejects perSqmRate with ratePerSqm = 0", () => {
    const result = validateIncentive({ id: "", kind: "perSqmRate", ratePerSqm: 0 });
    assert.strictEqual(result.ok, false);
    if (result.ok) throw new Error("expected error");
    assert.ok(result.error.includes("ratePerSqm"), `error should mention ratePerSqm, got: ${result.error}`);
  });

  it("rejects perSqmRate with negative ratePerSqm", () => {
    const result = validateIncentive({ id: "", kind: "perSqmRate", ratePerSqm: -10 });
    assert.strictEqual(result.ok, false);
  });

  it("rejects perSqmRate with durationMonths = 0", () => {
    const result = validateIncentive({ id: "", kind: "perSqmRate", ratePerSqm: 90, durationMonths: 0 });
    assert.strictEqual(result.ok, false);
    if (result.ok) throw new Error("expected error");
    assert.ok(result.error.includes("durationMonths"), `error should mention durationMonths, got: ${result.error}`);
  });

  it("rejects perSqmRate with reductionAmount present", () => {
    const result = validateIncentive({
      id: "",
      kind: "perSqmRate",
      ratePerSqm: 90,
      reductionAmount: 500,
    });
    assert.strictEqual(result.ok, false);
  });

  it("rejects unknown kind", () => {
    const result = validateIncentive({ id: "", kind: "bonusRate", ratePerSqm: 90 });
    assert.strictEqual(result.ok, false);
  });
});

describe("parseIncentives — perSqmRate", () => {
  it("survives a perSqmRate row in persisted JSON", () => {
    const json = JSON.stringify([
      { id: "11111111-1111-1111-1111-111111111111", kind: "perSqmRate", ratePerSqm: 90, durationMonths: 6 },
    ]);
    const result = parseIncentives(json);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].kind, "perSqmRate");
  });

  it("drops legacy rows with an unrecognised kind", () => {
    const json = JSON.stringify([
      { id: "22222222-2222-2222-2222-222222222222", kind: "unknownKind" },
    ]);
    assert.strictEqual(parseIncentives(json).length, 0);
  });
});
