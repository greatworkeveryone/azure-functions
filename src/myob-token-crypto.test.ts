/// <reference types="jest" />

import { randomBytes } from "crypto";
import { currentKeyVersion, MyobTokenCryptoError, openSecret, sealSecret } from "./myob-token-crypto";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
const AAD = "dbo.MyobAuth#1";
const saved = { ...process.env };

beforeEach(() => {
  process.env.MYOB_TOKEN_KEY = KEY_A;
  delete process.env.MYOB_TOKEN_KEY_VERSION;
  delete process.env.MYOB_TOKEN_KEY_PREVIOUS;
});

afterAll(() => {
  process.env = saved;
});

describe("sealSecret / openSecret", () => {
  it("round-trips and never contains the plaintext", () => {
    const sealed = sealSecret("refresh-token-value", AAD);
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.ciphertext).not.toContain("refresh-token-value");
    expect(openSecret(sealed, AAD)).toBe("refresh-token-value");
  });

  it("uses a fresh IV every time", () => {
    expect(sealSecret("same", AAD).ciphertext).not.toBe(sealSecret("same", AAD).ciphertext);
  });

  it("fails with the wrong key", () => {
    const sealed = sealSecret("secret", AAD);
    process.env.MYOB_TOKEN_KEY = KEY_B;
    expect(() => openSecret(sealed, AAD)).toThrow(MyobTokenCryptoError);
  });

  it("fails when the ciphertext was altered", () => {
    const sealed = sealSecret("secret", AAD);
    const [iv, tag, body] = sealed.ciphertext.split(".");
    const flipped = Buffer.from(body, "base64");
    flipped[0] ^= 1;
    expect(() => openSecret({ ...sealed, ciphertext: [iv, tag, flipped.toString("base64")].join(".") }, AAD)).toThrow(
      MyobTokenCryptoError,
    );
  });

  it("fails when moved to another place (different additional data)", () => {
    const sealed = sealSecret("secret", AAD);
    expect(() => openSecret(sealed, "dbo.MyobApproverCredentials#x")).toThrow(MyobTokenCryptoError);
  });

  it("refuses a truncated auth tag", () => {
    const sealed = sealSecret("secret", AAD);
    const [iv, tag, body] = sealed.ciphertext.split(".");
    const short = Buffer.from(tag, "base64").subarray(0, 4).toString("base64");
    expect(() => openSecret({ ...sealed, ciphertext: [iv, short, body].join(".") }, AAD)).toThrow(MyobTokenCryptoError);
  });

  it("refuses to seal anything without a key: no plaintext fallback", () => {
    delete process.env.MYOB_TOKEN_KEY;
    expect(() => sealSecret("secret", AAD)).toThrow("MYOB_TOKEN_KEY is not configured");
  });

  it("refuses a key that is not 32 bytes", () => {
    process.env.MYOB_TOKEN_KEY = Buffer.from("short").toString("base64");
    expect(() => sealSecret("secret", AAD)).toThrow("32 bytes");
  });
});

describe("key versions", () => {
  it("records the configured version and refuses an unknown one", () => {
    process.env.MYOB_TOKEN_KEY_VERSION = "3";
    const sealed = sealSecret("secret", AAD);
    expect(sealed.keyVersion).toBe(3);
    expect(() => openSecret({ ...sealed, keyVersion: 1 }, AAD)).toThrow("key version 1");
  });

  it("opens the previous version while rotating, with MYOB_TOKEN_KEY_PREVIOUS", () => {
    const old = sealSecret("secret", AAD);
    process.env.MYOB_TOKEN_KEY_PREVIOUS = KEY_A;
    process.env.MYOB_TOKEN_KEY = KEY_B;
    process.env.MYOB_TOKEN_KEY_VERSION = "2";
    expect(openSecret(old, AAD)).toBe("secret");
    expect(sealSecret("new", AAD).keyVersion).toBe(2);
  });

  it("rejects a version that is not a positive whole number", () => {
    process.env.MYOB_TOKEN_KEY_VERSION = "0";
    expect(() => currentKeyVersion()).toThrow(MyobTokenCryptoError);
  });
});
