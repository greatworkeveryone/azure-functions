import { LEDGER_MAX_SNAPSHOT_BYTES, snapshotBytes } from "./ledger/validate";
import { snapshotParts } from "./infoSheetLedger";

// S3-6: a snapshot is kept whole when it fits a ledger row, and otherwise sliced in
// order so that joining the slices' `json` and parsing gives back exactly what was removed.
const join = (parts: unknown[]) => JSON.parse((parts as { json: string }[]).map((part) => part.json).join(""));

describe("snapshotParts", () => {
  it("is nothing for nothing, and the value itself when it fits", () => {
    expect(snapshotParts(undefined)).toEqual([]);
    expect(snapshotParts({ position: 0, section: { id: "a" } })).toEqual([{ position: 0, section: { id: "a" } }]);
  });

  it("slices a value too big for a row, every slice under the cap, and nothing lost", () => {
    const value = { position: 2, section: { id: "a", rows: Array.from({ length: 50 }, (_unused, index) => ({ body: "line\n".repeat(2000), id: `r${index}` })) } };
    const parts = snapshotParts(value);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(snapshotBytes(part)).toBeLessThanOrEqual(LEDGER_MAX_SNAPSHOT_BYTES);
    expect(parts.map((part) => (part as { part: number }).part)).toEqual(parts.map((_part, index) => index + 1));
    expect(join(parts)).toEqual(value);
  });

  it("holds whatever the text needs escaping twice: quotes, backslashes, control characters, emoji split mid-pair", () => {
    const nasty = `"\\\u0001 😀 `.repeat(40_000);
    const value = { nasty };
    const parts = snapshotParts(value);
    for (const part of parts) expect(snapshotBytes(part)).toBeLessThanOrEqual(LEDGER_MAX_SNAPSHOT_BYTES);
    expect(join(parts)).toEqual(value);
  });
});
