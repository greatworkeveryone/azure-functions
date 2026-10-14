/// <reference types="jest" />
import { parseMoney, parseMoneyField } from "../money";

describe("parseMoney", () => {
  it.each([
    ["1,500", 1500],
    ["1,500.00", 1500],
    ["$1,500.50", 1500.5],
    ["1500", 1500],
    ["  1,234,567.8 ", 1234567.8],
    ["0", 0],
    [1500, 1500],
    [0.1 + 0.2, 0.1 + 0.2],
  ])("reads %p as %p", (raw, expected) => {
    expect(parseMoney(raw)).toBe(expected);
  });

  it.each(["abc", "-5", "1.234", "1,50", "1 500", "", "$", "12e3", -5, 1.234, Number.NaN, Infinity, true, {}])(
    "rejects %p",
    (raw) => {
      expect(parseMoney(raw)).toBeNull();
    },
  );
});

describe("parseMoneyField", () => {
  it("leaves an absent field absent and a null or blank field null", () => {
    expect(parseMoneyField(undefined, "Amount")).toEqual({ ok: true, value: undefined });
    expect(parseMoneyField(null, "Amount")).toEqual({ ok: true, value: null });
    expect(parseMoneyField("  ", "Amount")).toEqual({ ok: true, value: null });
  });

  it("names the field it refuses", () => {
    const result = parseMoneyField("abc", "Amount");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/Amount/);
  });
});
