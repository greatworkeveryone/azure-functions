import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { checkMigrations, runMigrations, startupMigrationMode } from "../migrate";
import { resolveMigrationTarget } from "../migrate-cli";
import { createServiceRequestConnection } from "../db";
import { corsHeaders } from "../cors";
import { initSentry, Sentry } from "../sentry";
import { extractToken, oidFromToken } from "../auth";
import { audienceConfigProblem } from "../apiAudience";
import { devOverrideMisconfigured } from "../jwt";
import { forbiddenSettingsSet } from "../config/envContract";
import { sentryRequestContext } from "./sentryRequestContext";

initSentry();

// Refuse to boot if the dev role override is switched on anywhere it cannot
// apply — any Azure-hosted app, or a host not labelled Development. The switch
// is inert there (jwt.ts), but a set switch means someone expected a bypass.
if (devOverrideMisconfigured()) {
  throw new Error(
    "Refusing to start: DEV_ROLE_OVERRIDE_ENABLED is true outside local Development. Unset it in the Function App configuration.",
  );
}

// api-only bearers cannot be used to open a per-caller SQL connection, so the
// SQL_USER_CONNECTION rollback lever would silently break.
const audienceProblem = audienceConfigProblem();
if (audienceProblem) throw new Error(`Refusing to start: ${audienceProblem}`);

// Capture any error thrown from a handler. Azure Functions are short-lived,
// so we must await Sentry.flush() — without it the worker can be torn down
// before the event leaves the process.
app.hook.postInvocation(async (hookContext) => {
  if (!hookContext.error) return;
  const request = hookContext.inputs[0] as HttpRequest | undefined;
  Sentry.withScope((scope) => {
    scope.setTag("function", hookContext.invocationContext.functionName);
    if (request) {
      const { normalizedRequest, user } = sentryRequestContext(request, extractToken(request), oidFromToken);
      scope.setSDKProcessingMetadata({ normalizedRequest });
      if (user) scope.setUser(user);
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
// Production only checks (DL-11): the app identity has no DDL rights, and
// migrations are applied by hand with `npm run migrate -- --apply`. A pending
// or changed migration is logged and sent to Sentry; it never stops the API.
// RUN_MIGRATIONS_ON_STARTUP=true (and local Docker) apply instead, and then a
// failure refuses to start rather than serve a half-migrated schema.
/* eslint-disable no-console -- startup migration diagnostics; the Functions request logger isn't available in the appStart hook, and no request data is logged */
app.hook.appStart(async (_context) => {
  const forbidden = forbiddenSettingsSet(process.env);
  if (forbidden.length > 0) {
    const names = forbidden.map((f) => f.name).join(", ");
    console.warn(`startup: settings that must be unset in Production: ${names}`);
    Sentry.captureMessage(`Settings that must be unset in Production: ${names}`, "warning");
  }
  const mode = startupMigrationMode(process.env);
  const log = (msg: string) => console.log(msg);
  if (mode === "skip") {
    log("startup: skipping migrations (not Production and not local Docker DB)");
    return;
  }
  if (mode === "apply") {
    log("startup: applying migrations");
    const target = resolveMigrationTarget({ target: null }, process.env);
    await runMigrations(createServiceRequestConnection, log, { lockTimeoutMs: 120_000, target });
    return;
  }
  try {
    const status = await checkMigrations(createServiceRequestConnection);
    const problems = [
      ...status.pending.map((f) => `pending ${f.name}`),
      ...status.changed.map((c) => `changed since applied ${c.name}`),
    ];
    if (problems.length === 0) {
      log("startup: migrations up to date");
      return;
    }
    console.warn(`startup: migrations need attention: ${problems.join(", ")}`);
    Sentry.captureMessage(`Migrations need attention: ${problems.join(", ")}`, "warning");
  } catch (err) {
    console.error("startup: migration check failed", err);
    Sentry.captureException(err);
  }
});
/* eslint-enable no-console */
