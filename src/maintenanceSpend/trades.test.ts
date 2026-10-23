/// <reference types="jest" />
import { ASSET_CATEGORIES } from "../assetRegister";
import { compareTrades, NOT_CATEGORISED, tradeKey, tradeLabel } from "./trades";

// A job's category is free text: a listed trade takes its list label, other text stays as written, blank is "Not categorised".

describe("tradeLabel", () => {
  it("gives a listed category its list label, whatever the case or spacing", () => {
    expect(tradeLabel("electrical")).toBe("Electrical");
    expect(tradeLabel("  hvac /   MECHANICAL ")).toBe("HVAC / mechanical");
    expect(tradeLabel("Fire & life safety")).toBe("Fire & life safety");
  });

  it("keeps any other text as written, tidied, as a trade of its own", () => {
    expect(tradeLabel("Common Areas")).toBe("Common Areas");
    expect(tradeLabel("  Tenancy   Works ")).toBe("Tenancy Works");
  });

  it.each([[null], [undefined], [""], ["   "], [42]])("calls %p Not categorised", (category) => {
    expect(tradeLabel(category)).toBe(NOT_CATEGORISED);
  });

  it("groups the same free text together whatever its case", () => {
    expect(tradeKey(tradeLabel("common areas"))).toBe(tradeKey(tradeLabel("Common Areas")));
  });
});

describe("compareTrades", () => {
  it("lists the listed trades in the list's order, then others alphabetically, then Not categorised", () => {
    const shuffled = [NOT_CATEGORISED, "Tenancy Works", "Other", "Electrical", "Common Areas", "Cleaning", "HVAC / mechanical", "Fire & life safety"];
    expect([...shuffled].sort(compareTrades)).toEqual([
      "Fire & life safety",
      "HVAC / mechanical",
      "Electrical",
      "Cleaning",
      "Other",
      "Common Areas",
      "Tenancy Works",
      NOT_CATEGORISED,
    ]);
  });

  it("follows ASSET_CATEGORIES, the backend copy of the frontend's list", () => {
    expect([...ASSET_CATEGORIES].reverse().sort(compareTrades)).toEqual([...ASSET_CATEGORIES]);
  });
});
