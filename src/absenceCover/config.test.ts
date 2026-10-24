/// <reference types="jest" />
import { accessLoggingOn, coverMode, holidayCalendarConfigured, inactivityDays, maxActions } from "./config";

const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;

describe("the switches", () => {
  it("is off unless ABSENCE_COVER_ENABLED is exactly true", () => {
    expect(coverMode(env({}))).toBe("off");
    for (const value of ["TRUE", "1", "yes", "", " true"]) expect(coverMode(env({ ABSENCE_COVER_ENABLED: value }))).toBe("off");
    expect(coverMode(env({ ABSENCE_COVER_ENABLED: "true" }))).toBe("live");
  });

  it("runs dry when ABSENCE_COVER_DRY_RUN is exactly true, and the dry run wins", () => {
    expect(coverMode(env({ ABSENCE_COVER_DRY_RUN: "true" }))).toBe("dry-run");
    expect(coverMode(env({ ABSENCE_COVER_DRY_RUN: "true", ABSENCE_COVER_ENABLED: "true" }))).toBe("dry-run");
    expect(coverMode(env({ ABSENCE_COVER_DRY_RUN: "1", ABSENCE_COVER_ENABLED: "true" }))).toBe("live");
  });

  it("defaults the inactivity setting to 3 business days, and ignores a value that makes no sense", () => {
    expect(inactivityDays(env({}))).toBe(3);
    expect(inactivityDays(env({ ABSENCE_INACTIVITY_DAYS: "5" }))).toBe(5);
    expect(inactivityDays(env({ ABSENCE_INACTIVITY_DAYS: "30" }))).toBe(30);
    for (const value of ["0", "31", "-1", "2.5", "three", "", "999999999"]) expect(inactivityDays(env({ ABSENCE_INACTIVITY_DAYS: value }))).toBe(3);
  });

  it("defaults the action cap to 50, and ignores a value that makes no sense", () => {
    expect(maxActions(env({}))).toBe(50);
    expect(maxActions(env({ ABSENCE_COVER_MAX_ACTIONS: "10" }))).toBe(10);
    for (const value of ["0", "-5", "ten", "1.5", ""]) expect(maxActions(env({ ABSENCE_COVER_MAX_ACTIONS: value }))).toBe(50);
  });

  it("treats access logging as on unless it is switched off", () => {
    expect(accessLoggingOn(env({}))).toBe(true);
    expect(accessLoggingOn(env({ ACCESS_LOG_ENABLED: "false" }))).toBe(false);
    expect(accessLoggingOn(env({ ACCESS_LOG_ENABLED: "true" }))).toBe(true);
  });

  it("says whether a holiday calendar is set", () => {
    expect(holidayCalendarConfigured(env({}))).toBe(false);
    expect(holidayCalendarConfigured(env({ ESCALATION_HOLIDAYS: " " }))).toBe(false);
    expect(holidayCalendarConfigured(env({ ESCALATION_HOLIDAYS: "2026-12-25" }))).toBe(true);
  });
});
