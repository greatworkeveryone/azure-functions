import assert from "node:assert";
import { calcDollarsToExpiry } from "../functions/tenancy";

describe("calcDollarsToExpiry", () => {
  test("pro-rates the annual rent by days using a 365-day year", () => {
    // 76 days remaining on a $55,150/yr lease ⇒ (76 / 365) * 55150
    const result = calcDollarsToExpiry(76, 55150);
    assert.ok(Math.abs(result - 11483.2876712) < 1e-6, `got ${result}`);
  });

  test("returns 0 when daysToExpiry is zero", () => {
    assert.strictEqual(calcDollarsToExpiry(0, 55150), 0);
  });

  test("returns 0 when daysToExpiry is negative (expired lease)", () => {
    assert.strictEqual(calcDollarsToExpiry(-30, 55150), 0);
  });

  test("returns the full annual rent when exactly 365 days remain", () => {
    assert.strictEqual(calcDollarsToExpiry(365, 55150), 55150);
  });

  test("returns 0 when annual rent is 0", () => {
    assert.strictEqual(calcDollarsToExpiry(180, 0), 0);
  });
});
