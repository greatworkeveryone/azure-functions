import { HttpRequest, HttpResponseInit } from "@azure/functions";

// Browser origins allowed to call the API. [0] is the canonical production
// origin and the fallback echoed at unrecognised callers.
const ALLOWED_ORIGINS = [
  "https://floorplan.randazzo.properties",
  "https://zealous-forest-041fd6a00.7.azurestaticapps.net",
];

// Local dev servers: never allowed in Production (same env check as sentry.ts).
const LOCAL_ORIGINS = ["http://localhost:3000", "http://localhost:5173"];

function builtInOrigins(): string[] {
  return process.env.AZURE_FUNCTIONS_ENVIRONMENT === "Production"
    ? ALLOWED_ORIGINS
    : [...ALLOWED_ORIGINS, ...LOCAL_ORIGINS];
}

// CORS_EXTRA_ORIGINS: comma-separated browser origins to allow in addition to
// the list above. Set on the staging Function App only (its staging frontend).
// Exact match: each entry must be a bare http(s) origin; wildcards, paths and
// anything else are dropped rather than interpreted.
function extraOrigins(): string[] {
  const raw = process.env.CORS_EXTRA_ORIGINS;
  if (!raw) return [];
  const origins: string[] = [];
  for (const entry of raw.split(",")) {
    const candidate = entry.trim().replace(/\/$/, "").toLowerCase();
    if (!candidate || candidate.includes("*")) continue;
    try {
      const url = new URL(candidate);
      if ((url.protocol === "https:" || url.protocol === "http:") && url.origin === candidate) {
        origins.push(candidate);
      }
    } catch {
      // not a URL: ignore the entry
    }
  }
  return origins;
}

export function corsHeaders(origin: string): Record<string, string> {
  const allowedOrigin =
    builtInOrigins().includes(origin) || extraOrigins().includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0];
  return {
    // Merged into every response (functions/startup.ts), so this is also where
    // the one security header the API sets lives.
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    // X-Fp-Country: the browser's country hint for the access log (S10). The
    // frontend sends it only after registerSelf advertises accessHints, so a
    // frontend deployed ahead of this backend never fails a preflight.
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-App-Token, X-Fp-Country, X-Show-Test-Data, X-Tenant-Link, X-Tenant-Request" +
      (process.env.DEV_ROLE_OVERRIDE_ENABLED === "true" ? ", X-Dev-Roles" : ""),
    // Response headers the page may read. Retry-After: the sign-in screen waits
    // at least that long after a 429. Content-Disposition: the decisions export
    // sets it itself, but this object is merged over a handler's headers
    // (functions/startup.ts), so it must be listed here too.
    "Access-Control-Expose-Headers": "Content-Disposition, Retry-After",
    // The header varies per caller — without this, a shared cache can serve
    // one origin's response to another.
    Vary: "Origin",
  };
}

export function preflightResponse(request: HttpRequest): HttpResponseInit {
  const origin = request.headers.get("origin") ?? "";
  return { status: 200, headers: corsHeaders(origin) };
}
