/// <reference types="jest" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// A MYOB token may be fetched (and so refreshed) only while building the
// headers of a call that has already passed every guard: myobRequest calls a
// headers factory after the allowlist, period, entity mode and controls say
// yes. This scans the source so a refresh can't creep in ahead of the guards:
//   - getValidMyobAccessToken( is called only inside myob-client's
//     myobHeaders(), or inside a `headers: async () => (...)` factory;
//   - myobHeaders( is called only as a lazy factory: `() => myobHeaders(`.

const SRC = join(__dirname, "..");
const DEFINES_TOKEN = join(SRC, "myob-auth.ts");
const DEFINES_HEADERS = join(SRC, "myob-client.ts");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    if (statSync(full).isDirectory()) return walk(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)).replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

/** End index (exclusive) of the bracketed span opening at `open`. */
function spanEnd(code: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (stack.length && ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return code.length;
}

function spans(code: string, head: RegExp): [number, number][] {
  const out: [number, number][] = [];
  for (const match of code.matchAll(head)) {
    const open = (match.index ?? 0) + match[0].length;
    out.push([open, spanEnd(code, open)]);
  }
  return out;
}

const callsOf = (code: string, name: string) => [...code.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))].map((m) => m.index ?? 0);
const inside = (at: number, ranges: [number, number][]) => ranges.some(([from, to]) => at >= from && at < to);

const files = walk(SRC).filter((file) => file !== DEFINES_TOKEN);
const sources = files.map((file) => ({ code: stripComments(readFileSync(file, "utf8")), file, name: relative(SRC, file) }));

describe("MYOB tokens are fetched only inside a headers factory", () => {
  it("finds the places that fetch a token", () => {
    const callers = sources.filter((s) => callsOf(s.code, "getValidMyobAccessToken").length > 0).map((s) => s.name);
    expect(callers).toEqual(expect.arrayContaining(["myob-client.ts"]));
  });

  it.each(sources.filter((s) => callsOf(s.code, "getValidMyobAccessToken").length > 0).map((s) => [s.name, s]))(
    "%s fetches a token only while building headers",
    (_name, source) => {
      const allowed =
        source.file === DEFINES_HEADERS
          ? spans(source.code, /export\s+async\s+function\s+myobHeaders\s*\([^)]*\)\s*:\s*[^{]+/g)
          : spans(source.code, /headers\s*[:=]\s*async\s*\(\s*\)\s*=>\s*/g);
      for (const at of callsOf(source.code, "getValidMyobAccessToken")) expect(inside(at, allowed)).toBe(true);
    },
  );

  it.each(sources.filter((s) => s.file !== DEFINES_HEADERS && callsOf(s.code, "myobHeaders").length > 0).map((s) => [s.name, s]))(
    "%s passes myobHeaders as a lazy factory, never awaits it up front",
    (_name, source) => {
      for (const at of callsOf(source.code, "myobHeaders")) {
        const before = source.code.slice(Math.max(0, at - 12), at);
        expect(before).toMatch(/\(\s*\)\s*=>\s*$/);
      }
    },
  );
});
