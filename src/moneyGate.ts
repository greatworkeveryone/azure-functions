import { BlockList, isIP } from "node:net";
import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { noteMoneyAction } from "./access/accessEvents";
import { clientAddress } from "./access/clientIp";
import { verifiedRequestClaims } from "./auth";
import { closeConnection, createServiceRequestConnection } from "./db";
import { MONEY_GATED_ROUTES } from "./money-gated-routes";

// The money-action gate (beta sprint S11, decision 16). A money action — a MYOB
// proposal, approval or update, a control change, an approval-limit change, a
// payment mark — needs all of:
//   1. a request from an allowed network: MONEY_ALLOWED_CIDRS (the office's
//      static egress and the approved remote-access egress);
//   2. a fresh sign-in: the token's auth_time (else iat) within
//      MONEY_STEP_UP_MINUTES (default 10), otherwise 428 step_up_required and
//      the frontend re-authenticates with prompt=login;
//   3. MFA: `amr` contains "mfa" (Entra sets it when MFA ran);
//   4. the attempt and its outcome in the access log (Kind: money).
// The gate is per endpoint, so inspections, keys and jobs keep working from
// phones anywhere. Handlers call requireMoneyContext right after requireRole;
// the list of gated routes is src/money-gated-routes.ts.
//
// With MONEY_ALLOWED_CIDRS unset the gate is in warn mode: every condition is
// still evaluated and logged, nothing is refused, and system.health tells admin
// the gate is open. That keeps staging (and production until O7 lands) working.

const DEFAULT_STEP_UP_MINUTES = 10;
const CLOCK_SKEW_SECONDS = 300;

export const NETWORK_REFUSED_MESSAGE =
  "This money action is allowed only from the office network or the approved remote connection.";
export const STEP_UP_MESSAGE = "Confirm it's you to continue: sign in again to send this.";

export type GateOutcome = "allowed" | "network_refused" | "step_up_mfa" | "step_up_stale" | "unauthenticated";

export interface MoneyGateConfig {
  allowed: BlockList;
  /** Well-formed entries in MONEY_ALLOWED_CIDRS. */
  entries: number;
  /** Entries that could not be read (ignored, logged). */
  invalid: string[];
  mode: "enforce" | "warn";
  stepUpMinutes: number;
}

function addEntry(list: BlockList, raw: string): boolean {
  const [address, prefixText, extra] = raw.split("/");
  const family = isIP(address);
  if (!family || extra !== undefined) return false;
  const type = family === 4 ? "ipv4" : "ipv6";
  if (prefixText === undefined) {
    list.addAddress(address, type);
    return true;
  }
  const prefix = Number(prefixText);
  if (!/^\d{1,3}$/.test(prefixText) || prefix > (family === 4 ? 32 : 128)) return false;
  list.addSubnet(address, prefix, type);
  return true;
}

export function moneyGateConfig(env: NodeJS.ProcessEnv = process.env): MoneyGateConfig {
  const allowed = new BlockList();
  const raw = (env.MONEY_ALLOWED_CIDRS ?? "").trim();
  const invalid: string[] = [];
  let entries = 0;
  for (const entry of raw.split(/[\s,]+/).filter(Boolean)) {
    if (addEntry(allowed, entry)) entries += 1;
    else invalid.push(entry);
  }
  const minutes = Number(env.MONEY_STEP_UP_MINUTES);
  return {
    allowed,
    entries,
    invalid,
    // Set but unreadable still means "enforce": refusing everything is safer
    // than silently opening the gate because of a typo.
    mode: raw === "" ? "warn" : "enforce",
    stepUpMinutes: Number.isInteger(minutes) && minutes >= 1 && minutes <= 60 ? minutes : DEFAULT_STEP_UP_MINUTES,
  };
}

export function isAllowedNetwork(address: string | null, config: MoneyGateConfig): boolean {
  if (!address) return false;
  const family = isIP(address);
  if (!family) return false;
  return config.allowed.check(address, family === 4 ? "ipv4" : "ipv6");
}

export interface GateInput {
  address: string | null;
  claims: Record<string, unknown> | null;
  config: MoneyGateConfig;
  nowSeconds: number;
}

