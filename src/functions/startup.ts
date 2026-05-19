import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { runMigrations } from "../migrate";
import { corsHeaders } from "../cors";

// Inject CORS headers into every HTTP response so browsers can call the API
// from the Static Web App origin without portal-level CORS config.
app.hook.postInvocation((hookContext) => {
  const result = hookContext.result as HttpResponseInit | undefined;
  if (!result || typeof result !== "object") return;

  const request = hookContext.inputs[0] as HttpRequest | undefined;
  if (!request?.headers) return;

  const origin = request.headers.get("origin") ?? "";
  hookContext.result = {
    ...result,
    headers: { ...result.headers, ...corsHeaders(origin) },
  };
});

// Runs once when the function app initialises, before any requests are served.
// If migrations fail the app refuses to start — better than serving requests
// against a schema that's out of date.
app.hook.appStart(async (_context) => {
  const isProduction = process.env.AZURE_FUNCTIONS_ENVIRONMENT === "Production";
  const isLocalSql = process.env.LOCAL_SQL === "true";

  // Run migrations in production (Azure SQL) and when using the local Docker DB
  // (SA account has full DDL). Skip otherwise — Azure SQL per-user accounts
  // don't have DDL permissions in dev.
  if (!isProduction && !isLocalSql) {
    console.log("startup: skipping migrations (not Azure and not local Docker DB)");
    return;
  }
  console.log("startup: running migrations");
  await runMigrations((msg) => console.log(msg));
  console.log("startup: migrations complete");
});
