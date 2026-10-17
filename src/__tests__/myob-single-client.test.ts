import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

// MYOB's audit trail (src/myob-api-log.ts) only means something if nothing can
// reach MYOB around it. Every file that is about MYOB (a myob* name) or that
// names a MYOB host (myob.com anywhere in its source) must make its HTTP calls
// through myobRequest(); the one place allowed to call fetch is myob-api-log.ts.

const SRC = join(__dirname, "..");
const ALLOWED = "myob-api-log.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const myobFiles = walk(SRC).filter((f) => /myob/i.test(basename(f)) || /myob\.com/i.test(readFileSync(f, "utf8")));

describe("MYOB single client", () => {
  it("finds the MYOB files (library, auth, handlers)", () => {
    const names = myobFiles.map((f) => relative(SRC, f));
    expect(names).toEqual(
      expect.arrayContaining([
        "myob-api-log.ts",
        "myob-auth.ts",
        "myob-client.ts",
        "myob-purchase-order.ts",
        join("functions", "myobAuthCallback.ts"),
        join("functions", "testMyobConnection.ts"),
      ]),
    );
  });

  it("also covers a file that names a MYOB host without myob in its name", () => {
    const named = walk(SRC).filter((f) => !/myob/i.test(basename(f)) && /myob\.com/i.test(readFileSync(f, "utf8")));
    expect(myobFiles).toEqual(expect.arrayContaining(named));
  });

  it("the logging client really is the one place that calls fetch", () => {
    const text = stripComments(readFileSync(join(SRC, ALLOWED), "utf8"));
    expect(text).toMatch(/\bfetch\s*\(/);
  });

  it.each(myobFiles.filter((f) => basename(f) !== ALLOWED).map((f) => [relative(SRC, f), f]))(
    "%s does not call fetch(",
    (_name, file) => {
      expect(stripComments(readFileSync(file, "utf8"))).not.toMatch(/\bfetch\s*\(/);
    },
  );
});
