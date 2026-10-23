const captureMessage = jest.fn();
jest.mock("../sentry", () => ({ Sentry: { captureMessage: (...args: unknown[]) => captureMessage(...args) } }));

const SAVED = { ...process.env };

function load(): typeof import("./clientIp") {
  let mod!: typeof import("./clientIp");
  jest.isolateModules(() => {
    // fresh module state per test (warn-once flag)
    mod = require("./clientIp");
  });
  return mod;
}

beforeEach(() => {
  captureMessage.mockClear();
  process.env = { ...SAVED };
  delete process.env.ACCESS_HASH_KEY;
  delete process.env.DEV_ROLE_OVERRIDE_ENABLED;
  delete process.env.WEBSITE_INSTANCE_ID;
});

afterAll(() => {
  process.env = SAVED;
});

describe("hashValue key fallback", () => {
  it("hashes with the fallback and warns Sentry once per process when the key is unset", () => {
    const { hashValue } = load();
    const a = hashValue("ip", "203.0.113.5");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    hashValue("ua", "x");
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(expect.stringContaining("ACCESS_HASH_KEY"), "warning");
  });

  it("stays silent when the dev override is enabled", () => {
    process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
    process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
    load().hashValue("ip", "203.0.113.5");
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("stays silent when the key is set, and uses it", () => {
    const { hashValue } = load();
    const fallback = hashValue("ip", "203.0.113.5");
    captureMessage.mockClear();
    process.env.ACCESS_HASH_KEY = "real-secret";
    expect(hashValue("ip", "203.0.113.5")).not.toBe(fallback);
    expect(captureMessage).not.toHaveBeenCalled();
  });
});
