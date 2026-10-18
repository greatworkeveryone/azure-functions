/// <reference types="jest" />

// The lab's agreement probes (plan M5): each builds the request the agreement
// forbids and asks Floorplan's own guard, which must refuse it. A probe never
// sends anything: it calls the guard, not the MYOB client.

jest.mock("../../myob-controls", () => ({ assertMyobControlsAllow: jest.fn() }));
jest.mock("../floorplanRecords", () => ({ installFloorplanRecordLookup: jest.fn(), isFloorplanRecord: jest.fn().mockResolvedValue(false) }));

import { MyobRequestRefusedError } from "../../myob-errors";
import { LAB_PROBES, OFF_FILE_PROBE_ID, runLabProbe } from "./probes";

const { assertMyobControlsAllow } = require("../../myob-controls") as { assertMyobControlsAllow: jest.Mock };
const DEMO = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const NOW = new Date("2026-10-18T00:00:00Z");
const saved = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...saved, MYOB_PERIOD_START: "2026-10-01", MYOB_WRITES_ENABLED: "true" };
  assertMyobControlsAllow.mockResolvedValue(undefined);
});
afterAll(() => {
  process.env = saved;
});

describe("runLabProbe", () => {
  it.each([
    ["prior_period", "outside_period", /before the current period/],
    ["card_file", "not_allowed", /Card File/],
    ["delete_order", "not_allowed", /never deletes/],
    ["chart_of_accounts", "not_allowed", /Accounts/],
    ["update_existing", "not_floorplan_record", /only records it created/],
  ])("%s is refused inside Floorplan (%s)", async (probe, code, message) => {
    const result = await runLabProbe(probe as keyof typeof LAB_PROBES, DEMO, NOW);
    expect(result).toMatchObject({ code, refused: true });
    expect(result.message).toMatch(message);
    expect(result.request.url).toContain(probe === "file_off" ? OFF_FILE_PROBE_ID : DEMO);
  });

  it("refuses a file set to off through the file's mode, on a file id that can't be registered", async () => {
    assertMyobControlsAllow.mockRejectedValue(new MyobRequestRefusedError("controls", "MYOB is off for company file 00000000-0000-4000-8000-000000000000"));
    const result = await runLabProbe("file_off", DEMO, NOW);
    expect(result).toMatchObject({ code: "controls", refused: true });
    expect(assertMyobControlsAllow).toHaveBeenCalledWith({ companyFileId: OFF_FILE_PROBE_ID, operation: "purchases.read" }, NOW);
  });

  it("reports a probe the guard let through as a failure of the agreement, and still sends nothing", async () => {
    const result = await runLabProbe("file_off", DEMO, NOW); // controls mocked to allow it
    expect(result).toMatchObject({ code: null, refused: false });
    expect(result.message).toMatch(/let this through/);
  });

  it("dates the prior-period probe the day before the period starts", async () => {
    const result = await runLabProbe("prior_period", DEMO, NOW);
    expect(JSON.parse(String(result.request.body)).Date).toBe("2026-09-30T00:00:00");
  });

  it("names every probe the plan lists, each with the refusal code its case checks", () => {
    expect(Object.keys(LAB_PROBES).sort()).toEqual(["card_file", "chart_of_accounts", "delete_order", "file_off", "prior_period", "update_existing"]);
    expect(Object.fromEntries(Object.entries(LAB_PROBES).map(([name, probe]) => [name, probe.expect]))).toEqual({
      card_file: "not_allowed", chart_of_accounts: "not_allowed", delete_order: "not_allowed", file_off: "controls", prior_period: "outside_period", update_existing: "not_floorplan_record",
    });
  });

  it("doesn't count a refusal by another rule as the case passing", async () => {
    assertMyobControlsAllow.mockRejectedValue(new MyobRequestRefusedError("controls", "orders.update is switched off"));
    const result = await runLabProbe("update_existing", DEMO, NOW);
    expect(result).toMatchObject({ code: "controls", expected: "not_floorplan_record", refused: false });
    expect(result.message).toBe("Refused, but not by the rule this case checks (controls: orders.update is switched off). Nothing was sent.");
  });
});

describe("a probe can't reach MYOB", () => {
  it("never imports the MYOB client, myobRequest, the purchases client or fetch", () => {
    const { readFileSync } = jest.requireActual("node:fs") as typeof import("node:fs");
    const { join } = jest.requireActual("node:path") as typeof import("node:path");
    const code = readFileSync(join(__dirname, "probes.ts"), "utf8").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/myob-api-log|myob-client|myob-purchase-order|readbackClient|\bmyobRequest\b|\bmyobFetch\b|\bfetch\s*\(|\brequire\s*\(|\bimport\s*\(/);
    expect(code).toMatch(/import \{ guardMyobRequest \} from "\.\.\/\.\.\/myob-request-guard"/);
  });
});
