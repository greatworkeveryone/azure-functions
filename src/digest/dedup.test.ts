/// <reference types="jest" />
import { alreadySentToday, dedupApplies } from "./dedup";

describe("alreadySentToday", () => {
  it("is true when the last digest went on this Darwin day", () => expect(alreadySentToday("2026-10-14", "2026-10-14")).toBe(true));
  it("is false for someone who has never had one", () => expect(alreadySentToday(null, "2026-10-14")).toBe(false));
  it("is false for yesterday or any earlier day", () => {
    expect(alreadySentToday("2026-10-13", "2026-10-14")).toBe(false);
    expect(alreadySentToday("2025-10-14", "2026-10-14")).toBe(false);
  });
  it("is false for a date after today: a wrong record never silences a morning that has not happened", () =>
    expect(alreadySentToday("2026-10-15", "2026-10-14")).toBe(false));
  it("is false for anything that is not a date", () => {
    expect(alreadySentToday("", "2026-10-14")).toBe(false);
    expect(alreadySentToday("14/10/2026", "2026-10-14")).toBe(false);
  });
});

describe("dedupApplies", () => {
  it("applies in production, where nothing redirects the mail", () => expect(dedupApplies({} as NodeJS.ProcessEnv)).toBe(true));
  it("stands aside when DEV_EMAIL_OVERRIDE redirects every address (staging, local), so the same morning can be sent again to test", () =>
    expect(dedupApplies({ DEV_EMAIL_OVERRIDE: "inbox@gwe.test" } as NodeJS.ProcessEnv)).toBe(false));
  it("treats a blank override as unset", () => expect(dedupApplies({ DEV_EMAIL_OVERRIDE: "  " } as NodeJS.ProcessEnv)).toBe(true));
});
