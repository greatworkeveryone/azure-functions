import { describe, test } from "node:test";
import assert from "node:assert";
import {
  resolveBuildingId,
  resolveAll,
  assertResolvedWithinThreshold,
  extractCreatedWorkRequestId,
} from "../sync-helpers";
import type { MyWorkRequest } from "../mybuildings-client";

const wr = (props: Partial<MyWorkRequest>): MyWorkRequest => props as MyWorkRequest;

describe("resolveBuildingId", () => {
  const nameToId = new Map([
    ["Randazzo Centre", 33531],
    ["19-23 Albatross St", 33533],
  ]);

  test("uses BuildingID when the API provides one", () => {
    assert.strictEqual(
      resolveBuildingId(wr({ BuildingID: 42 }), { nameToId }),
      42,
    );
  });

  test("falls back to name lookup when BuildingID is missing", () => {
    assert.strictEqual(
      resolveBuildingId(wr({ BuildingName: "Randazzo Centre" }), { nameToId }),
      33531,
    );
  });

  test("uses fallbackId when per-building sync knows the id", () => {
    assert.strictEqual(
      resolveBuildingId(wr({ BuildingName: "Anything" }), { fallbackId: 99 }),
      99,
    );
  });

  test("prefers explicit BuildingID over fallback and name lookup", () => {
    assert.strictEqual(
      resolveBuildingId(
        wr({ BuildingID: 1, BuildingName: "Randazzo Centre" }),
        { nameToId, fallbackId: 99 },
      ),
      1,
    );
  });

  test("prefers fallbackId over name lookup", () => {
    assert.strictEqual(
      resolveBuildingId(
        wr({ BuildingName: "Randazzo Centre" }),
        { nameToId, fallbackId: 99 },
      ),
      99,
    );
  });

  test("returns undefined when name is not in the map", () => {
    assert.strictEqual(
      resolveBuildingId(wr({ BuildingName: "Unknown Building" }), { nameToId }),
      undefined,
    );
  });

  test("returns undefined when neither name nor fallback nor ID is available", () => {
    assert.strictEqual(resolveBuildingId(wr({}), { nameToId }), undefined);
  });

  test("does not treat 0 as a missing BuildingID", () => {
    // Edge: legitimate 0 should pass through, not be overridden by fallback.
    assert.strictEqual(
      resolveBuildingId(wr({ BuildingID: 0 }), { fallbackId: 99 }),
      0,
    );
  });
});

describe("resolveAll", () => {
  test("resolves a mixed batch and counts unresolved", () => {
    const nameToId = new Map([["A", 1]]);
    const input = [
      wr({ WorkRequestID: 1, BuildingID: 5 }),
      wr({ WorkRequestID: 2, BuildingName: "A" }),
      wr({ WorkRequestID: 3, BuildingName: "B" }), // unresolved
      wr({ WorkRequestID: 4 }), // unresolved
    ];
    const { resolved, unresolvedCount } = resolveAll(input, { nameToId });
    assert.deepStrictEqual(
      resolved.map((r) => r.BuildingID),
      [5, 1, undefined, undefined],
    );
    assert.strictEqual(unresolvedCount, 2);
  });

  test("handles empty input", () => {
    const { resolved, unresolvedCount } = resolveAll([], { nameToId: new Map() });
    assert.deepStrictEqual(resolved, []);
    assert.strictEqual(unresolvedCount, 0);
  });

  test("does not mutate input records", () => {
    const input = [wr({ WorkRequestID: 1, BuildingName: "A" })];
    const copy = { ...input[0] };
    resolveAll(input, { nameToId: new Map([["A", 1]]) });
    assert.deepStrictEqual(input[0], copy);
  });
});

