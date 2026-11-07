import { TYPES } from "tedious";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createServiceRequestConnection,
  executeQuery,
  rollbackTransaction,
} from "../db";
import { record } from "../ledger";
import { describeAnomaly, evaluateAccess, localClock, primaryAnomaly, type AccessKind, type AnomalyCode } from "./anomaly";
import { clientAddress, hashValue } from "./clientIp";
import { parseStoredProfile } from "./profile";
import { countForBurst, SAMPLE_INTERVAL_MS, shouldSampleRequest } from "./sampling";

// The access log (decision 15). Request handling never waits for it: the
// note* functions copy what they need from the request synchronously and hand
// the database work to setImmediate, so it runs after the response is decided
// and its failures are logged, never thrown. Flex Consumption can reclaim an
// instance right after a response, so an occasional sampled row may be lost;
// the money decision itself is in the decision ledger regardless.

export interface AccessObservation {
  at: Date;
  burst: boolean;
  country: string | null;
  /** The request carried an x-fp-country header at all. */
  countryClaimed: boolean;
  detail: Record<string, unknown> | null;
  /** A sign-in the browser says followed an interactive Microsoft login. */
  interactive: boolean;
  ipHash: string | null;
  kind: AccessKind;
  oid: string;
  userAgentHash: string | null;
}

interface HeaderSource {
  headers: { get(name: string): string | null };
}

const MONITOR_ACTOR = { kind: "system", name: "accessMonitor" } as const;
const DETAIL_MAX = 2000;
const LEDGER_REPEAT_MS = 6 * 60 * 60_000;
// registerSelf runs on every full page load, not only at the Microsoft sign-in.
// The browser marks the call that follows an interactive login (X-Fp-Signin);
// that is always a sign-in row. An unmarked call is a reload or a new tab, which
// is recorded only as a device's first appearance on a network in a day, so a
// token used from somewhere new still shows up even if that client never sends
// the mark. Sampled requests are likewise checked against the table, not only
// this instance's memory, so a second instance does not repeat the sample.
const SIGN_IN_BASELINE_HOURS = 24;
const SAMPLE_MINUTES = SAMPLE_INTERVAL_MS / 60_000;
const COUNTRY = /^[A-Z]{2}$/;

// ── Switch ───────────────────────────────────────────────────────────────────
// On unless ACCESS_LOG_ENABLED is "false" (Will's off switch). Off under Jest
// so the thousands of handler tests that run the real requireRole never see
// stray deferred database calls; this module's own tests turn it on.
let forced: boolean | null = null;

export function accessLoggingEnabled(): boolean {
  if (forced !== null) return forced;
  if (process.env.ACCESS_LOG_ENABLED === "false") return false;
  return process.env.NODE_ENV !== "test";
}

export function _setAccessLoggingForTests(enabled: boolean | null): void {
  forced = enabled;
}

// ── Capture (synchronous, on the request path) ───────────────────────────────

export function observationFromRequest(
  request: HeaderSource,
  oid: string,
  kind: AccessKind,
  extra: { burst?: boolean; detail?: Record<string, unknown> | null } = {},
): AccessObservation {
  const address = clientAddress(request);
  const userAgent = request.headers.get("user-agent")?.trim() || null;
  const claim = request.headers.get("x-fp-country")?.trim().toUpperCase() ?? "";
  return {
    at: new Date(),
    burst: extra.burst ?? false,
    // "XX" is the app saying it could not map the browser's zone: a claim, just an empty one.
    country: COUNTRY.test(claim) && claim !== "XX" ? claim : null,
    countryClaimed: claim !== "",
    detail: extra.detail ?? null,
    interactive: kind === "signin" && request.headers.get("x-fp-signin")?.trim().toLowerCase() === "interactive",
    ipHash: address ? hashValue("ip", address) : null,
    kind,
    oid,
    userAgentHash: userAgent ? hashValue("ua", userAgent) : null,
  };
}

function defer(observation: AccessObservation): void {
  setImmediate(() => {
    recordAccess(observation).catch((err: unknown) => {
      console.warn("[access] could not record an access event:", err instanceof Error ? err.message : String(err));
    });
  });
}

/** requireRole's hook: sampled, and only for callers with a role. The sample
 *  is per person *and* network *and* device, so someone using a stolen session
 *  from elsewhere gets their own row instead of hiding in the owner's. */
