import { manualRentReduction } from "../manualRentReduction";
import type { ScheduledRateStep } from "../scheduledRateStepLogic";
const base: ScheduledRateStep = { id: "base", methodKind: "commencement", effectiveFrom: "2020-01-01", baseRentPerAnnum: 10000, ratePercent: 0 };
it("detects a lower manual base row against the rent charged that day", () => {
  const next = { ...base, id: "next", effectiveFrom: "2021-01-01", baseRentPerAnnum: 9000 };
  expect(manualRentReduction([base], [base, next], next.id, 10000, {})).toEqual({ before: 10000, after: 9000 });
});
it("detects an edit lowering an existing row and ignores increases", () => {
  expect(manualRentReduction([base], [{ ...base, baseRentPerAnnum: 9500 }], base.id, 10000, {})).toEqual({ before: 10000, after: 9500 });
  expect(manualRentReduction([base], [{ ...base, baseRentPerAnnum: 11000 }], base.id, 10000, {})).toBeNull();
});
