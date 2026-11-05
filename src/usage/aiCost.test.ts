/// <reference types="jest" />
import { fetchAiCost } from "./aiCost";
import type { UsagePeriod } from "./period";

const PERIOD: UsagePeriod = { days: 30, from: "2026-10-02", fromUtc: new Date(), to: "2026-10-31", toUtc: new Date() };
const ENV = { TODDLER_SERVICE_KEY: "cc-key", TODDLER_URL: "https://toddler.example" } as NodeJS.ProcessEnv;
const COST = {
  byCategory: [{ category: "Virtual Machines", cost: 0.55 }],
  currency: "AUD",
  daily: [{ cost: 0.55, day: "2026-10-30" }],
  fetchedAt: "2026-10-31T00:00:00+00:00",
  from: "2026-10-02",
  to: "2026-10-31",
  total: 0.55,
};

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

const answer = (status: number, body: unknown) => ({ json: async () => body, ok: status >= 200 && status < 300, status });

describe("fetchAiCost", () => {
  it("asks toddler for the period with Floorplan's service key", async () => {
    fetchMock.mockResolvedValue(answer(200, COST));
    expect(await fetchAiCost(PERIOD, ENV)).toEqual({ ...COST, available: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://toddler.example/usage/cost?from=2026-10-02&to=2026-10-31");
    expect(init.headers).toEqual({ "X-Service-Key": "cc-key" });
    expect(init.redirect).toBe("error");
  });

  it("copes with a trailing slash on TODDLER_URL", async () => {
    fetchMock.mockResolvedValue(answer(200, COST));
    await fetchAiCost(PERIOD, { ...ENV, TODDLER_URL: "https://toddler.example/" });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://toddler.example/usage/cost?from=2026-10-02&to=2026-10-31");
  });

  it("is unavailable, without calling out, when toddler is not configured", async () => {
    expect(await fetchAiCost(PERIOD, {} as NodeJS.ProcessEnv)).toEqual({ available: false, reason: expect.stringContaining("not connected") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes on toddler's reason when it can't ask Azure", async () => {
    fetchMock.mockResolvedValue(answer(503, { error: "Azure is limiting cost queries; try again in a few minutes" }));
    expect(await fetchAiCost(PERIOD, ENV)).toEqual({ available: false, reason: "Azure is limiting cost queries; try again in a few minutes" });
  });

  it("says the server may be off when it can't be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await fetchAiCost(PERIOD, ENV)).toEqual({ available: false, reason: expect.stringContaining("switched off") });
  });

  it("refuses an answer in the wrong shape", async () => {
    fetchMock.mockResolvedValue(answer(200, { total: "lots" }));
    expect((await fetchAiCost(PERIOD, ENV)).available).toBe(false);
  });

  it("never sends the key over plain http", async () => {
    await expect(fetchAiCost(PERIOD, { ...ENV, TODDLER_URL: "http://toddler.example" })).rejects.toThrow("https");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
