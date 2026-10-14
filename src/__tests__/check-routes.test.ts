/// <reference types="jest" />
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface RouteRow {
  file: string;
  gate: "role" | "public" | "none";
  inline: boolean;
  methods: string[];
  name: string;
  note: string;
  roles: string[];
  route: string;
}

const script = path.resolve(__dirname, "../../scripts/check-routes.cjs");
const repoRoot = path.resolve(__dirname, "../..");
const { checkRoutes } = require(script) as {
  checkRoutes: (root: string, publicRoutes?: Record<string, string>) => RouteRow[];
};

const AUTH = `
export enum AppRole { ADMIN = "admin", DIRECTOR = "director", FACILITIES = "facilities", ACCOUNTS = "accounts", USER = "user" }
export async function requireRole(_r: unknown, _allowed: readonly AppRole[]) { return null; }
export async function rolesForRequest(_r: unknown): Promise<string[]> { return []; }
`;

/** Writes a throwaway repo layout: { "src/functions/a.ts": "..." } */
function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-routes-"));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

function byName(rows: RouteRow[], name: string): RouteRow {
  const row = rows.find((r) => r.name === name);
  if (!row) throw new Error(`route ${name} not found in ${rows.map((r) => r.name).join(", ")}`);
  return row;
}

describe("check-routes", () => {
  it("reads methods, route and roles from a plain registration", () => {
    const root = fixture({
      "src/auth.ts": AUTH,
      "src/functions/jobs.ts": `
        import { app } from "@azure/functions";
        import { AppRole, requireRole } from "../auth";
        async function getJob(request: unknown) {
          const denied = await requireRole(request, [AppRole.ADMIN, AppRole.DIRECTOR]);
          if (denied) return denied;
          return { status: 200 };
        }
        app.http("getJob", { methods: ["GET"], authLevel: "anonymous", handler: getJob });
      `,
    });
    const row = byName(checkRoutes(root), "getJob");
    expect(row).toMatchObject({ gate: "role", methods: ["GET"], roles: ["ADMIN", "DIRECTOR"], route: "getJob" });
  });

  it("honours a custom route and any property order across lines", () => {
    const root = fixture({
      "src/auth.ts": AUTH,
      "src/functions/packet.ts": `
        import { app } from "@azure/functions";
        import { AppRole, requireRole } from "../auth";
        async function packet(request: unknown) { return requireRole(request, [AppRole.FACILITIES]); }
        app.http("getJobPacketPdf", {
          handler: packet,
          route: "jobs/{jobId}/packet",
          methods: ["GET", "POST"],
          authLevel: "anonymous",
        });
      `,
    });
    expect(byName(checkRoutes(root), "getJobPacketPdf")).toMatchObject({
      methods: ["GET", "POST"],
      route: "jobs/{jobId}/packet",
    });
  });

  it("flags a route whose handler never checks a role", () => {
    const root = fixture({
      "src/functions/open.ts": `
        import { app } from "@azure/functions";
        async function open() { return { status: 200 }; }
        app.http("openRoute", { methods: ["GET"], authLevel: "anonymous", handler: open });
      `,
    });
    expect(byName(checkRoutes(root), "openRoute")).toMatchObject({ gate: "none", roles: [] });
  });

  it("finds a role check inside a helper the handler calls", () => {
    const root = fixture({
      "src/auth.ts": AUTH,
      "src/functions/viaHelper.ts": `
        import { app } from "@azure/functions";
        import { AppRole, requireRole } from "../auth";
        async function guard(request: unknown) { return requireRole(request, [AppRole.ACCOUNTS]); }
        async function handler(request: unknown) {
          const denied = await guard(request);
          return denied ?? { status: 200 };
        }
        app.http("viaHelper", { methods: ["POST"], authLevel: "anonymous", handler });
      `,
    });
    expect(byName(checkRoutes(root), "viaHelper")).toMatchObject({ gate: "role", roles: ["ACCOUNTS"] });
  });

  it("resolves role lists from constants, imported constants and spreads", () => {
    const root = fixture({
      "src/auth.ts": AUTH,
      "src/roles.ts": `
        import { AppRole } from "./auth";
        export const READ_ROLES = [AppRole.FACILITIES, AppRole.ACCOUNTS] as const;
      `,
      "src/functions/lists.ts": `
        import { app } from "@azure/functions";
        import { AppRole, requireRole } from "../auth";
        import { READ_ROLES } from "../roles";
        const WRITE = [...READ_ROLES, AppRole.ADMIN];
        async function read(request: unknown) { return requireRole(request, READ_ROLES); }
        async function write(request: unknown) { return requireRole(request, WRITE); }
        app.http("readThing", { methods: ["GET"], authLevel: "anonymous", handler: read });
        app.http("writeThing", { methods: ["POST"], authLevel: "anonymous", handler: write });
      `,
    });
    const rows = checkRoutes(root);
    expect(byName(rows, "readThing").roles).toEqual(["FACILITIES", "ACCOUNTS"]);
    expect(byName(rows, "writeThing").roles).toEqual(["FACILITIES", "ACCOUNTS", "ADMIN"]);
  });

  it("follows a roles parameter through a shared authorize() helper in another module", () => {
    const root = fixture({
      "src/auth.ts": AUTH,
      "src/support.ts": `
        import { AppRole, requireRole } from "./auth";
        export const VIEW_ROLES = [AppRole.FACILITIES, AppRole.DIRECTOR];
        export async function authorize(request: unknown, roles: readonly AppRole[]) {
          return requireRole(request, roles);
        }
      `,
      "src/functions/assets.ts": `
        import { app } from "@azure/functions";
        import { authorize, VIEW_ROLES } from "../support";
        async function getThing(request: unknown) { return authorize(request, VIEW_ROLES); }
        app.http("getThing", { methods: ["GET"], authLevel: "anonymous", handler: getThing });
      `,
    });
    expect(byName(checkRoutes(root), "getThing")).toMatchObject({ gate: "role", roles: ["FACILITIES", "DIRECTOR"] });
  });

  it("accepts an inline rolesForRequest comparison and says so", () => {
    const root = fixture({
      "src/auth.ts": AUTH,
      "src/functions/inline.ts": `
        import { app } from "@azure/functions";
        import { AppRole, rolesForRequest } from "../auth";
        async function setLimit(request: unknown) {
          const roles = await rolesForRequest(request);
          if (!roles.includes(AppRole.ADMIN)) return { status: 403 };
          return { status: 200 };
        }
        app.http("setLimit", { methods: ["POST"], authLevel: "anonymous", handler: setLimit });
      `,
    });
    expect(byName(checkRoutes(root), "setLimit")).toMatchObject({ gate: "role", inline: true, roles: [] });
  });

  it("treats a listed public route as public, and nothing else", () => {
    const files = {
      "src/functions/hook.ts": `
        import { app } from "@azure/functions";
        async function hook() { return { status: 202 }; }
        async function other() { return { status: 200 }; }
        app.http("webhook", { methods: ["POST"], authLevel: "anonymous", handler: hook });
        app.http("sneaky", { methods: ["POST"], authLevel: "anonymous", handler: other });
      `,
    };
    const rows = checkRoutes(fixture(files), { webhook: "validated by shared secret" });
    expect(byName(rows, "webhook")).toMatchObject({ gate: "public", note: "validated by shared secret" });
    expect(byName(rows, "sneaky").gate).toBe("none");
  });

  it("fails closed when the handler cannot be located", () => {
    const root = fixture({
      "src/functions/mystery.ts": `
        import { app } from "@azure/functions";
        import { handlerFromElsewhere } from "some-package";
        app.http("mystery", { methods: ["GET"], authLevel: "anonymous", handler: handlerFromElsewhere });
      `,
    });
    expect(byName(checkRoutes(root), "mystery")).toMatchObject({ gate: "none" });
    expect(byName(checkRoutes(root), "mystery").note).toContain("handlerFromElsewhere");
  });

  it("ignores tests, declaration files and non-http registrations", () => {
    const root = fixture({
      "src/functions/a.test.ts": `app.http("fromTest", { methods: ["GET"], handler: () => null });`,
      "src/functions/types.d.ts": `export declare const x: number;`,
      "src/functions/timer.ts": `
        import { app } from "@azure/functions";
        app.timer("nightly", { schedule: "0 0 * * * *", handler: async () => undefined });
      `,
    });
    expect(checkRoutes(root)).toEqual([]);
  });

  describe("command line", () => {
    const run = (root: string, ...args: string[]) =>
      spawnSync(process.execPath, [script, "--root", root, ...args], { encoding: "utf8" });

    it("exits 1 and names the gap when a route has no role check", () => {
      const root = fixture({
        "src/functions/open.ts": `
          import { app } from "@azure/functions";
          async function open() { return { status: 200 }; }
          app.http("openRoute", { methods: ["GET"], authLevel: "anonymous", handler: open });
        `,
      });
      const result = run(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("openRoute");
      expect(result.stderr).toContain("PUBLIC_ROUTES");
    });

    it("exits 0 and prints JSON for the frontend comparison when every route is gated", () => {
      const root = fixture({
        "src/auth.ts": AUTH,
        "src/functions/ok.ts": `
          import { app } from "@azure/functions";
          import { AppRole, requireRole } from "../auth";
          async function ok(request: unknown) { return requireRole(request, [AppRole.USER]); }
          app.http("okRoute", { methods: ["GET"], authLevel: "anonymous", handler: ok });
        `,
      });
      const result = run(root, "--json");
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout) as { routes: RouteRow[] };
      expect(parsed.routes.map((r) => r.name)).toEqual(["okRoute"]);
    });
  });

  it("prints the complete JSON list for this repository, not a pipe-sized prefix", () => {
    const result = spawnSync(process.execPath, [script, "--json", "--root", repoRoot], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { routes: RouteRow[] };
    expect(parsed.routes.length).toBe(checkRoutes(repoRoot).length);
  });

  it("holds for this repository: every route has a role check or is listed as public", () => {
    const rows = checkRoutes(repoRoot);
    expect(rows.length).toBeGreaterThan(150);
    expect(rows.filter((r) => r.gate === "none").map((r) => r.name)).toEqual([]);
    expect(byName(rows, "getJobs")).toMatchObject({ gate: "role", methods: ["GET"] });
    expect(byName(rows, "getJobPacketPdf").route).toBe("jobs/{jobId}/packet");
  });
});