/** Pure: every condition that fails, and the one the caller is told about. */
export function evaluateMoneyGate(input: GateInput): { failures: GateOutcome[]; outcome: GateOutcome } {
  const { claims, config, nowSeconds } = input;
  if (!claims) return { failures: ["unauthenticated"], outcome: "unauthenticated" };
  const failures: GateOutcome[] = [];
  if (!isAllowedNetwork(input.address, config)) failures.push("network_refused");

  const authTime = typeof claims.auth_time === "number" ? claims.auth_time : typeof claims.iat === "number" ? claims.iat : null;
  const age = authTime === null ? Infinity : nowSeconds - authTime;
  if (age > config.stepUpMinutes * 60 || age < -CLOCK_SKEW_SECONDS) failures.push("step_up_stale");

  const amr = Array.isArray(claims.amr) ? claims.amr : [];
  if (!amr.includes("mfa")) failures.push("step_up_mfa");

  return { failures, outcome: failures[0] ?? "allowed" };
}

// ── system.health while the gate is open ─────────────────────────────────────

let healthRaised = false;
let healthForced: boolean | null = null;

/** Test-only: null = default (off under Jest). */
export function _setMoneyGateHealthForTests(enabled: boolean | null): void {
  healthForced = enabled;
  healthRaised = false;
}

function raiseOpenGateHealthOnce(): void {
  const enabled = healthForced ?? process.env.NODE_ENV !== "test";
  if (!enabled || healthRaised) return;
  healthRaised = true;
  setImmediate(() => {
    void (async () => {
      // Loaded on first use only: the escalation engine is heavy for a cold start.
      const { raise } = await import("./escalation");
      await import("./escalation/adapters");
      const connection = await createServiceRequestConnection();
      try {
        await raise(connection, {
          actor: { kind: "system", name: "moneyGate" },
          policyKey: "system.health",
          skipConditionCheck: true,
          subjectId: "money_gate",
          subjectType: "system",
        });
      } finally {
        closeConnection(connection);
      }
    })().catch((err: unknown) => {
      healthRaised = false;
      console.warn("[money-gate] could not raise system.health:", err instanceof Error ? err.message : String(err));
    });
  });
}

// ── The handler call ─────────────────────────────────────────────────────────

/** The route name from the URL (/api/<name>), for the log only. */
function routeOf(request: HttpRequest): string {
  try {
    const path = new URL(request.url).pathname;
    return path.slice(path.lastIndexOf("/") + 1) || "unknown";
  } catch {
    return "unknown";
  }
}

export interface MoneyGateUser {
  oid?: string | null;
}

/**
 * Null when the money action may go ahead, else the response to return. Call
 * it right after requireRole. `user` is optional: the oid is otherwise read
 * from the verified token.
 */
export async function requireMoneyContext(request: HttpRequest, user?: MoneyGateUser | null): Promise<HttpResponseInit | null> {
  const config = moneyGateConfig();
  const claims = await verifiedRequestClaims(request);
  const { failures, outcome } = evaluateMoneyGate({
    address: clientAddress(request),
    claims,
    config,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  const route = routeOf(request);
  const oid = user?.oid ?? (typeof claims?.oid === "string" ? claims.oid : null);
  const recorded = config.mode === "warn" && outcome !== "allowed" && outcome !== "unauthenticated" ? "allowed_warn_only" : outcome;
  const label = MONEY_GATED_ROUTES.find((entry) => entry.route === route)?.label ?? null;
  if (oid) noteMoneyAction(request, oid, { failures, label, mode: config.mode, outcome: recorded, route });

  if (config.invalid.length > 0) console.warn(`[money-gate] ignored unreadable MONEY_ALLOWED_CIDRS entries: ${config.invalid.join(", ")}`);

  // Warn mode never refuses: requireRole has already decided who the caller is.
  if (config.mode === "warn") {
    raiseOpenGateHealthOnce();
    if (failures.length > 0) console.warn(`[money-gate] warn-only: ${route} would be refused (${failures.join(", ")})`);
    return null;
  }

  if (outcome === "allowed") return null;
  if (outcome === "unauthenticated") return { jsonBody: { error: "No valid sign-in for this money action" }, status: 401 };
  console.warn(`[money-gate] refused ${route}: ${failures.join(", ")}`);
  if (outcome === "network_refused") {
    return { jsonBody: { code: "money_network_required", error: NETWORK_REFUSED_MESSAGE }, status: 403 };
  }
  return {
    jsonBody: {
      code: "step_up_required",
      error: STEP_UP_MESSAGE,
      maxAgeMinutes: config.stepUpMinutes,
      reason: outcome === "step_up_mfa" ? "mfa_missing" : "stale_sign_in",
    },
    status: 428,
  };
}
