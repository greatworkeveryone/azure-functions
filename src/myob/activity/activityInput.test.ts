/// <reference types="jest" />

import { parseActivityQuery } from "./activityInput";

const CF = "0F9E8D7C-6B5A-4F3E-9D2C-1B0A99887766";
const q = (params: Record<string, string>) => parseActivityQuery(new URLSearchParams(params));

describe("parseActivityQuery", () => {
  it("reads the kind, file, state and Darwin dates (the end day included)", () => {
    expect(q({ file: CF, format: "csv", from: "2026-10-14", kind: "calls", state: "verified", to: "2026-10-16" })).toEqual({
      ok: true,
      value: {
        filters: { companyFileId: CF.toLowerCase(), from: new Date("2026-10-13T14:30:00Z"), state: "verified", to: new Date("2026-10-16T14:30:00Z") },
        format: "csv",
        kind: "calls",
      },
    });
  });

  it("defaults to every proposal, as a table", () => {
    expect(q({})).toEqual({ ok: true, value: { filters: { companyFileId: null, from: null, state: null, to: null }, format: "json", kind: "proposals" } });
  });

  it.each([
    ["an unknown kind", { kind: "ledger" }],
    ["a file that isn't an id", { file: "rp" }],
    ["an unknown state", { state: "deleted" }],
    ["a date that isn't one", { from: "14/10/2026" }],
    ["an end before the start", { from: "2026-10-16", to: "2026-10-14" }],
  ])("refuses %s", (_label, params) => {
    expect(q(params)).toMatchObject({ ok: false });
  });
});
