/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_READER } from "../myob/readbackClient";

// Plan M10 review, R2: the read-back reads. It holds a GET-only client, so no
// setting of the master switch, the update control or a verified record can
// turn a read-back into a PUT or a POST. These files never reference the write
// client, the send pipeline, or a create or put call.

const SRC = join(__dirname, "..");
const READ_BACK_FILES = [
  "functions/myobReadbackTimer.ts",
  "functions/refreshMyobRecord.ts",
  "myob/readback.ts",
  "myob/readbackClient.ts",
  "myob/readbackCompare.ts",
  "myob/readbackRun.ts",
  "myob/recordDiff.ts",
];
const WRITES = /\b(createPurchase|putPurchase|findPurchaseByNumber|LIVE_PURCHASES|MyobPurchases|pushApproved|approveAndSend)\b|\.(create|put|post)\s*\(|from\s+["']\.\.?\/(?:myob\/)?(send|sendSteps|sendOutcome|propose|withdraw)["']|method:\s*["'](POST|PUT|DELETE)["']/;

describe("the MYOB read-back is read-only", () => {
  it.each(READ_BACK_FILES)("%s never references a MYOB write", (file) => {
    const source = readFileSync(join(SRC, file), "utf8");
    expect(source.match(WRITES)?.[0] ?? null).toBeNull();
  });

  it("gives the read-back a client with get and nothing else, frozen", () => {
    expect(Object.keys(LIVE_READER)).toEqual(["get"]);
    expect(Object.isFrozen(LIVE_READER)).toBe(true);
  });
});
