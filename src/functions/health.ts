import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { clientAddress, forwardedSummary } from "../access/clientIp";
import { TYPES, type Connection } from "tedious";
import { AppRole, requireRole } from "../auth";
import { apiAudienceMode, audienceConfigProblem } from "../apiAudience";
import { forbiddenSettingsSet, missingSettings } from "../config/envContract";
import { closeConnection, createServiceRequestConnection, executeQuery } from "../db";
import { isAllowedNetwork, moneyGateConfig } from "../moneyGate";
import { checkMigrations } from "../migrate";
import { teamsAlertsReadiness } from "../teams/config";
import { TIMER_NAMES } from "../timerRuns";

// Captured once at module load so the value reflects when the worker started.
const startedAt = new Date().toISOString();

// Build metadata read from env vars set by the deployment pipeline. Falls back
// to "unknown" when running locally without these set.
//   BUILD_SHA            — short git SHA, set by CI on every build (auto-increments per commit)
//   BUILD_TIME           — ISO timestamp of the build, set by CI
//   WEBSITE_DEPLOYMENT_ID — Azure-supplied deployment id (set automatically by Azure on each deploy)
const commit = process.env.BUILD_SHA ?? "unknown";
const builtAt = process.env.BUILD_TIME ?? "unknown";
const deploymentId = process.env.WEBSITE_DEPLOYMENT_ID ?? "unknown";

// Last TimerRuns row per timer; a timer that never ran comes back with NULLs.
const LAST_TIMER_RUNS_SQL = `SELECT n.value AS Name, r.StartedAt, r.FinishedAt, r.Outcome, r.Error
  FROM STRING_SPLIT(@Names, N',') n
  OUTER APPLY (SELECT TOP 1 t.StartedAt, t.FinishedAt, t.Outcome, t.Error
                 FROM dbo.TimerRuns t
                WHERE t.Name = n.value
                ORDER BY t.StartedAt DESC, t.TimerRunId DESC) r`;

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : null);

async function lastTimerRuns(connection: Connection, context: InvocationContext) {
  try {
    const rows = await executeQuery(connection, LAST_TIMER_RUNS_SQL, [
      { name: "Names", type: TYPES.NVarChar, value: TIMER_NAMES.join(",") },
    ]);
    return rows.map((r) => ({
      lastRun: r.StartedAt
        ? { error: (r.Error as string | null) ?? null, finishedAt: iso(r.FinishedAt), outcome: r.Outcome as string, startedAt: iso(r.StartedAt) }
        : null,
      name: r.Name as string,
    }));
  } catch (err) {
    context.warn("health: timer runs unavailable:", err);
    return "unavailable" as const;
  }
}

async function migrationStatus(context: InvocationContext) {
  try {
    const status = await checkMigrations(createServiceRequestConnection);
    return {
      changed: status.changed.map((c) => c.name),
      pending: status.pending.map((f) => f.name),
      unverified: status.unverified.length,
    };
  } catch (err) {
    context.warn("health: migration check unavailable:", err);
    return "unavailable" as const;
  }
}

export async function health(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const deep = request.query.get("deep") === "true";

  // Shallow probe is intentionally minimal — exposing commit / deployment id
  // to unauthenticated callers leaks fingerprinting data. Anyone needing the
  // detail should hit ?deep=true with an admin token.
  if (!deep) return { status: 200, jsonBody: { ok: true } };

  const roleCheck = await requireRole(request, [AppRole.ADMIN]);
  if (roleCheck) return roleCheck;

  // S10/S11 probe: does the platform pass the client address, and would the
  // money gate accept this network? Shape and verdict only, never the address.
  // Will reads this from the office (docs/runbooks/monitoring.md).
  const gate = moneyGateConfig();
  const moneyNetwork = gate.mode === "warn" ? "unconfigured" : isAllowedNetwork(clientAddress(request), gate) ? "allowed" : "refused";
  context.log(`health: client address headers ${JSON.stringify({ ...forwardedSummary(request), moneyNetwork })}`);

  const base = {
    ok: true,
    commit,
    builtAt,
    deploymentId,
    startedAt,
    environment: process.env.AZURE_FUNCTIONS_ENVIRONMENT ?? "unknown",
  };

  // Deep check — actually touches SQL so an uptime monitor pinging
  // /api/health?deep=true alarms when the DB connection is broken even if
  // the function itself is happy. It also names what is quietly broken
  // (DL-12): missing settings, pending or edited migrations, failed timers.
  let connection;
  try {
    connection = await createServiceRequestConnection();
    await executeQuery(connection, "SELECT 1 AS Ok", []);
    const timers = await lastTimerRuns(connection, context);
    const migrations = await migrationStatus(context);
    const missing = missingSettings(process.env);
    const forbidden = forbiddenSettingsSet(process.env);
    const alerts = teamsAlertsReadiness(process.env);
    const ok =
      !missing.some((m) => m.requiredInProd) &&
      alerts.problem === null &&
      !forbidden.some((f) => f.severity === "error") &&
      audienceConfigProblem(process.env) === null &&
      (migrations === "unavailable" || (migrations.pending.length === 0 && migrations.changed.length === 0)) &&
      (timers === "unavailable" || !timers.some((t) => t.lastRun?.outcome === "error"));
    return {
      status: 200,
      jsonBody: { ...base, ok, alerts, apiTokenAudience: apiAudienceMode(process.env), db: "ok", migrations, settings: { missing, forbidden }, timers },
    };
  } catch (err) {
    // Log the full error server-side so on-call can diagnose, but never
    // surface the message to the caller — it can leak server/topology info.
    context.error("health deep check failed:", err);
    return {
      status: 503,
      jsonBody: { ok: false, db: "error" },
    };
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("health", { methods: ["GET"], authLevel: "anonymous", handler: health });
