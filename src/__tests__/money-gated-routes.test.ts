/// <reference types="jest" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { MONEY_GATED_ROUTES } from "../money-gated-routes";

// The money-gate list and the handlers stay in step both ways (S11): every
// listed route's handler calls requireMoneyContext right after its role check,
// and every handler that calls it is listed. Reads source as text.

const ROOT = join(__dirname, "..", "..");

function read(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

/** The handler function name registered for `route` in `source`. */
function handlerFor(source: string, route: string): string | null {
  const start = source.indexOf(`app.http("${route}"`);
  if (start === -1) return null;
  const registration = source.slice(start, source.indexOf(")", start) + 1);
  return registration.match(/handler:\s*(\w+)/)?.[1] ?? null;
}

/** The text of `async function name(...) { ... }` up to the next top-level function. */
function body(source: string, name: string): string {
  const start = source.search(new RegExp(`async function ${name}\\(`));
  if (start === -1) return "";
  const next = source.slice(start + 1).search(/\n(?:export )?(?:async )?function |\napp\.http\(/);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("money-gated routes", () => {
  it("lists the five money endpoints that exist today", () => {
    expect(MONEY_GATED_ROUTES.map((r) => r.route)).toEqual([
      "setApprovalLimit",
      "upsertPayment",
      "markPaymentPaid",
      "directorApproveJobInvoice",
      "markPurchaseOrderMyobCreated",
    ]);
  });

  it.each(MONEY_GATED_ROUTES.map((r) => [r.route, r.file]))("%s calls requireMoneyContext right after its role check", (route, file) => {
    const source = read(file);
    const handler = handlerFor(source, route);
    expect(handler).not.toBeNull();
    const text = body(source, handler as string);
    const gate = text.indexOf("requireMoneyContext(request");
    expect(gate).toBeGreaterThan(-1);
    // Nothing touches the database or reads the body before the gate.
    for (const later of ["createRequestConnection(", "request.json()", "beginTransaction("]) {
      const at = text.indexOf(later);
      if (at !== -1) expect(gate).toBeLessThan(at);
    }
    const roleCheck = text.includes("requireRole(request") ? text.indexOf("requireRole(request") : text.indexOf("rolesForRequest(request");
    expect(roleCheck).toBeGreaterThan(-1);
    expect(roleCheck).toBeLessThan(gate);
  });

  it("has no gated handler missing from the list", () => {
    const listed = new Set(MONEY_GATED_ROUTES.map((r) => r.route));
    for (const full of sourceFiles(join(ROOT, "src", "functions"))) {
      const source = readFileSync(full, "utf8");
      if (!source.includes("requireMoneyContext(")) continue;
      for (const match of source.matchAll(/app\.http\("(\w+)"[^)]*handler:\s*(\w+)/g)) {
        const [, route, handler] = match;
        if (body(source, handler).includes("requireMoneyContext(")) {
          expect({ file: relative(ROOT, full), listed: listed.has(route), route }).toEqual({ file: relative(ROOT, full), listed: true, route });
        }
      }
    }
  });
});
