/// <reference types="jest" />
import { allowUsageBatch, MAX_BATCHES_PER_WINDOW, resetUsageRateLimit } from "./rateLimit";

beforeEach(resetUsageRateLimit);

describe("allowUsageBatch", () => {
  it("allows up to the ceiling in five minutes, then refuses, per person", () => {
    for (let i = 0; i < MAX_BATCHES_PER_WINDOW; i += 1) expect(allowUsageBatch(1, 1_000 + i)).toBe(true);
    expect(allowUsageBatch(1, 2_000)).toBe(false);
    expect(allowUsageBatch(2, 2_000)).toBe(true);
  });

  it("lets a person back in once the window has passed", () => {
    for (let i = 0; i < MAX_BATCHES_PER_WINDOW; i += 1) allowUsageBatch(1, 1_000);
    expect(allowUsageBatch(1, 1_000 + 5 * 60 * 1000 + 1)).toBe(true);
  });
});
