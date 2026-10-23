import { ENV_CONTRACT, FORBIDDEN_IN_PROD, forbiddenSettingsSet, missingSettings } from "./envContract";

const PROD = { AZURE_FUNCTIONS_ENVIRONMENT: "Production" };

describe("ENV_CONTRACT", () => {
  it.each([
    "ACCESS_HASH_KEY",
    "MYOB_TOKEN_KEY",
    "MYOB_CF_USER",
    "MYOB_CF_PASSWORD",
    "GRAPH_MAILBOX_PROD",
    "GRAPH_MAILBOX_ACTIVE",
    "GRAPH_SUBSCRIPTION_CLIENT_STATE",
    "GRAPH_NOTIFICATION_URL",
  ])("requires %s in production", (name) => {
    const entry = ENV_CONTRACT.find((s) => s.name === name);
    expect(entry?.requiredInProd).toBe(true);
    expect(missingSettings({}).map((m) => m.name)).toContain(name);
  });
});

describe("forbiddenSettingsSet", () => {
  it("is empty outside Production", () => {
    expect(forbiddenSettingsSet({ DEV_EMAIL_OVERRIDE: "a@b.c", AZURE_FUNCTIONS_ENVIRONMENT: "Development" })).toEqual([]);
    expect(forbiddenSettingsSet({ DEV_EMAIL_OVERRIDE: "a@b.c" })).toEqual([]);
  });

  it("is empty in Production when none are set or all are blank", () => {
    expect(forbiddenSettingsSet(PROD)).toEqual([]);
    expect(forbiddenSettingsSet({ ...PROD, DEV_EMAIL_OVERRIDE: "  " })).toEqual([]);
  });

  it.each(FORBIDDEN_IN_PROD.map((f) => f.name))("flags %s when set in Production", (name) => {
    expect(forbiddenSettingsSet({ ...PROD, [name]: "true" }).map((f) => f.name)).toEqual([name]);
  });

  it("treats the reply-decisions switch as a warning and the rest as errors", () => {
    const severity = (n: string) => FORBIDDEN_IN_PROD.find((f) => f.name === n)?.severity;
    expect(severity("EMAIL_REPLY_DECISIONS_ENABLED")).toBe("warn");
    expect(severity("DEV_EMAIL_OVERRIDE")).toBe("error");
    expect(severity("SQL_USER_CONNECTION")).toBe("error");
  });
});
