/// <reference types="jest" />
import { corsHeaders } from "../cors";

const PRODUCTION = "https://floorplan.randazzo.properties";
const STAGING = "https://staging-floorplan.example.azurestaticapps.net";

describe("corsHeaders", () => {
  const saved = process.env.CORS_EXTRA_ORIGINS;
  afterEach(() => {
    if (saved === undefined) delete process.env.CORS_EXTRA_ORIGINS;
    else process.env.CORS_EXTRA_ORIGINS = saved;
  });

  it("echoes the built-in origins and falls back to production for strangers", () => {
    delete process.env.CORS_EXTRA_ORIGINS;
    expect(corsHeaders("http://localhost:3000")["Access-Control-Allow-Origin"]).toBe(
      "http://localhost:3000",
    );
    expect(corsHeaders(STAGING)["Access-Control-Allow-Origin"]).toBe(PRODUCTION);
    expect(corsHeaders("")["Access-Control-Allow-Origin"]).toBe(PRODUCTION);
  });

  it("allows an origin listed in CORS_EXTRA_ORIGINS", () => {
    process.env.CORS_EXTRA_ORIGINS = STAGING;
    expect(corsHeaders(STAGING)["Access-Control-Allow-Origin"]).toBe(STAGING);
  });

  it("reads a comma-separated list and ignores spaces, blanks and a trailing slash", () => {
    process.env.CORS_EXTRA_ORIGINS = ` ${STAGING}/ , ,https://other.example.com `;
    expect(corsHeaders(STAGING)["Access-Control-Allow-Origin"]).toBe(STAGING);
    expect(corsHeaders("https://other.example.com")["Access-Control-Allow-Origin"]).toBe(
      "https://other.example.com",
    );
  });

  it("matches the origin exactly: no subdomain, scheme or port widening", () => {
    process.env.CORS_EXTRA_ORIGINS = STAGING;
    for (const origin of [
      `https://evil.${STAGING.replace("https://", "")}`,
      STAGING.replace("https", "http"),
      `${STAGING}:8443`,
      `${STAGING}.evil.com`,
      `${STAGING}/path`,
    ]) {
      expect(corsHeaders(origin)["Access-Control-Allow-Origin"]).toBe(PRODUCTION);
    }
  });

  it("never treats a wildcard entry as a pattern", () => {
    process.env.CORS_EXTRA_ORIGINS = "*,https://*.azurestaticapps.net,null";
    for (const origin of ["https://anything.example.com", "https://x.azurestaticapps.net", "null"]) {
      expect(corsHeaders(origin)["Access-Control-Allow-Origin"]).toBe(PRODUCTION);
    }
  });

  it("drops entries that are not bare http(s) origins", () => {
    process.env.CORS_EXTRA_ORIGINS = "javascript:alert(1),ftp://files.example.com,not a url,https://ok.example.com/with/path";
    expect(corsHeaders("ftp://files.example.com")["Access-Control-Allow-Origin"]).toBe(PRODUCTION);
    expect(corsHeaders("https://ok.example.com")["Access-Control-Allow-Origin"]).toBe(PRODUCTION);
  });

  it("picks up a change to the variable without a module reload", () => {
    process.env.CORS_EXTRA_ORIGINS = STAGING;
    expect(corsHeaders(STAGING)["Access-Control-Allow-Origin"]).toBe(STAGING);
    process.env.CORS_EXTRA_ORIGINS = "";
    expect(corsHeaders(STAGING)["Access-Control-Allow-Origin"]).toBe(PRODUCTION);
  });

  it("keeps Vary: Origin and credentials on every response", () => {
    process.env.CORS_EXTRA_ORIGINS = STAGING;
    const headers = corsHeaders(STAGING);
    expect(headers.Vary).toBe("Origin");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
  });

  // Retry-After is not a header a browser lets a cross-origin page read unless
  // the response exposes it, so without this the sign-in screen cannot honour it
  // (PL2). It overwrites whatever a handler set (startup.ts merges corsHeaders
  // last), so Content-Disposition, which the decisions export exposes itself,
  // stays on the list.
  it("exposes Retry-After to the page, and keeps Content-Disposition (the decisions export) exposed", () => {
    const exposed = corsHeaders(PRODUCTION)["Access-Control-Expose-Headers"].split(",").map((name) => name.trim());
    expect(exposed).toEqual(expect.arrayContaining(["Retry-After", "Content-Disposition"]));
  });
});


it("allows the test-data header while leaving its authority to the handler", () => {
  expect(corsHeaders("http://localhost:3000")["Access-Control-Allow-Headers"]).toContain("X-Show-Test-Data");
});
it("allows the developer role header only when backend overrides are enabled", () => {
  const previous = process.env.DEV_ROLE_OVERRIDE_ENABLED;
  try {
    delete process.env.DEV_ROLE_OVERRIDE_ENABLED;
    expect(corsHeaders("http://localhost:3000")["Access-Control-Allow-Headers"]).not.toContain("X-Dev-Roles");
    process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
    expect(corsHeaders("http://localhost:3000")["Access-Control-Allow-Headers"]).toContain("X-Dev-Roles");
  } finally {
    if (previous === undefined) delete process.env.DEV_ROLE_OVERRIDE_ENABLED;
    else process.env.DEV_ROLE_OVERRIDE_ENABLED = previous;
  }
});
