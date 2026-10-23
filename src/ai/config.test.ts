/// <reference types="jest" />
import { DEFAULT_RATE_PER_MINUTE, DEFAULT_TIMEOUT_MS, isConfigured, isKnownProvider, readAiConfig } from "./config";

describe("readAiConfig: everything off or default when nothing is set", () => {
  it("is switched off, on the mock provider, with the documented defaults", () => {
    expect(readAiConfig({})).toEqual({
      apiKey: null,
      baseUrl: null,
      enabled: false,
      logContent: false,
      model: null,
      provider: "mock",
      ratePerMinute: 20,
      timeoutMs: 20_000,
    });
    expect(DEFAULT_TIMEOUT_MS).toBe(20_000);
    expect(DEFAULT_RATE_PER_MINUTE).toBe(20);
  });
});

describe("the two switches: only the exact string true turns them on", () => {
  it.each(["AI_ENABLED", "AI_LOG_CONTENT"])("%s", (name) => {
    const key = name === "AI_ENABLED" ? "enabled" : "logContent";
    expect(readAiConfig({ [name]: "true" })[key]).toBe(true);
    for (const value of ["TRUE", "True", "1", "yes", "on", " true", "true ", "", "false", undefined]) {
      expect(readAiConfig({ [name]: value })[key]).toBe(false);
    }
  });
});

describe("text settings", () => {
  it("trims them, and reads a blank as unset", () => {
    expect(readAiConfig({ AI_BASE_URL: "  https://llm.example  ", AI_MODEL: " m ", AI_API_KEY: " k " })).toMatchObject({
      apiKey: "k",
      baseUrl: "https://llm.example",
      model: "m",
    });
    expect(readAiConfig({ AI_BASE_URL: "   ", AI_MODEL: "", AI_API_KEY: "" })).toMatchObject({ apiKey: null, baseUrl: null, model: null });
  });

  it("lower-cases the provider, and keeps an unknown one as typed so it can be refused", () => {
    expect(readAiConfig({ AI_PROVIDER: " OpenAI_Compatible " }).provider).toBe("openai_compatible");
    expect(readAiConfig({ AI_PROVIDER: "openai" }).provider).toBe("openai");
    expect(readAiConfig({ AI_PROVIDER: " " }).provider).toBe("mock");
    expect(isKnownProvider("mock")).toBe(true);
    expect(isKnownProvider("openai_compatible")).toBe(true);
    expect(isKnownProvider("openai")).toBe(false);
  });
});

describe("numeric settings: a whole number in range, else the default", () => {
  it.each([
    ["AI_TIMEOUT_MS", "timeoutMs", 20_000, 120_000],
    ["AI_RATE_PER_MINUTE", "ratePerMinute", 20, 1_000],
  ] as const)("%s", (name, key, fallback, max) => {
    expect(readAiConfig({ [name]: "5" })[key]).toBe(5);
    expect(readAiConfig({ [name]: String(max) })[key]).toBe(max);
    for (const bad of ["0", "-5", "1.5", "abc", "1e3", "", " ", String(max + 1), "99999999999999999999"]) {
      expect({ bad, value: readAiConfig({ [name]: bad })[key] }).toEqual({ bad, value: fallback });
    }
  });
});

describe("isConfigured", () => {
  it("needs nothing for the mock", () => {
    expect(isConfigured(readAiConfig({}))).toBe(true);
  });

  it("needs a base URL and a model for openai_compatible, but no key", () => {
    const env = { AI_PROVIDER: "openai_compatible" };
    expect(isConfigured(readAiConfig(env))).toBe(false);
    expect(isConfigured(readAiConfig({ ...env, AI_BASE_URL: "https://x.example" }))).toBe(false);
    expect(isConfigured(readAiConfig({ ...env, AI_MODEL: "m" }))).toBe(false);
    expect(isConfigured(readAiConfig({ ...env, AI_BASE_URL: "https://x.example", AI_MODEL: "m" }))).toBe(true);
  });

  it("is false for a provider it does not know", () => {
    expect(isConfigured(readAiConfig({ AI_PROVIDER: "openai", AI_BASE_URL: "https://x.example", AI_MODEL: "m" }))).toBe(false);
  });
});
