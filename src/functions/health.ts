import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AppRole, requireRole } from "../auth";
import { closeConnection, createServiceConnection, executeQuery } from "../db";

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

async function health(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const deep = request.query.get("deep") === "true";

  // Shallow probe is intentionally minimal — exposing commit / deployment id
  // to unauthenticated callers leaks fingerprinting data. Anyone needing the
  // detail should hit ?deep=true with an admin token.
  if (!deep) return { status: 200, jsonBody: { ok: true } };

  const roleCheck = await requireRole(request, [AppRole.ADMIN]);
  if (roleCheck) return roleCheck;

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
  // the function itself is happy.
  let connection;
  try {
    connection = await createServiceConnection();
    await executeQuery(connection, "SELECT 1 AS Ok", []);
    return { status: 200, jsonBody: { ...base, db: "ok" } };
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
