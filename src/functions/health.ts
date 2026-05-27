import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
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

async function health(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  const deep = request.query.get("deep") === "true";

  const base = {
    ok: true,
    commit,
    builtAt,
    deploymentId,
    startedAt,
    environment: process.env.AZURE_FUNCTIONS_ENVIRONMENT ?? "unknown",
  };

  if (!deep) return { status: 200, jsonBody: base };

  // Deep check — actually touches SQL so an uptime monitor pinging
  // /api/health?deep=true alarms when the DB connection is broken even if
  // the function itself is happy.
  let connection;
  try {
    connection = await createServiceConnection();
    await executeQuery(connection, "SELECT 1 AS Ok", []);
    return { status: 200, jsonBody: { ...base, db: "ok" } };
  } catch (err) {
    return {
      status: 503,
      jsonBody: { ...base, ok: false, db: "error", error: (err as Error).message },
    };
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("health", { methods: ["GET"], authLevel: "anonymous", handler: health });
