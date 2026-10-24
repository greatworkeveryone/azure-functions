/// <reference types="jest" />
import { usageFlagEnabledFor } from "./flag";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
import { executeQuery } from "../db";

const query = jest.mocked(executeQuery);
const conn = {} as never;

beforeEach(() => {
  jest.clearAllMocks();
  query.mockResolvedValue([]);
});

describe("usageFlagEnabledFor", () => {
  it("is off when no row exists for the role: the flag ships hidden", async () => {
    expect(await usageFlagEnabledFor(conn, ["facilities"])).toBe(false);
  });

  it("is on only when a row for one of the person's roles says enabled", async () => {
    query.mockResolvedValueOnce([{ Visibility: "enabled" }]);
    expect(await usageFlagEnabledFor(conn, ["facilities"])).toBe(true);
    query.mockResolvedValueOnce([{ Visibility: "preview" }, { Visibility: "hidden" }]);
    expect(await usageFlagEnabledFor(conn, ["facilities"])).toBe(false);
    query.mockResolvedValueOnce([{ Visibility: "hidden" }, { Visibility: "enabled" }]);
    expect(await usageFlagEnabledFor(conn, ["facilities", "director"])).toBe(true);
  });

  it("reads only the usageAnalytics rows for the given roles, bound, and asks nothing for no roles", async () => {
    await usageFlagEnabledFor(conn, ["Facilities", "director"]);
    expect(String(query.mock.calls[0][1])).toMatch(/FeatureKey = N'usageAnalytics'/);
    expect(String(query.mock.calls[0][1])).toMatch(/OPENJSON\(@Roles\)/);
    expect(String(query.mock.calls[0][1])).not.toMatch(/director|facilities/i);
    expect((query.mock.calls[0][2] as { name: string; value: unknown }[]).find((p) => p.name === "Roles")?.value).toBe('["facilities","director"]');
    query.mockClear();
    expect(await usageFlagEnabledFor(conn, [])).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
