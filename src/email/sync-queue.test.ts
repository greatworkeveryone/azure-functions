/// <reference types="jest" />
import { isEmailSyncMessage } from "./sync-queue";

describe("isEmailSyncMessage", () => {
  it.each(["graph", "manual", "admin", "timer"])("accepts source %p with a string requestedAt", (source) => {
    expect(isEmailSyncMessage({ requestedAt: "2026-10-09T00:00:00.000Z", source })).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "graph"],
    ["unknown source", { requestedAt: "x", source: "other" }],
    ["missing requestedAt", { source: "graph" }],
    ["numeric requestedAt", { requestedAt: 123, source: "graph" }],
  ])("rejects %s", (_label, value) => {
    expect(isEmailSyncMessage(value)).toBe(false);
  });
});
