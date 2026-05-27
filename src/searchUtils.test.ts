import { escapeLikePattern, validateSearchQuery } from "./searchUtils";

describe("escapeLikePattern", () => {
  it("escapes percent wildcards", () => {
    expect(escapeLikePattern("50%")).toBe("50\\%");
  });

  it("escapes underscore wildcards", () => {
    expect(escapeLikePattern("foo_bar")).toBe("foo\\_bar");
  });

  it("escapes opening square brackets", () => {
    expect(escapeLikePattern("a[b]c")).toBe("a\\[b]c");
  });

  it("escapes the escape character itself", () => {
    expect(escapeLikePattern("back\\slash")).toBe("back\\\\slash");
  });

  it("leaves plain text untouched", () => {
    expect(escapeLikePattern("acme holdings")).toBe("acme holdings");
  });
});

describe("validateSearchQuery", () => {
  it("returns ok=true and the trimmed value for valid input", () => {
    expect(validateSearchQuery("  acme  ")).toEqual({ ok: true, value: "acme" });
  });

  it("rejects empty strings", () => {
    expect(validateSearchQuery("")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects whitespace-only strings", () => {
    expect(validateSearchQuery("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects queries longer than 100 chars", () => {
    expect(validateSearchQuery("a".repeat(101))).toEqual({ ok: false, reason: "too_long" });
  });

  it("accepts exactly 100 chars", () => {
    const q = "a".repeat(100);
    expect(validateSearchQuery(q)).toEqual({ ok: true, value: q });
  });

  it("accepts undefined as a missing query (treats as empty)", () => {
    expect(validateSearchQuery(undefined)).toEqual({ ok: false, reason: "empty" });
  });
});
