import { HttpRequest, HttpResponseInit } from "@azure/functions";

const ALLOWED_ORIGINS = [
  "https://victorious-bay-095835d00.7.azurestaticapps.net",
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
  };
}

export function preflightResponse(request: HttpRequest): HttpResponseInit {
  const origin = request.headers.get("origin") ?? "";
  return { status: 200, headers: corsHeaders(origin) };
}
