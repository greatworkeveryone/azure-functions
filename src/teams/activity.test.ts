/// <reference types="jest" />
import { NOT_A_RECORD, TestDataEgressError } from "../test-data";
import { activityBody, parseRetryAfter, sendActivityNotification, type TeamsAlert } from "./activity";
import { teamsAppId, teamsMode } from "./config";

const APP_ID = "app-1";
const OID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const LIVE = { TEAMS_ALERTS_ENABLED: "true", TEAMS_APP_ID: APP_ID } as NodeJS.ProcessEnv;
const ALERT: TeamsAlert = { egress: NOT_A_RECORD, previewText: "Job needs a decision", route: "/jobs?jobId=1&step=decision", text: "A job needs your decision" };

function reply(status: number, headers: Record<string, string> = {}, text = ""): Response {
  return { headers: new Headers(headers), ok: status >= 200 && status < 300, status, text: async () => text } as Response;
}

/** One response for every call, or a list answered in order (the last repeats). */
function deps(response: Response | Error | (Response | Error)[], env: NodeJS.ProcessEnv = LIVE) {
  const queue = Array.isArray(response) ? [...response] : [response];
  const fetchMock = jest.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next as Response;
  });
  let n = 0;
  const getToken = jest.fn(async () => `graph-tok-${++n}`);
  const clearToken = jest.fn();
  const log = jest.fn();
  return { clearToken, env, fetch: fetchMock as unknown as typeof fetch, fetchMock, getToken, log };
}

describe("teamsMode / teamsAppId", () => {
  it("is off unless enabled, and dry run wins", () => {
    expect(teamsMode({})).toBe("off");
    expect(teamsMode({ TEAMS_ALERTS_ENABLED: "1" })).toBe("off");
    expect(teamsMode({ TEAMS_ALERTS_ENABLED: "true" })).toBe("live");
    expect(teamsMode({ TEAMS_ALERTS_DRY_RUN: "true", TEAMS_ALERTS_ENABLED: "true" })).toBe("dry-run");
  });

  it("reads the app id, blank as unset", () => {
    expect(teamsAppId({ TEAMS_APP_ID: " x " })).toBe("x");
    expect(teamsAppId({ TEAMS_APP_ID: " " })).toBeNull();
  });
});

