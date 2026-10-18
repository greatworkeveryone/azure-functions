/// <reference types="jest" />

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));

import { acceptanceProblems, baselineAccepted } from "./acceptedBaseline";

const { executeQuery } = require("../../db") as { executeQuery: jest.Mock };

describe("baselineAccepted", () => {
  it("is true when the ledger has the CFO's acceptance for that proposal's correlation id", async () => {
    executeQuery.mockResolvedValueOnce([{ Accepted: 1 }]).mockResolvedValueOnce([]);
    await expect(baselineAccepted({} as never, "c-1")).resolves.toBe(true);
    await expect(baselineAccepted({} as never, "c-2")).resolves.toBe(false);
    const [, sql, params] = executeQuery.mock.calls[0] as [unknown, string, { name: string; value: unknown }[]];
    expect(sql.replace(/\s+/g, " ")).toMatch(/Action = N'myob\.control_change' AND RuleApplied = N'accept_baseline' AND CorrelationId = @Correlation/);
    expect(params).toEqual([expect.objectContaining({ name: "Correlation", value: "c-1" })]);
  });
});

describe("acceptanceProblems", () => {
  const field = (name: string, label = name) => ({ field: name, floorplan: "a", label, myob: "b" });

  it("lets the CFO accept memo, comment, line descriptions, other dates and status", () => {
    expect(acceptanceProblems([field("JournalMemo", "Memo"), field("Comment"), field("Lines[0].Description", "Line 1 description"), field("PromisedDate", "Promised date"), field("status", "Status")])).toEqual([]);
  });

  it.each([["Freight", "Freight"], ["FreightTaxCode.UID", "Freight tax code"], ["total", "Amount"], ["isTaxInclusive", "Tax inclusive"], ["supplierUid", "Supplier"], ["accountUids", "Account"], ["taxCodeUids", "Tax code"], ["number", "Number"], ["date", "Date"], ["Lines", "Lines"], ["ShipToAddress", "Ship to"]])(
    "refuses %s: accepting MYOB's value into Floorplan isn't built",
    (name, label) => {
      expect(acceptanceProblems([field("JournalMemo", "Memo"), field(name, label)])).toEqual([label]);
    },
  );
});
