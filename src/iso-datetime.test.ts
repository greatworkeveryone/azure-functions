import { parseIsoDateTime } from "./iso-datetime";

describe("parseIsoDateTime", () => {
  it("parses ISO date-times, treating a missing offset as UTC", () => {
    expect(parseIsoDateTime("2026-02-01T10:30:00.000Z")?.toISOString()).toBe("2026-02-01T10:30:00.000Z");
    expect(parseIsoDateTime("2026-02-01T10:30")?.toISOString()).toBe("2026-02-01T10:30:00.000Z");
    expect(parseIsoDateTime("2026-02-01T10:30:00+09:30")?.toISOString()).toBe("2026-02-01T01:00:00.000Z");
    expect(parseIsoDateTime("2026-02-01T10:30:00+0930")?.toISOString()).toBe("2026-02-01T01:00:00.000Z");
    expect(parseIsoDateTime("2026-02-01")?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it.each(["01/02/2026", "2 January 2026", "tomorrow", "", "2026-02-31", "2026-13-01", "2026-01-01T25:00:00Z", "2026-01-01T10:61"])(
    "rejects %p",
    (v) => expect(parseIsoDateTime(v)).toBeNull(),
  );

  it("rejects non-strings", () => {
    expect(parseIsoDateTime(1767225600000)).toBeNull();
    expect(parseIsoDateTime(null)).toBeNull();
    expect(parseIsoDateTime({})).toBeNull();
  });
});
