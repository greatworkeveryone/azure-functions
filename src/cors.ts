import { HttpRequest, HttpResponseInit } from "@azure/functions";

// Browser origins allowed to call the API. [0] is the canonical production
// origin and the fallback echoed at unrecognised callers.
const ALLOWED_ORIGINS = [
  "https://floorplan.randazzo.properties",
  "https://zealous-forest-041fd6a00.7.azurestaticapps.net",
  "http://localhost:3000",
  "http://localhost:5173",
];

export function corsHeaders(origin: string): Record<string, string> {
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-App-Token",
    // The header varies per caller — without this, a shared cache can serve
    // one origin's response to another.
    Vary: "Origin",
  };
}

export function preflightResponse(request: HttpRequest): HttpResponseInit {
  const origin = request.headers.get("origin") ?? "";
  return { status: 200, headers: corsHeaders(origin) };
}
