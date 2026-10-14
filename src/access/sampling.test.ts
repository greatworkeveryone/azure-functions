import { _resetSamplingForTests, BURST_LIMIT, countForBurst, shouldSampleRequest } from "./sampling";

const T0 = Date.UTC(2026, 9, 14, 0, 0, 0);
const MIN = 60_000;

beforeEach(() => _resetSamplingForTests());

describe("shouldSampleRequest", () => {
  it("takes the first request per person per 15 minutes", () => {
    expect(shouldSampleRequest("a", T0)).toBe(true);
    expect(shouldSampleRequest("a", T0 + 1)).toBe(false);
    expect(shouldSampleRequest("a", T0 + 14 * MIN)).toBe(false);
    expect(shouldSampleRequest("a", T0 + 15 * MIN)).toBe(true);
  });

  it("keeps people apart", () => {
    expect(shouldSampleRequest("a", T0)).toBe(true);
    expect(shouldSampleRequest("b", T0)).toBe(true);
  });
});

describe("countForBurst", () => {
  it("fires exactly once, on the request that goes over the limit within 5 minutes", () => {
    const fired: number[] = [];
    for (let i = 1; i <= BURST_LIMIT + 50; i += 1) {
      if (countForBurst("a", T0 + i)) fired.push(i);
    }
    expect(BURST_LIMIT).toBe(300);
    expect(fired).toEqual([BURST_LIMIT + 1]);
  });

  it("starts counting again after the window", () => {
    for (let i = 0; i < BURST_LIMIT; i += 1) countForBurst("a", T0);
    expect(countForBurst("a", T0 + 5 * MIN)).toBe(false);
  });

  it("does not fire for a steady user", () => {
    let fired = false;
    for (let i = 0; i < 1000; i += 1) fired = countForBurst("a", T0 + i * 2000) || fired;
    expect(fired).toBe(false);
  });
});
