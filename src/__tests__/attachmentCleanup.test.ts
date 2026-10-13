import { CLEANUP_SELECT, cleanupEnabled } from "../attachmentCleanup";

describe("attachment cleanup rules", () => {
  it("is off unless ATTACHMENT_CLEANUP_ENABLED is exactly \"true\"", () => {
    expect(cleanupEnabled({})).toBe(false);
    expect(cleanupEnabled({ ATTACHMENT_CLEANUP_ENABLED: "false" })).toBe(false);
    expect(cleanupEnabled({ ATTACHMENT_CLEANUP_ENABLED: "1" })).toBe(false);
    expect(cleanupEnabled({ ATTACHMENT_CLEANUP_ENABLED: "true" })).toBe(true);
  });

  it("only reaps rows that were pushed to myBuildings (a work request exists)", () => {
    expect(CLEANUP_SELECT).toMatch(/AND\s+WorkRequestID\s+IS\s+NOT\s+NULL/);
  });

  it("keeps the grace window and the not-yet-confirmed guard", () => {
    expect(CLEANUP_SELECT).toMatch(/MyBuildingsConfirmedAt\s+IS\s+NULL/);
    expect(CLEANUP_SELECT).toMatch(/UploadedAt\s*<\s*DATEADD\(HOUR,\s*-@GraceHours/);
  });
});
