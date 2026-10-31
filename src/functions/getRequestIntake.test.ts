jest.mock("@azure/functions", () => ({ app: { http: jest.fn() } }));

import { parseRequestIds } from "./getRequestIntake";

describe("parseRequestIds", () => {
  it("accepts myBuildings ids and Floorplan's negative ids, once each", () => {
    expect(parseRequestIds("31, -1,31")).toEqual({ ok: true, value: [31, -1] });
  });

  it("refuses zero, words, decimals, out-of-range numbers and empty lists", () => {
    for (const raw of ["0", "x", "1.5", "-0", "99999999999", "", null]) expect(parseRequestIds(raw).ok).toBe(false);
  });
});
