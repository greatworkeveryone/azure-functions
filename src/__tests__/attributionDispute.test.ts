import { hasOpenAttributionDispute } from "../attributionDispute";
import { executeQuery } from "../db";
jest.mock("../db", () => ({ executeQuery: jest.fn() }));
const query = executeQuery as jest.Mock;
it("blocks a send when a live dispute exists and scopes it by the complete job suffix", async () => {
  query.mockResolvedValue([{ EscalationId: 1 }]);
  expect(await hasOpenAttributionDispute({} as never, 12)).toBe(true);
  const [, sql, params] = query.mock.calls[0];
  expect(sql).toContain("Status IN ('open', 'acknowledged')");
  expect(sql).toContain("quote.attribution_disputed");
  expect(sql).toContain("po.variance_disputed");
  expect(params[0].value).toBe("@12");
});
it("permits a send after no live dispute remains", async () => {
  query.mockResolvedValue([]);
  expect(await hasOpenAttributionDispute({} as never, 12)).toBe(false);
});
