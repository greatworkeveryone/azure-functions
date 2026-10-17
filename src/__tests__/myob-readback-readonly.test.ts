/// <reference types="jest" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { LIVE_READER } from "../myob/readbackClient";

// Plan M10 review, R2: the read-back reads. It holds a GET-only client, so no
// setting of the master switch, the update control or a verified record can
// turn a read-back into a PUT or a POST. Every source file with "readback" in
// its name, plus the on-demand refresh and the diff, must not:
//   - import myobRequest / myob-api-log or myob-client / myobFetch as values
//     (type imports are fine), or require / import() anything at run time;
//   - import myob-purchase-order, except readbackClient.ts, and that only for
//     getPurchase and MyobPurchaseError;
//   - import the send pipeline, name the write client or a write call, call
//     fetch, or set an HTTP method at all.
// Comments are ignored: a name in a comment is not a call.

const SRC = join(__dirname, "..");
const ALSO = ["functions/refreshMyobRecord.ts", "myob/kinds.ts", "myob/recordDiff.ts"];
const CLIENT = "myob/readbackClient.ts";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : walk(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

const readBackFiles = (): string[] => {
  const named = walk(SRC).filter((file) => /readback/i.test(basename(file)));
  return [...new Set([...named.map((file) => relative(SRC, file).split("\\").join("/")), ...ALSO])].sort();
};

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

interface Import {
  names: { name: string; type: boolean }[];
  source: string;
  typeOnly: boolean;
  /** A default or namespace import, which is always a value. */
  whole: boolean;
}

function imports(code: string): Import[] {
  const found: Import[] = [];
  for (const match of code.matchAll(/import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = match[2].trim();
    const braces = /\{([\s\S]*)\}/.exec(clause);
    const names = (braces?.[1] ?? "").split(",").map((part) => part.trim()).filter(Boolean).map((part) => ({
      name: part.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim(),
      type: /^type\s/.test(part),
    }));
    const whole = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, "").trim() !== "";
    found.push({ names, source: match[3], typeOnly: Boolean(match[1]), whole });
  }
  return found;
}

const VALUE_BANNED_MODULE = /(^|\/)(myob-api-log|myob-client)$/;
const PURCHASES_MODULE = /(^|\/)myob-purchase-order$/;
const PIPELINE_MODULE = /(^|\/)(send|sendSteps|sendOutcome|propose|withdraw|floorplanRecords)$/;
const BANNED_CODE =
  /\b(myobRequest|myobFetch|createPurchase|putPurchase|findPurchaseByNumber|LIVE_PURCHASES|MyobPurchases|pushApproved|approveAndSend)\b|\.(create|put|post|patch|delete)\s*\(|\bfetch\s*\(|\brequire\s*\(|\bimport\s*\(|\bmethod\s*:/;

/** Every way a file breaks the read-only rule, as short reasons. */
function violations(source: string, file: string): string[] {
  const code = stripComments(source);
  const reasons: string[] = [];
  for (const statement of imports(code)) {
    const valueNames = statement.typeOnly ? [] : statement.names.filter((name) => !name.type).map((name) => name.name);
    if (VALUE_BANNED_MODULE.test(statement.source) && (valueNames.length > 0 || (statement.whole && !statement.typeOnly))) {
      reasons.push(`value import from ${statement.source}`);
    }
    if (PURCHASES_MODULE.test(statement.source)) {
      if (file !== CLIENT) reasons.push(`imports ${statement.source} (only ${CLIENT} may)`);
      const extra = statement.names.map((name) => name.name).filter((name) => name !== "getPurchase" && name !== "MyobPurchaseError");
      if (extra.length > 0 || statement.whole) reasons.push(`imports ${extra.join(", ") || "the whole module"} from ${statement.source}`);
    }
    if (PIPELINE_MODULE.test(statement.source)) reasons.push(`imports the send pipeline (${statement.source})`);
  }
  const banned = BANNED_CODE.exec(code.replace(/import[\s\S]*?from\s+["'][^"']+["'];?/g, ""));
  if (banned) reasons.push(`uses ${banned[0]}`);
  return reasons;
}

describe("the MYOB read-back is read-only", () => {
  it("scans every file with readback in its name, the refresh endpoint, the diff and the kinds", () => {
    expect(readBackFiles()).toEqual(
      expect.arrayContaining([
        "functions/myobReadbackTimer.ts", "functions/refreshMyobRecord.ts", "myob/kinds.ts", "myob/readback.ts", CLIENT,
        "myob/readbackCompare.ts", "myob/readbackRun.ts", "myob/recordDiff.ts",
      ]),
    );
  });

  it.each(readBackFiles())("%s never reaches a MYOB write", (file) => {
    expect(violations(readFileSync(join(SRC, file), "utf8"), file)).toEqual([]);
  });

  it("gives the read-back a client with get and nothing else, frozen", () => {
    expect(Object.keys(LIVE_READER)).toEqual(["get"]);
    expect(Object.isFrozen(LIVE_READER)).toBe(true);
  });
});

describe("the read-only scan itself", () => {
  it.each([
    ["a value import of myobRequest", 'import { myobRequest } from "../myob-api-log";', "myob/readback.ts"],
    ["a mixed import from myob-api-log", 'import { type MyobActor, MyobWritesDisabledError } from "../myob-api-log";', "myob/readback.ts"],
    ["a namespace import of myob-api-log", 'import * as log from "../myob-api-log";', "myob/readback.ts"],
    ["myobFetch from myob-client", 'import { myobFetch } from "../myob-client";', "myob/readbackRun.ts"],
    ["the reviewer's computed PUT", 'const m = (["PU", "T"].join("") as "PUT"); void send({ method: m });', "myob/readback.ts"],
    ["putPurchase in the client", 'import { getPurchase, putPurchase } from "../myob-purchase-order";', CLIENT],
    ["the purchases client outside readbackClient.ts", 'import { getPurchase } from "../myob-purchase-order";', "myob/readback.ts"],
    ["a run-time require", 'const log = require("../myob-api-log");', "myob/readback.ts"],
    ["a dynamic import", 'const log = await import("../myob-api-log");', "myob/readback.ts"],
    ["the send steps", 'import { KIND_OF } from "./sendSteps";', "myob/readback.ts"],
    ["a global fetch", 'await fetch("https://api.myob.com/accountright/x");', "myob/readback.ts"],
  ])("catches %s", (_label, source, file) => {
    expect(violations(source, file)).not.toEqual([]);
  });

  it.each([
    ["a type import", 'import type { MyobActor } from "../myob-api-log";', "myob/readback.ts"],
    ["an inline type import", 'import { type MyobActor } from "../myob-api-log";', "myob/readbackRun.ts"],
    ["the reader's own import", 'import { getPurchase, MyobPurchaseError } from "../myob-purchase-order";', CLIENT],
    ["a name in a comment", '// never myobRequest, never .put(\nconst x = 1;', "myob/readback.ts"],
  ])("allows %s", (_label, source, file) => {
    expect(violations(source, file)).toEqual([]);
  });
});