export function noteAccess(request: HeaderSource, oid: string | null, roles: readonly string[]): void {
  if (!oid || roles.length === 0 || !accessLoggingEnabled()) return;
  const now = Date.now();
  const burst = countForBurst(oid, now);
  const observation = observationFromRequest(request, oid, "request", { burst });
  const sampleKey = `${oid}|${observation.ipHash ?? "-"}|${observation.userAgentHash ?? "-"}`;
  if (!burst && !shouldSampleRequest(sampleKey, now)) return;
  defer(observation);
}

/** registerSelf: every sign-in. */
export function noteSignIn(request: HeaderSource, oid: string): void {
  if (!accessLoggingEnabled()) return;
  defer(observationFromRequest(request, oid, "signin"));
}

/** The money gate: every money action, with the gate's outcome in Detail. */
export function noteMoneyAction(request: HeaderSource, oid: string, detail: Record<string, unknown>): void {
  if (!accessLoggingEnabled()) return;
  defer(observationFromRequest(request, oid, "money", { detail }));
}

// ── Record (deferred) ────────────────────────────────────────────────────────

const SELECT_CONTEXT = `SELECT u.UserID, u.Role, u.AccessProfile,
    CASE WHEN EXISTS (SELECT 1 FROM dbo.AccessEvents e
                       WHERE e.Oid = @Oid AND e.UserAgentHash = @UserAgentHash
                         AND e.At >= DATEADD(DAY, -90, SYSUTCDATETIME())) THEN 1 ELSE 0 END AS DeviceSeen,
    CASE WHEN EXISTS (SELECT 1 FROM dbo.AccessEvents e
                       WHERE e.Oid = @Oid AND e.IpHash = @IpHash
                         AND e.At >= DATEADD(DAY, -90, SYSUTCDATETIME())) THEN 1 ELSE 0 END AS NetworkSeen,
    CASE WHEN EXISTS (SELECT 1 FROM dbo.AccessEvents e WHERE e.Oid = @Oid) THEN 1 ELSE 0 END AS HasHistory,
    CASE WHEN EXISTS (SELECT 1 FROM dbo.AccessEvents e
                       WHERE e.Oid = @Oid AND e.Kind = 'signin'
                         AND ((e.UserAgentHash = @UserAgentHash) OR (e.UserAgentHash IS NULL AND @UserAgentHash IS NULL))
                         AND ((e.IpHash = @IpHash) OR (e.IpHash IS NULL AND @IpHash IS NULL))
                         AND e.At >= DATEADD(HOUR, -@SignInBaselineHours, SYSUTCDATETIME())) THEN 1 ELSE 0 END AS SignInSeenToday,
    CASE WHEN EXISTS (SELECT 1 FROM dbo.AccessEvents e
                       WHERE e.Oid = @Oid AND e.Kind = 'request'
                         AND ((e.UserAgentHash = @UserAgentHash) OR (e.UserAgentHash IS NULL AND @UserAgentHash IS NULL))
                         AND ((e.IpHash = @IpHash) OR (e.IpHash IS NULL AND @IpHash IS NULL))
                         AND e.At >= DATEADD(MINUTE, -@SampleMinutes, SYSUTCDATETIME())) THEN 1 ELSE 0 END AS RequestSeenRecently
  FROM (SELECT 1 AS One) AS anchor
  OUTER APPLY (SELECT TOP 1 UserID, Role, AccessProfile FROM dbo.AppUsers
                WHERE EntraOid = @Oid AND IsActive = 1) AS u`;

const INSERT_EVENT = `INSERT INTO dbo.AccessEvents
  (Oid, Role, At, IpHash, Country, City, UserAgentHash, LocalHour, Kind, Anomaly, Detail)
 VALUES
  (@Oid, @Role, @At, @IpHash, @Country, NULL, @UserAgentHash, @LocalHour, @Kind, @Anomaly, @Detail)`;

// One ledger row per person and finding every few hours, per instance: an
// officer on an all-night call-out shouldn't fill the exceptions view. Every
// finding is still in AccessEvents and the daily report.
const lastLedgered = new Map<string, number>();

function recentlyLedgered(key: string, now: number): boolean {
  const last = lastLedgered.get(key);
  return last !== undefined && now - last < LEDGER_REPEAT_MS;
}

export function _resetAccessLedgerMemoForTests(): void {
  lastLedgered.clear();
}

/** A repeat the table already holds: an unmarked sign-in from a device and network seen today, or a
 *  sampled request another instance recorded in the last 15 minutes. Bursts are always written. */
function alreadyRecorded(observation: AccessObservation, context: Record<string, unknown>): boolean {
  if (observation.kind === "signin") return !observation.interactive && context.SignInSeenToday === 1;
  if (observation.kind === "request") return !observation.burst && context.RequestSeenRecently === 1;
  return false;
}