describe("sendActivityNotification", () => {
  it("posts the systemDefault activity to the user's teamwork endpoint", async () => {
    const d = deps(reply(204));
    await expect(sendActivityNotification(OID, ALERT, d)).resolves.toEqual({ mode: "live", status: "sent" });
    const [url, init] = d.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://graph.microsoft.com/v1.0/users/${OID}/teamwork/sendActivityNotification`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer graph-tok-1");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      activityType: "systemDefault",
      previewText: { content: "Job needs a decision" },
      templateParameters: [{ name: "systemDefaultText", value: "A job needs your decision" }],
      topic: { source: "text", value: "Floorplan", webUrl: expect.stringContaining(`/l/entity/${APP_ID}/floorplan?context=`) },
    });
  });

  it.each([
    [403, "not_permitted"],
    [401, "failed"],
    [404, "no_user"],
    [409, "duplicate_app"],
    [400, "failed"],
  ])("maps %i to %s, with the error text", async (status, expected) => {
    const result = await sendActivityNotification(OID, ALERT, deps(reply(status, {}, '{"error":"x"}')));
    expect(result).toEqual({ error: '{"error":"x"}', httpStatus: status, mode: "live", status: expected });
  });

  it.each([401, 403])("on %i refetches the token and tries once more", async (status) => {
    const d = deps([reply(status), reply(204)]);
    expect(await sendActivityNotification(OID, ALERT, d)).toEqual({ mode: "live", status: "sent" });
    expect(d.clearToken).toHaveBeenCalledTimes(1);
    expect(d.getToken).toHaveBeenCalledTimes(2);
    const auths = d.fetchMock.mock.calls.map((call) => ((call as unknown as [string, RequestInit])[1].headers as Record<string, string>).Authorization);
    expect(auths).toEqual(["Bearer graph-tok-1", "Bearer graph-tok-2"]);
  });

  it("gives up after one retry: 403 twice is not_permitted", async () => {
    const d = deps([reply(403), reply(403, {}, "no consent")]);
    expect(await sendActivityNotification(OID, ALERT, d)).toMatchObject({ error: "no consent", status: "not_permitted" });
    expect(d.fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["404", reply(404)],
    ["409", reply(409)],
    ["429", reply(429)],
    ["500", reply(500)],
    ["a network error", new Error("ECONNRESET")],
  ])("never retries on %s, so a send that may have landed isn't repeated", async (_label, response) => {
    const d = deps(response);
    await sendActivityNotification(OID, ALERT, d);
    expect(d.fetchMock).toHaveBeenCalledTimes(1);
    expect(d.clearToken).not.toHaveBeenCalled();
  });

  it.each([429, 500, 503])("maps %i to retry, honouring Retry-After", async (status) => {
    const result = await sendActivityNotification(OID, ALERT, deps(reply(status, { "Retry-After": "30" })));
    expect(result).toMatchObject({ httpStatus: status, retryAfterSeconds: 30, status: "retry" });
  });

  it("maps a retry without Retry-After to null, and a network failure to retry", async () => {
    expect(await sendActivityNotification(OID, ALERT, deps(reply(503)))).toMatchObject({ retryAfterSeconds: null, status: "retry" });
    expect(await sendActivityNotification(OID, ALERT, deps(new Error("ECONNRESET")))).toMatchObject({
      error: "ECONNRESET",
      httpStatus: null,
      status: "retry",
    });
  });

  it("returns failed, not a throw, when the token can't be had", async () => {
    const d = deps(reply(204));
    d.getToken.mockRejectedValueOnce(new Error("Graph token request failed: 401"));
    expect(await sendActivityNotification(OID, ALERT, d)).toMatchObject({ httpStatus: null, status: "failed" });
    expect(d.fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing when off", async () => {
    const d = deps(reply(204), {});
    expect(await sendActivityNotification(OID, ALERT, d)).toEqual({ mode: "off", status: "skipped" });
    expect(d.fetchMock).not.toHaveBeenCalled();
    expect(d.getToken).not.toHaveBeenCalled();
  });

  it("logs and sends nothing on a dry run, even when enabled too", async () => {
    const d = deps(reply(204), { ...LIVE, TEAMS_ALERTS_DRY_RUN: "true" });
    const result = await sendActivityNotification(OID, ALERT, d);
    expect(result).toMatchObject({ mode: "dry-run", status: "dry_run", webUrl: expect.stringContaining(APP_ID) });
    expect(d.fetchMock).not.toHaveBeenCalled();
    expect(d.getToken).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("/jobs?jobId=1&step=decision"));
  });

  it("refuses a test record before anything leaves (D9)", async () => {
    const d = deps(reply(204));
    await expect(sendActivityNotification(OID, { ...ALERT, egress: { isTest: true } }, d)).rejects.toBeInstanceOf(TestDataEgressError);
    await expect(sendActivityNotification(OID, { ...ALERT, egress: { isTest: true } }, d)).rejects.toMatchObject({ channel: "teams" });
    expect(d.fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an unsafe route or a missing app id before any call", async () => {
    const d = deps(reply(204));
    await expect(sendActivityNotification(OID, { ...ALERT, route: "//evil.com" }, d)).rejects.toThrow(/Unsafe/);
    await expect(sendActivityNotification(OID, ALERT, { ...d, env: { TEAMS_ALERTS_ENABLED: "true" } })).rejects.toThrow(/TEAMS_APP_ID/);
    expect(d.fetchMock).not.toHaveBeenCalled();
  });

  it("encodes the oid into the URL path", async () => {
    const d = deps(reply(204));
    await sendActivityNotification("a/../b", ALERT, d);
    expect(String((d.fetchMock.mock.calls[0] as unknown[])[0])).toContain("/users/a%2F..%2Fb/teamwork/");
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-23T00:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120);
    expect(parseRetryAfter("Fri, 23 Oct 2026 00:00:45 GMT", now)).toBe(45);
    expect(parseRetryAfter("Thu, 22 Oct 2026 00:00:00 GMT", now)).toBe(0);
  });

  it("is null for missing or junk", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter("-5")).toBeNull();
  });
});

describe("activityBody", () => {
  it("carries the tab link as the topic's webUrl", () => {
    expect(activityBody(ALERT, "https://teams.microsoft.com/l/entity/x/floorplan?context=y")).toMatchObject({
      topic: { webUrl: "https://teams.microsoft.com/l/entity/x/floorplan?context=y" },
    });
  });
});
