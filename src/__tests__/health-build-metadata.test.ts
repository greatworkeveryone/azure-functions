/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return { ...actual, requireRole: jest.fn().mockResolvedValue(null) };
});

jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
}));

type Handler = (request: HttpRequest, context: InvocationContext) => Promise<{
  jsonBody?: Record<string, unknown>;
  status?: number;
}>;

// health.ts reads BUILD_SHA / BUILD_TIME once at module load, so each case
// loads a fresh copy of the module with the environment it wants.
function loadHandler(env: Record<string, string | undefined>): Handler {
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(env);
  try {
    let handler: Handler | undefined;
    jest.isolateModules(() => {
      const functions = require("@azure/functions") as { app: { http: jest.Mock } };
      // The mocked app is shared across isolated registries, so drop earlier
      // registrations to be sure the handler under test is the one just loaded.
      functions.app.http.mockClear();
      require("../functions/health");
      handler = functions.app.http.mock.calls.find((c: unknown[]) => c[0] === "health")?.[1]
        .handler;
    });
    if (!handler) throw new Error("health was not registered");
    return handler;
  } finally {
    apply(previous);
  }
}

function request(query: string): HttpRequest {
  return new HttpRequest({ method: "GET", url: `https://example.test/api/health${query}` });
}

describe("health build metadata", () => {
  it("reports BUILD_SHA and BUILD_TIME from the environment on the deep probe", async () => {
    const handler = loadHandler({
      BUILD_SHA: "abc1234",
      BUILD_TIME: "2026-10-14T01:02:03Z",
    });
    const response = await handler(request("?deep=true"), new InvocationContext());
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({
      builtAt: "2026-10-14T01:02:03Z",
      commit: "abc1234",
      db: "ok",
    });
  });

  it("reports unknown when the pipeline did not set them", async () => {
    const handler = loadHandler({ BUILD_SHA: undefined, BUILD_TIME: undefined });
    const response = await handler(request("?deep=true"), new InvocationContext());
    expect(response.jsonBody).toMatchObject({ builtAt: "unknown", commit: "unknown" });
  });

  it("never exposes the build on the anonymous shallow probe", async () => {
    const handler = loadHandler({ BUILD_SHA: "abc1234", BUILD_TIME: "2026-10-14T01:02:03Z" });
    const response = await handler(request(""), new InvocationContext());
    expect(response.jsonBody).toEqual({ ok: true });
  });
});