function detailText(detail: Record<string, unknown>): string | null {
  if (Object.keys(detail).length === 0) return null;
  const text = JSON.stringify(detail);
  return text.length <= DETAIL_MAX ? text : JSON.stringify({ truncated: true });
}

/** Evaluates the rules for one observation and writes it (with its ledger row
 *  when it is an anomaly). Throws on a database failure; callers defer it. */
export async function recordAccess(observation: AccessObservation): Promise<{ anomaly: AnomalyCode | "none" }> {
  const connection = await createServiceRequestConnection();
  try {
    const rows = await executeQuery(connection, SELECT_CONTEXT, [
      { name: "Oid", type: TYPES.NVarChar, value: observation.oid },
      { name: "UserAgentHash", type: TYPES.VarChar, value: observation.userAgentHash },
      { name: "IpHash", type: TYPES.VarChar, value: observation.ipHash },
      { name: "SignInBaselineHours", type: TYPES.Int, value: SIGN_IN_BASELINE_HOURS },
      { name: "SampleMinutes", type: TYPES.Int, value: SAMPLE_MINUTES },
    ]);
    const context = rows[0] ?? {};
    if (alreadyRecorded(observation, context)) return { anomaly: "none" };
    const role = (context.Role as string | null | undefined)?.toLowerCase() ?? null;
    const userId = (context.UserID as number | null | undefined) ?? null;
    const profile = parseStoredProfile((context.AccessProfile as string | null | undefined) ?? null, role);
    const facts = {
      at: observation.at,
      burst: observation.burst,
      country: observation.country,
      countryClaimed: observation.countryClaimed,
      deviceSeen: observation.userAgentHash === null || context.DeviceSeen === 1,
      hasHistory: context.HasHistory === 1,
      kind: observation.kind,
      networkSeen: observation.ipHash === null || context.NetworkSeen === 1,
      profile,
      role,
    };
    const codes = evaluateAccess(facts);
    const anomaly = primaryAnomaly(codes);
    const detail = {
      ...(observation.detail ?? {}),
      ...(observation.kind === "signin" ? { how: observation.interactive ? "interactive" : "session" } : {}),
      ...(observation.burst ? { burst: true } : {}),
      ...(codes.length > 1 ? { alsoFlagged: codes.slice(1) } : {}),
    };
    const params = [
      { name: "Oid", type: TYPES.NVarChar, value: observation.oid },
      { name: "Role", type: TYPES.NVarChar, value: role },
      { name: "At", type: TYPES.DateTime2, value: observation.at },
      { name: "IpHash", type: TYPES.VarChar, value: observation.ipHash },
      { name: "Country", type: TYPES.NVarChar, value: observation.country },
      { name: "UserAgentHash", type: TYPES.VarChar, value: observation.userAgentHash },
      { name: "LocalHour", type: TYPES.TinyInt, value: localClock(observation.at, profile.timeZone).hour },
      { name: "Kind", type: TYPES.NVarChar, value: observation.kind },
      { name: "Anomaly", type: TYPES.NVarChar, value: anomaly },
      { name: "Detail", type: TYPES.NVarChar, value: detailText(detail) },
    ];

    if (anomaly !== "none") {
      // One trace line per finding: the App Insights alert rules in
      // docs/runbooks/monitoring.md match on this prefix. No names, no address.
      console.warn(
        `[access] anomaly ${JSON.stringify({ alsoFlagged: codes.slice(1), anomaly, country: observation.country, kind: observation.kind, role, userId })}`,
      );
    }

    const memoKey = `${observation.oid}:${anomaly}`;
    const now = observation.at.getTime();
    if (anomaly === "none" || recentlyLedgered(memoKey, now)) {
      await executeQuery(connection, INSERT_EVENT, params);
      return { anomaly };
    }

    // The event and its exception commit together, like any other decision.
    await beginTransaction(connection);
    try {
      await executeQuery(connection, INSERT_EVENT, params);
      await record(connection, {
        action: "access.anomaly",
        actor: MONITOR_ACTOR,
        after: { anomaly, country: observation.country, kind: observation.kind, role, ...detail },
        reason: describeAnomaly(anomaly, facts),
        ruleApplied: anomaly,
        subject: { id: userId ?? observation.oid, type: "app_user" },
      });
      await commitTransaction(connection);
      lastLedgered.set(memoKey, now);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
    return { anomaly };
  } finally {
    closeConnection(connection);
  }
}
