/// <reference types="jest" />
// Review 117 R2: until migration 117 is applied, quote writes must not name its
// columns. Only a positive probe is remembered (as U8's buildingCategoryColumn).
jest.mock("../db", () => ({ executeQuery: jest.fn() }));
const db = require("../db") as { executeQuery: jest.Mock };
const { quoteAttributionColumnExists, resetQuoteAttributionColumnProbe } = require("../quoteAttributionColumn") as typeof import("../quoteAttributionColumn");

beforeEach(() => {
  db.executeQuery.mockReset();
  resetQuoteAttributionColumnProbe();
});

describe("quoteAttributionColumnExists", () => {
  it("asks for the column 117 adds, and remembers a yes", async () => {
    db.executeQuery.mockResolvedValue([{ Len: 4 }]);
    expect(await quoteAttributionColumnExists({} as never)).toBe(true);
    expect(await quoteAttributionColumnExists({} as never)).toBe(true);
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
    expect(db.executeQuery.mock.calls[0][1]).toBe("SELECT COL_LENGTH('dbo.Quotes', 'ApprovalAttributedToUserID') AS Len");
  });

  it("asks again after a no, so applying 117 takes effect without a restart", async () => {
    db.executeQuery.mockResolvedValueOnce([{ Len: null }]).mockResolvedValueOnce([{ Len: 4 }]);
    expect(await quoteAttributionColumnExists({} as never)).toBe(false);
    expect(await quoteAttributionColumnExists({} as never)).toBe(true);
  });
});

export {};
