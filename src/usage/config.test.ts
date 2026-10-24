/// <reference types="jest" />
import { DEFAULT_DAILY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS, dailyRetentionDays, purgeMode, retentionDays, usageTrackingOn } from "./config";

describe("usageTrackingOn", () => {
  it("is on only for exactly \"true\"", () => {
    expect(usageTrackingOn({ USAGE_TRACKING_ENABLED: "true" })).toBe(true);
    for (const value of [undefined, "", "TRUE", "True", "1", "yes", " true"]) expect(usageTrackingOn({ USAGE_TRACKING_ENABLED: value })).toBe(false);
  });
});

describe("retentionDays", () => {
  it("defaults to 180 and reads a whole number from 30 to 3650", () => {
    expect(retentionDays({})).toBe(DEFAULT_RETENTION_DAYS);
    expect(retentionDays({ USAGE_RETENTION_DAYS: "365" })).toBe(365);
    expect(retentionDays({ USAGE_RETENTION_DAYS: " 90 " })).toBe(90);
    expect(retentionDays({ USAGE_RETENTION_DAYS: "30" })).toBe(30);
  });

  it("never shortens what is kept on a typo: anything else is 180", () => {
    for (const value of ["", "abc", "0", "7", "29", "3651", "-90", "90.5", "1e3"]) expect(retentionDays({ USAGE_RETENTION_DAYS: value })).toBe(180);
  });
});

describe("dailyRetentionDays", () => {
  it("defaults to 730 and reads a whole number from 30 to 3650", () => {
    expect(DEFAULT_DAILY_RETENTION_DAYS).toBe(730);
    expect(dailyRetentionDays({})).toBe(730);
    expect(dailyRetentionDays({ USAGE_DAILY_RETENTION_DAYS: "1095" })).toBe(1095);
  });

  it("falls back to 730 on anything else, so a typo never shortens what is kept", () => {
    for (const value of ["", "abc", "0", "29", "3651", "-1", "7.5"]) expect(dailyRetentionDays({ USAGE_DAILY_RETENTION_DAYS: value })).toBe(730);
  });

  it("is never shorter than the raw retention: a day's totals outlive its raw rows", () => {
    expect(dailyRetentionDays({ USAGE_DAILY_RETENTION_DAYS: "60", USAGE_RETENTION_DAYS: "365" })).toBe(365);
    expect(dailyRetentionDays({ USAGE_RETENTION_DAYS: "1000" })).toBe(1000);
  });
});

describe("purgeMode", () => {
  it("is off unless a switch is exactly \"true\"", () => {
    expect(purgeMode({})).toBe("off");
    expect(purgeMode({ USAGE_PURGE_ENABLED: "yes" })).toBe("off");
    expect(purgeMode({ USAGE_PURGE_ENABLED: "true" })).toBe("live");
  });

  it("lets the dry run win", () => {
    expect(purgeMode({ USAGE_PURGE_DRY_RUN: "true" })).toBe("dry-run");
    expect(purgeMode({ USAGE_PURGE_DRY_RUN: "true", USAGE_PURGE_ENABLED: "true" })).toBe("dry-run");
  });
});
