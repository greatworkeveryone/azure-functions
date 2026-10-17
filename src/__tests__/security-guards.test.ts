import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Security evidence guards (S8). A failure here is a stop sign: fix the code,
// or, for a route that is anonymous by design, add it below with the reason.

const SRC = join(__dirname, "..");
const FUNCTIONS = join(SRC, "functions");
const read = (path: string) => readFileSync(path, "utf8");
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });

// ── Every route reaches a role gate (SEC-24) ─────────────────────────────────

// runControllerAction (src/myob-controller-handler.ts) is the CFO-only gate the
// MYOB admin routes share, and withCaller (src/myob/proposalHttp.ts) resolves
// the caller's roles for the MYOB proposal routes; the tests below keep both honest.
// requireSignOffRole (src/scheduleSignOff.ts) is requireRole plus a refusal of admin
// alone, for the two schedule sign-off routes; schedule-signoff-handlers.test.ts pins it.
const GATE = /\b(requireRole|requireSignOffRole|authorize|authorizeWrite|rolesForRequest|runControllerAction|withCaller)\s*(?:<[^>]*>)?\s*\(/;

// Routes with no role check, each for a reason that is itself a control.
describe("the shared MYOB controller gate", () => {
  it("refuses anyone but the MYOB controller before parsing the body or doing any work", () => {
    const gate = read(join(SRC, "myob-controller-handler.ts"));
    const check = gate.search(/if \(!isMyobController\(await rolesForRequest\(request\)\)\) return forbiddenResponse\(/);
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(gate.search(/action\.parse\(/));
    expect(check).toBeLessThan(gate.search(/action\.work\(/));
  });
});

describe("the MYOB proposal gate", () => {
  it("resolves the caller's roles before running any route's work", () => {
    const gate = read(join(SRC, "myob", "proposalHttp.ts"));
    const roles = gate.search(/const roles = await rolesForRequest\(request\)/);
    expect(roles).toBeGreaterThan(-1);
    expect(roles).toBeLessThan(gate.search(/return await work\(/));
  });

  it("is used only by routes that refuse a wrong role (forbidden) before acting", () => {
    const users = sourceFiles(FUNCTIONS).filter((file) => /\bwithCaller\s*\(/.test(read(file)));
    expect(users.length).toBeGreaterThanOrEqual(5);
    for (const file of users) expect(read(file)).toMatch(/return forbidden\(/);
  });
});

const ANONYMOUS_BY_DESIGN: Record<string, string> = {
  corsOptions: "preflight only; returns CORS headers and no data",
  graphNotification: "Graph webhook; authenticated by the constant-time clientState secret",
  myobAuthCallback: "OAuth redirect; authenticated by the signed, expiring state",
  registerSelf: "sign-in; verifies the token signature itself and needs no role yet",
};

const NEXT_DECLARATION =
  /\n(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(|\napp\.http\(|\n(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?\(/;

/** The source from a function's declaration to the next top-level declaration. */
function functionRegion(text: string, name: string): string | null {
  const decl = text.match(
    new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(|(?:^|\\n)(?:export\\s+)?const\\s+${name}\\s*=`),
  );
  if (!decl || decl.index === undefined) return null;
  const rest = text.slice(decl.index + decl[0].length);
  const end = rest.search(NEXT_DECLARATION);
  return end < 0 ? rest : rest.slice(0, end);
}

function handlerRegion(text: string, fn: string): string | null {
  const local = functionRegion(text, fn);
  if (local !== null) return local;
  const imported = text.match(new RegExp(`import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*"([^"]+)"`));
  if (!imported) return null;
  const target = resolve(FUNCTIONS, imported[1] + ".ts");
  return existsSync(target) ? functionRegion(read(target), fn) : null;
}

interface Route { file: string; fn: string | null; name: string }

const routes: Route[] = sourceFiles(FUNCTIONS).flatMap((file) =>
  [...read(file).matchAll(/app\.http\(\s*"([A-Za-z0-9_]+)"\s*,\s*\{([\s\S]*?)\}\s*\)/g)].map((m) => {
    const handler = m[2].match(/handler:\s*(?:\([^)]*\)\s*=>\s*)?([A-Za-z0-9_]+)/);
    return { file: relative(SRC, file), fn: handler ? handler[1] : null, name: m[1] };
  }),
);

describe("every HTTP route checks the caller's role", () => {
  it("finds every registration", () => {
    const registrations = sourceFiles(FUNCTIONS)
      .map((file) => (read(file).match(/app\.http\(\s*"/g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    expect(routes).toHaveLength(registrations);
    expect(registrations).toBeGreaterThan(200);
  });

  it.each(routes.map((r) => [r.name, r] as const))("%s", (_name, route) => {
    if (ANONYMOUS_BY_DESIGN[route.name]) return;
    expect(route.fn).not.toBeNull();
    const body = handlerRegion(read(join(SRC, route.file)), route.fn as string);
    expect(body).not.toBeNull();
    expect(body).toMatch(GATE);
  });

  it("keeps the anonymous list honest", () => {
    const names = new Set(routes.map((r) => r.name));
    expect(Object.keys(ANONYMOUS_BY_DESIGN).filter((name) => !names.has(name))).toEqual([]);
  });
});

// ── Blob names are checked before storage is touched (SEC-01) ────────────────

describe("blob access goes through checked helpers", () => {
  const blobStorage = read(join(SRC, "blob-storage.ts"));
  const helpers = [...blobStorage.matchAll(/\n(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g)].map((m) => m[1]);
  const touching = helpers.filter((fn) =>
    /getBlockBlobClient\(|generateBlobSASQueryParameters\(/.test(functionRegion(blobStorage, fn) ?? ""),
  );

  it("finds the helpers that touch storage", () => {
    expect(touching.length).toBeGreaterThanOrEqual(8);
  });

  it.each(touching)("%s checks the blob name", (fn) => {
    expect(functionRegion(blobStorage, fn)).toMatch(/\bassertBlobName\(/);
  });

  it("no other module talks to the storage SDK directly", () => {
    const direct = sourceFiles(SRC)
      .filter((file) => !file.endsWith("blob-storage.ts"))
      .filter((file) => /getBlockBlobClient\(|getContainerClient\(|BlobServiceClient\b|generateBlobSASQueryParameters\(/.test(read(file)))
      .map((file) => relative(SRC, file));
    expect(direct).toEqual([]);
  });
});
