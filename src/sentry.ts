/* eslint-disable no-console -- bootstrap diagnostics: these run at init, before Sentry/App Insights logging is available, and log no request data */
import * as Sentry from "@sentry/node";

let initialised = false;

export function initSentry(): void {
  if (initialised) return;

  if (process.env.AZURE_FUNCTIONS_ENVIRONMENT !== "Production") {
    console.log("[sentry] not in production — error reporting disabled");
    return;
  }

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log("[sentry] SENTRY_DSN not set — error reporting disabled");
    return;
  }

  Sentry.init({
    dsn,
    environment: "production",
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  });

  initialised = true;
  console.log("[sentry] initialised");
}

export { Sentry };
