import { app, HttpResponseInit } from "@azure/functions";

// The deploy's smoke test reads this to confirm the build it just shipped is the one answering.
// Only the build SHA and time, nothing about settings, timers or topology. Deep health (admin
// token) is where the rest lives.
export async function version(): Promise<HttpResponseInit> {
  return {
    headers: { "Cache-Control": "no-store" },
    jsonBody: { builtAt: process.env.BUILD_TIME ?? "unknown", commit: process.env.BUILD_SHA ?? "unknown" },
    status: 200,
  };
}

app.http("version", { authLevel: "anonymous", handler: version, methods: ["GET"] });
