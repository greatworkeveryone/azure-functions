import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

async function health(_request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  return { status: 200, jsonBody: { ok: true } };
}

app.http("health", { methods: ["GET"], authLevel: "anonymous", handler: health });
