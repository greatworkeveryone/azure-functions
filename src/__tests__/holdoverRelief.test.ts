import { checkRelief, tenancySchedule } from "../scheduleChange/relief";
import { validateReliefShape } from "../scheduleCharges";
const relief = { id: "relief", from: "2026-10-01", to: "2026-10-31", kind: "percent" as const, scope: ["rent" as const], value: 50 };
const tenancy = { Commencement: "2020-01-01", Expiry: "2026-09-30", Status: "current", RentPerAnnum: 10000, ScheduledRateSteps: "[]" };
it("permits an explicitly bounded relief after expiry while holding over", () => {
  jest.useFakeTimers().setSystemTime(new Date("2026-10-18T00:00:00Z"));
  try { expect(checkRelief(relief, tenancySchedule(tenancy, 0), []).ok).toBe(true); }
  finally { jest.useRealTimers(); }
});
it("retains the expiry cap when the tenancy is not holding over", () => {
  const schedule = tenancySchedule({ ...tenancy, Status: "ended" }, 0);
  expect(checkRelief(relief, schedule, [])).toMatchObject({ ok: false, refusal: { code: "outside_lease" } });
});
it("does not accept an open-ended relief", () => {
  expect(validateReliefShape({ ...relief, to: undefined }).ok).toBe(false);
});
