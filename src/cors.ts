import { HttpRequest, HttpResponseInit } from "@azure/functions";

// Browser origins allowed to call the API. [0] is the canonical production
// origin and the fallback echoed at unrecognised callers.
const ALLOWED_ORIGINS = [
  "https://floorplan.randazzo.properties",
  "https://zealous-forest-041fd6a00.7.azurestaticapps.net",
  "http://localhost:3000",
  "http://localhost:5173",
];

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
    ALLOWED_ORIGINS.includes(origin) || extraOrigins().includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    // X-Fp-Country: the browser's country hint for the access log (S10). The
    // frontend sends it only after registerSelf advertises accessHints, so a
    // frontend deployed ahead of this backend never fails a preflight.
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-App-Token, X-Fp-Country",
    // The header varies per caller — without this, a shared cache can serve
    // one origin's response to another.
    Vary: "Origin",
  };
}

export function preflightResponse(request: HttpRequest): HttpResponseInit {
  const origin = request.headers.get("origin") ?? "";
  return { status: 200, headers: corsHeaders(origin) };
}
