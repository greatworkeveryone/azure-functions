/// <reference types="jest" />

// The lookup that enforces "amend only records Floorplan created" in
// production (decision 11): myobRequest allows a PUT only when this says yes.

jest.mock("../db", () => ({ closeConnection: jest.fn(), createServiceRequestConnection: jest.fn().mockResolvedValue({}), executeQuery: jest.fn() }));

import { isFloorplanRecord } from "./floorplanRecords";

const db = require("../db") as Record<string, jest.Mock>;
const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const UID = "44444444-2222-4333-8444-555555555555";
const ask = (operation: string) => isFloorplanRecord({ companyFileId: CF, operation, uid: UID } as Parameters<typeof isFloorplanRecord>[0]);

beforeEach(() => jest.clearAllMocks());

describe("isFloorplanRecord", () => {
  it("says no when MyobProposals has no verified create for that uid in that file", async () => {
    db.executeQuery.mockResolvedValue([]);
    await expect(ask("orders.update")).resolves.toBe(false);
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("says yes only for a verified create of the same kind, file and uid", async () => {
    db.executeQuery.mockResolvedValue([{ Ours: 1 }]);
    await expect(ask("orders.update")).resolves.toBe(true);
    const [, sql, params] = db.executeQuery.mock.calls[0] as [unknown, string, { name: string; value: unknown }[]];
    expect(sql.replace(/\s+/g, " ")).toContain("State = N'verified'");
    expect(sql).toMatch(/CompanyFileId = @CompanyFileId/);
    expect(sql).toMatch(/MyobUid = @MyobUid/);
    expect(sql).toMatch(/Operation = @Operation/);
    expect(Object.fromEntries(params.map((p) => [p.name, p.value]))).toEqual({ CompanyFileId: CF, MyobUid: UID, Operation: "orders.create" });
  });

  it("checks a quote update against quote creates, and refuses every operation that isn't an update without asking", async () => {
    db.executeQuery.mockResolvedValue([{ Ours: 1 }]);
    await ask("quotes.update");
    expect(db.executeQuery.mock.calls[0][2]).toContainEqual(expect.objectContaining({ name: "Operation", value: "quotes.create" }));
    db.executeQuery.mockClear();
    for (const operation of ["orders.create", "bills.create", "orders.delete", ""]) await expect(ask(operation)).resolves.toBe(false);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("is what myobRequest consults: installing the send pipeline installs it", async () => {
    jest.isolateModules(() => {
      const guard = jest.requireActual("../myob-request-guard") as Record<string, unknown>;
      const spy = jest.spyOn(guard, "setFloorplanRecordLookup" as never);
      const { installFloorplanRecordLookup } = jest.requireActual("./floorplanRecords") as { installFloorplanRecordLookup: () => void };
      installFloorplanRecordLookup();
      expect(spy).toHaveBeenCalledWith(expect.any(Function));
    });
  });
});