describe("extractCreatedWorkRequestId", () => {
  test("finds WorkRequestID under the Result envelope (observed live shape)", () => {
    const live = {
      Success: true,
      InfoMessage: "Work Request Lodged: 911CS2600015",
      Data: { BuildingName: "9-11 Cavenagh St", BuildingID: "33525" },
      Result: { WorkRequestID: 15340363, JobCode: "911CS2600015" },
    };
    assert.strictEqual(extractCreatedWorkRequestId(live), 15340363);
  });

  test("prefers Result.WorkRequestID over Data echo when both exist", () => {
    // Data often contains the request payload echoed back (no WR ID).
    // Result is authoritative for the newly-created ID.
    const response = {
      Data: { Id: 1 }, // echoed from some earlier field — not the new WR
      Result: { WorkRequestID: 999 },
    };
    assert.strictEqual(extractCreatedWorkRequestId(response), 999);
  });

  test("finds WorkRequestID inside the standard Data envelope", () => {
    assert.strictEqual(
      extractCreatedWorkRequestId({ Success: true, Data: { WorkRequestID: 15400123 } }),
      15400123,
    );
  });

  test("finds WorkRequestID at the top level", () => {
    assert.strictEqual(
      extractCreatedWorkRequestId({ WorkRequestID: 15400123 }),
      15400123,
    );
  });

  test("falls back to Id when WorkRequestID is absent", () => {
    assert.strictEqual(
      extractCreatedWorkRequestId({ Data: { Id: 777 } }),
      777,
    );
  });

  test("tolerates the alternate camelCase WorkRequestId spelling", () => {
    assert.strictEqual(
      extractCreatedWorkRequestId({ Data: { WorkRequestId: 999 } }),
      999,
    );
  });

  test("coerces numeric strings (e.g. if API returns JSON with quoted ints)", () => {
    assert.strictEqual(
      extractCreatedWorkRequestId({ WorkRequestID: "12345" }),
      12345,
    );
  });

  test("rejects non-numeric strings", () => {
    assert.strictEqual(
      extractCreatedWorkRequestId({ WorkRequestID: "not-an-id" }),
      undefined,
    );
  });

  test("rejects 0 and negative IDs (not valid WR identifiers)", () => {
    assert.strictEqual(extractCreatedWorkRequestId({ WorkRequestID: 0 }), undefined);
    assert.strictEqual(extractCreatedWorkRequestId({ WorkRequestID: -5 }), undefined);
  });

  test("returns undefined for malformed input", () => {
    assert.strictEqual(extractCreatedWorkRequestId(null), undefined);
    assert.strictEqual(extractCreatedWorkRequestId(undefined), undefined);
    assert.strictEqual(extractCreatedWorkRequestId({}), undefined);
    assert.strictEqual(extractCreatedWorkRequestId("a string"), undefined);
    assert.strictEqual(extractCreatedWorkRequestId(42), undefined);
  });

  test("prefers WorkRequestID over Id when both are present", () => {
    assert.strictEqual(
      extractCreatedWorkRequestId({
        Data: { WorkRequestID: 100, Id: 200 },
      }),
      100,
    );
  });

  test("ignores non-finite numbers like NaN and Infinity", () => {
    assert.strictEqual(
      extractCreatedWorkRequestId({ WorkRequestID: NaN }),
      undefined,
    );
    assert.strictEqual(
      extractCreatedWorkRequestId({ WorkRequestID: Infinity }),
      undefined,
    );
  });
});

describe("assertResolvedWithinThreshold", () => {
  test("passes when everything resolved", () => {
    assert.doesNotThrow(() => assertResolvedWithinThreshold(0, 100));
  });

  test("passes at the default 5% threshold boundary", () => {
    assert.doesNotThrow(() => assertResolvedWithinThreshold(5, 100));
  });

  test("throws above the default threshold", () => {
    assert.throws(
      () => assertResolvedWithinThreshold(10, 100),
      /could not be resolved/,
    );
  });

  test("is a no-op when total is zero", () => {
    assert.doesNotThrow(() => assertResolvedWithinThreshold(0, 0));
  });

  test("respects a custom threshold", () => {
    assert.doesNotThrow(() => assertResolvedWithinThreshold(15, 100, 0.2));
    assert.throws(() => assertResolvedWithinThreshold(15, 100, 0.1));
  });
});
