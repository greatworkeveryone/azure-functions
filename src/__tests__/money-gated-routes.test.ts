/// <reference types="jest" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { MONEY_GATED_ROUTES } from "../money-gated-routes";

// The money-gate list and the handlers stay in step both ways (S11): every
// listed route's handler calls requireMoneyContext right after its role check
// and returns its refusal, nothing reads the body or the database before it,
// and every handler that calls it is listed. Reads source as text, with
// comments stripped, so a call that is commented out does not count.

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

/** Code without comments; `://` inside a string (a URL) is not a comment. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// The call and its early return, back to back: `void gate`, a dropped result or
// anything in between fails.
const GATE_CALL = /const\s+gate\s*=\s*await\s+requireMoneyContext\(request\b[^;]*;\s*if\s*\(gate\)\s*return\s+gate;/;

// Nothing that reads the request body or touches the database may come before it.
const MUST_FOLLOW_GATE = [
  "createRequestConnection(",
  "createServiceRequestConnection(",
  "createServiceConnection(",
  "createConnection(",
  "executeQuery(",
  "beginTransaction(",
  "request.json()",
  "request.text()",
  "request.formData()",
  "request.arrayBuffer()",
];

/** What is wrong with a handler's gate placement; empty when nothing is. */
function gatePlacementProblems(handlerText: string): string[] {
  const code = stripComments(handlerText);
  const call = code.search(GATE_CALL);
  if (call === -1) return ["no `const gate = await requireMoneyContext(request…); if (gate) return gate;`"];
  const problems: string[] = [];
  const role = code.includes("requireRole(request") ? code.indexOf("requireRole(request") : code.indexOf("rolesForRequest(request");
  if (role === -1 || role > call) problems.push("no role check before the gate");
  for (const later of MUST_FOLLOW_GATE) {
    const at = code.indexOf(later);
    if (at !== -1 && at < call) problems.push(`${later} before the gate`);
  }
  return problems;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("money-gated routes", () => {
  it("lists the twenty-eight money endpoints that exist today: the sixteen that existed before MYOB was gated, WP26's four rent review decisions, WP26c's two schedule change decisions, R13's variance margin, J6b's director quote approval, the emailed quote decision, the seven MYOB routes, WP32's option exercise and WP33's renewal decision", () => {
    expect(MONEY_GATED_ROUTES.map((r) => r.route)).toEqual([
      "setApprovalLimit",
      "setApprovalFact",
      "upsertPayment",
      "markPaymentPaid",
      "directorApproveJobInvoice",
      "directorApproveQuote",
      "markJobInvoiceMyobCreated",
      "unmarkJobInvoiceMyobCreated",
      "markPurchaseOrderMyobCreated",
      "unmarkPurchaseOrderMyobCreated",
      "sendPurchaseOrder",
      "undoDirectorApproveJobInvoice",
      "submitRentReview",
      "approveRentReview",
      "waiveRentReview",
      "revertRentReview",
      "ratifyScheduleChange",
      "rejectScheduleChange",
      "recordEmailQuoteDecision",
      "approveAndSendToMyob",
      "proposeToMyob",
      "setMyobControl",
      "setMyobFileMode",
      "registerMyobCompanyFile",
      "importMyobMappings",
      "acceptMyobBaseline",
      "approveOptionExercise",
      "recordRenewalOutcome",
    ]);
  });

  it.each(MONEY_GATED_ROUTES.filter((r) => !r.via).map((r) => [r.route, r.file]))("%s calls requireMoneyContext right after its role check", (route, file) => {
    const source = read(file);
    const handler = handlerFor(source, route);
    expect(handler).not.toBeNull();
    expect(gatePlacementProblems(body(source, handler as string))).toEqual([]);
  });

  // Routes that reach the gate through a shared wrapper: the wrapper's gate is
  // placed right, and the handler opts in without reading its body first.
  const wrapped = MONEY_GATED_ROUTES.filter((r) => r.via);
  const wrapperBody = (via: string): string => {
    const source = read(via);
    const name = via.endsWith("proposalHttp.ts") ? "withCaller" : "runControllerAction";
    const start = source.search(new RegExp(`async function ${name}\\b`));
    return source.slice(start, source.indexOf("\n}\n", start) + 3);
  };

  it.each([...new Set(wrapped.map((r) => r.via as string))])("%s places the gate after the role check and before any connection or body read", (via) => {
    expect(gatePlacementProblems(wrapperBody(via))).toEqual([]);
  });

  it.each(wrapped.map((r) => [r.route, r.file, r.via as string]))("%s opts in to its wrapper's gate", (route, file, via) => {
    const source = stripComments(read(file));
    const handler = handlerFor(source, route) as string;
    expect(handler).not.toBeNull();
    const at = source.search(new RegExp(`function ${handler}\\(`));
    const text = source.slice(at, source.indexOf("app.http(", at));
    if (via.endsWith("proposalHttp.ts")) {
      expect(text).toMatch(/withCaller\([\s\S]*\},\s*\{\s*allowed:/);
      expect(text.indexOf("withCaller(")).toBeLessThan(text.indexOf("request.json()"));
    } else {
      expect(text).toMatch(/runControllerAction\([^)]*,\s*\{[\s\S]*?\bmoneyGate: true,/);
    }
  });

  it("has no gated handler missing from the list", () => {
    const listed = new Set(MONEY_GATED_ROUTES.map((r) => r.route));
    for (const full of sourceFiles(join(ROOT, "src", "functions"))) {
      const source = stripComments(readFileSync(full, "utf8"));
      if (!source.includes("requireMoneyContext(")) continue;
      for (const match of source.matchAll(/app\.http\("(\w+)"[^)]*handler:\s*(\w+)/g)) {
        const [, route, handler] = match;
        if (body(source, handler).includes("requireMoneyContext(")) {
          expect({ file: relative(ROOT, full), listed: listed.has(route), route }).toEqual({ file: relative(ROOT, full), listed: true, route });
        }
      }
    }
  });

  // The checker itself, against the mutations review-s2 showed slipping through.
  describe("the placement check", () => {
    const head = `async function h(request) {
  const token = extractToken(request);
  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL]);
  if (denied) return denied;
`;
    const gate = `  const gate = await requireMoneyContext(request);
  if (gate) return gate;
`;
    const tail = `  const body = await request.json();
  connection = await createRequestConnection(token);
}`;

    it("accepts the real shape", () => {
      expect(gatePlacementProblems(head + gate + tail)).toEqual([]);
    });

    it.each([
      ["the result ignored", head + "  const gate = await requireMoneyContext(request);\n  void gate;\n" + tail],
      ["the call only in a line comment", head + "  // const gate = await requireMoneyContext(request); if (gate) return gate;\n" + tail],
      ["the call only in a block comment", head + "  /* const gate = await requireMoneyContext(request);\n  if (gate) return gate; */\n" + tail],
      ["a statement between the call and its return", head + "  const gate = await requireMoneyContext(request);\n  log(gate);\n  if (gate) return gate;\n" + tail],
      ["a service connection first", head + "  const c = await createServiceRequestConnection();\n" + gate + tail],
      ["a query first", head + "  await executeQuery(c, 'SELECT 1');\n" + gate + tail],
      ["the body read as text first", head + "  const raw = await request.text();\n" + gate + tail],
      ["the body read as JSON first", head + "  const b = await request.json();\n" + gate + tail],
      ["no role check before it", "async function h(request) {\n" + gate + "  const denied = await requireRole(request, []);\n" + tail],
    ])("rejects %s", (_name, text) => {
      expect(gatePlacementProblems(text)).not.toEqual([]);
    });
  });
});
