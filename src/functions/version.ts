import { app, HttpResponseInit } from "@azure/functions";

// The deploy's smoke test reads this to confirm the build it just shipped is the one answering, and the app
// reads the environment name once to know whether to show the staging notice. Only the build SHA, time and
// environment name, nothing about settings, timers or topology. Deep health (admin
// token) is where the rest lives.
export async function version(): Promise<HttpResponseInit> {
  return {
    headers: { "Cache-Control": "no-store" },
    jsonBody: {
      builtAt: process.env.BUILD_TIME ?? "unknown",
      commit: process.env.BUILD_SHA ?? "unknown",
      environment: process.env.AZURE_FUNCTIONS_ENVIRONMENT ?? "unknown",
    },
    status: 200,
  };
}

app.http("version", { authLevel: "anonymous", handler: version, methods: ["GET"] });
