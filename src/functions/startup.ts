import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { runMigrations } from "../migrate";
import { corsHeaders } from "../cors";
import { initSentry, Sentry } from "../sentry";
import { extractToken, oidFromToken, userInfoFromToken } from "../auth";

initSentry();

// Refuse to boot if production + dev role override would coexist. That
// combination lets any caller spoof roles via the X-Dev-Roles header and
// must never reach a deployed environment.
if (
  process.env.AZURE_FUNCTIONS_ENVIRONMENT === "Production" &&
  process.env.DEV_ROLE_OVERRIDE_ENABLED === "true"
) {
  throw new Error(
    "Refusing to start: DEV_ROLE_OVERRIDE_ENABLED is true in a Production environment. Unset it in the Function App configuration.",
  );
}

// Capture any error thrown from a handler. Azure Functions are short-lived,
// so we must await Sentry.flush() — without it the worker can be torn down
// before the event leaves the process.
app.hook.postInvocation(async (hookContext) => {
  if (!hookContext.error) return;
  const request = hookContext.inputs[0] as HttpRequest | undefined;
  Sentry.withScope((scope) => {
    scope.setTag("function", hookContext.invocationContext.functionName);
    if (request) {
      // Strip credential-bearing headers before handing them to Sentry —
      // otherwise the bearer token (and our X-App-Token) ship out with every
      // captured exception. Match case-insensitively because Functions' header
      // iterator may surface either casing depending on the runtime.
      const REDACTED_HEADERS = new Set([
        "authorization",
        "x-app-token",
        "cookie",
        "proxy-authorization",
      ]);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? "[redacted]" : value;
      });
      scope.setSDKProcessingMetadata({
        normalizedRequest: {
          method: request.method,
          url: request.url,
          headers,
        },
      });

      const token = extractToken(request);
      if (token) {
        const oid = oidFromToken(token);
        const userInfo = userInfoFromToken(token);
        if (oid || userInfo) {
          scope.setUser({
            id: oid ?? undefined,
            email: userInfo?.email,
            username: userInfo?.name,
          });
        }
      }
    }
    Sentry.captureException(hookContext.error);
  });
  await Sentry.flush(2000);
});

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
