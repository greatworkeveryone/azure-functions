/// <reference types="jest" />
import { DEFAULT_RETENTION_DAYS, purgeMode, retentionDays, usageTrackingOn } from "./config";

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
