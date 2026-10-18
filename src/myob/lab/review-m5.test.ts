/// <reference types="jest" />

// The M5 reviewer's scenarios (18 Oct), kept in the suite and now asserting
// the fix: a probe passes only when the rule its case checks refuses it. Any
// other refusal (the write switch, the CFO's controls) masked the rule and
// read as a pass; now it reads "refused, but not by the rule this case checks".

jest.mock("../../myob-controls", () => ({ assertMyobControlsAllow: jest.fn() }));
jest.mock("../floorplanRecords", () => ({ installFloorplanRecordLookup: jest.fn() }));
// As the reviewer ran it: the period guard disabled, so the next rule in line is what answers.
jest.mock("../../myob-period", () => ({ ...jest.requireActual("../../myob-period"), checkMyobPeriod: jest.fn().mockReturnValue({ ok: true }) }));

import { MyobRequestRefusedError } from "../../myob-errors";
import { runLabProbe } from "./probes";

const { assertMyobControlsAllow } = require("../../myob-controls") as { assertMyobControlsAllow: jest.Mock };
const DEMO = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const NOW = new Date("2026-10-18T00:00:00Z");
const saved = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  assertMyobControlsAllow.mockResolvedValue(undefined);
});
afterAll(() => {
  process.env = saved;
});

it("with writes switched off, the prior-period probe isn't a pass: the write switch refused it, not the period rule", async () => {
  process.env = { ...saved };
  delete process.env.MYOB_WRITES_ENABLED;
  const result = await runLabProbe("prior_period", DEMO, NOW);
  expect(result).toMatchObject({ code: "writes_disabled", expected: "outside_period", refused: false });
  expect(result.message).toMatch(/^Refused, but not by the rule this case checks \(writes_disabled: /);
});

it("with writes on and orders.create off, the prior-period probe isn't a pass: the controls refused it", async () => {
  process.env = { ...saved, MYOB_WRITES_ENABLED: "true" };
  assertMyobControlsAllow.mockRejectedValue(new MyobRequestRefusedError("controls", "orders.create is switched off"));
  await expect(runLabProbe("prior_period", DEMO, NOW)).resolves.toMatchObject({ code: "controls", refused: false });
});

it("a probe that D9's no-record rule refuses isn't a pass either: that rule answered, not the case's", async () => {
  process.env = { ...saved, MYOB_WRITES_ENABLED: "true" };
  const guard = require("../../myob-request-guard") as typeof import("../../myob-request-guard");
  const real = guard.guardMyobRequest;
  // As if the probe named no record: D9's rule is the one that answers.
  const spy = jest.spyOn(guard, "guardMyobRequest").mockImplementation((input, now) => real(input, now, { testRecords: async () => ({ isTest: false, named: false }) }));
  await expect(runLabProbe("update_existing", DEMO, NOW)).resolves.toMatchObject({ code: "no_record", expected: "not_floorplan_record", refused: false });
  spy.mockRestore();
});

it("update_existing with orders.update off isn't a pass: the record rule was never reached", async () => {
  process.env = { ...saved, MYOB_WRITES_ENABLED: "true" };
  assertMyobControlsAllow.mockRejectedValue(new MyobRequestRefusedError("controls", "orders.update is switched off"));
  await expect(runLabProbe("update_existing", DEMO, NOW)).resolves.toMatchObject({ code: "controls", expected: "not_floorplan_record", refused: false });
});
