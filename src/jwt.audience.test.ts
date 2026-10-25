// M7: audience modes against real signed tokens (the JWKS fetch is stubbed).
import { generateKeyPair, SignJWT } from "jose";
import type { KeyLike } from "jose";

let publicKey: KeyLike;
let privateKey: KeyLike;

jest.mock("jose", () => {
  const actual = jest.requireActual("jose");
  return { ...actual, createRemoteJWKSet: () => async () => publicKey };
});

import { acceptedAudiences } from "./apiAudience";
import { verifyEntraToken } from "./jwt";

const TENANT = "tenant-1";
const CLIENT = "96a734cd-3a84-44fe-a6d4-edcbb44f17cc";
const SAVED = { ...process.env };

function mint(aud: string): Promise<string> {
  return new SignJWT({ oid: "o1" })
    .setProtectedHeader({ alg: "RS256" })
    .setAudience(aud)
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function accepted(aud: string, mode?: string): Promise<boolean> {
  if (mode) process.env.API_TOKEN_AUDIENCE = mode;
  else delete process.env.API_TOKEN_AUDIENCE;
  return (await verifyEntraToken(await mint(aud), acceptedAudiences())) !== null;
}

beforeAll(async () => {
  ({ publicKey, privateKey } = await generateKeyPair("RS256"));
});

beforeEach(() => {
  process.env.GRAPH_TENANT_ID = TENANT;
  process.env.APP_CLIENT_ID = CLIENT;
  delete process.env.DEV_ROLE_OVERRIDE_ENABLED;
});

afterAll(() => {
  process.env = SAVED;
});

describe("API_TOKEN_AUDIENCE modes", () => {
  it("sql (default): accepts SQL tokens, rejects app tokens", async () => {
    expect(await accepted("https://database.windows.net/")).toBe(true);
    expect(await accepted(CLIENT)).toBe(false);
    expect(await accepted(`api://${CLIENT}`, "sql")).toBe(false);
  });

  it("both: accepts SQL and app tokens", async () => {
    expect(await accepted("https://database.windows.net/", "both")).toBe(true);
    expect(await accepted(CLIENT, "both")).toBe(true);
    expect(await accepted(`api://${CLIENT}`, "both")).toBe(true);
  });

  it("api: accepts app tokens, rejects database.windows.net tokens", async () => {
    expect(await accepted(CLIENT, "api")).toBe(true);
    expect(await accepted(`api://${CLIENT}`, "api")).toBe(true);
    expect(await accepted("https://database.windows.net/", "api")).toBe(false);
    expect(await accepted("https://database.windows.net", "api")).toBe(false);
  });

  it("rejects an unrelated audience in every mode", async () => {
    for (const mode of ["sql", "both", "api"]) expect(await accepted("api://other", mode)).toBe(false);
  });
});
