import { sentryRequestContext, stripQuery } from "./sentryRequestContext";

function request(url: string, headers: Record<string, string> = {}) {
  return { headers: new Headers(headers), method: "GET", url };
}

describe("stripQuery", () => {
  it("drops the query string and fragment but keeps the path", () => {
    expect(stripQuery("https://api.example.com/api/myobCallback?code=SECRET&state=abc#x")).toBe("https://api.example.com/api/myobCallback");
  });

  it("cuts an unparseable url at the query", () => {
    expect(stripQuery("/api/graphWebhook?validationToken=tok")).toBe("/api/graphWebhook");
  });

  it("leaves a url without a query alone", () => {
    expect(stripQuery("https://api.example.com/api/health")).toBe("https://api.example.com/api/health");
  });
});

describe("sentryRequestContext", () => {
  it("strips the query string from the captured url", () => {
    const { normalizedRequest } = sentryRequestContext(request("https://h/api/graphWebhook?validationToken=tok"), null, () => null);
    expect(normalizedRequest.url).toBe("https://h/api/graphWebhook");
    expect(JSON.stringify(normalizedRequest)).not.toContain("tok");
  });

  it("redacts credential headers case-insensitively and keeps the rest", () => {
    const { normalizedRequest } = sentryRequestContext(
      request("https://h/x", { Authorization: "Bearer abc", Cookie: "s=1", "X-App-Token": "t", accept: "json" }),
      null,
      () => null,
    );
    expect(normalizedRequest.headers).toEqual({ accept: "json", authorization: "[redacted]", cookie: "[redacted]", "x-app-token": "[redacted]" });
  });

  it("sets the user to the object id only", () => {
    const { user } = sentryRequestContext(request("https://h/x"), "jwt", () => "oid-1");
    expect(user).toEqual({ id: "oid-1" });
  });

  it("has no user without a token or an oid", () => {
    expect(sentryRequestContext(request("https://h/x"), null, () => "oid").user).toBeNull();
    expect(sentryRequestContext(request("https://h/x"), "jwt", () => null).user).toBeNull();
  });
});
