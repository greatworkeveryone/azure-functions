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
});
