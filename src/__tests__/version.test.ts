/// <reference types="jest" />
jest.mock("@azure/functions", () => ({ app: { http: jest.fn() } }));
import { version } from "../functions/version";

describe("version", () => {
  it("returns only the build sha, time and environment name", async () => {
    process.env.BUILD_SHA = "abc1234";
    process.env.BUILD_TIME = "2026-11-21T00:00:00Z";
    process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Staging";
    const res = await version();
    delete process.env.AZURE_FUNCTIONS_ENVIRONMENT;
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ builtAt: "2026-11-21T00:00:00Z", commit: "abc1234", environment: "Staging" });
  });
});
