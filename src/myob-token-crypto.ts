// AES-256-GCM for MYOB secrets at rest: the OAuth tokens in dbo.MyobAuth and,
// if Johanne chooses per-approver users, company-file credentials in
// dbo.MyobApproverCredentials. Node's crypto only; no package.
//
// Env (Key Vault references in Azure):
//   MYOB_TOKEN_KEY           32 random bytes, base64 (`openssl rand -base64 32`)
//   MYOB_TOKEN_KEY_VERSION   positive integer stored next to each ciphertext (default 1)
//   MYOB_TOKEN_KEY_PREVIOUS  optional: the key for version - 1 while rotating
//
// The additional data binds a ciphertext to where it lives, so a value copied
// to another row or table does not decrypt. Nothing here ever falls back to
// storing plaintext: no key, no write.

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;

export class MyobTokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MyobTokenCryptoError";
  }
}

function parseKey(name: string, raw: string | undefined): Buffer | null {
  if (!raw || !raw.trim()) return null;
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new MyobTokenCryptoError(`${name} must be ${KEY_BYTES} bytes, base64-encoded (openssl rand -base64 32)`);
  }
  return key;
}

export function currentKeyVersion(): number {
  const raw = process.env.MYOB_TOKEN_KEY_VERSION?.trim();
  if (!raw) return 1;
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) {
    throw new MyobTokenCryptoError("MYOB_TOKEN_KEY_VERSION must be a positive whole number");
  }
  return version;
}

function keyFor(version: number): Buffer {
  const current = currentKeyVersion();
  if (version === current) {
    const key = parseKey("MYOB_TOKEN_KEY", process.env.MYOB_TOKEN_KEY);
    if (!key) throw new MyobTokenCryptoError("MYOB_TOKEN_KEY is not configured; MYOB secrets cannot be stored or read");
    return key;
  }
  if (version === current - 1) {
    const previous = parseKey("MYOB_TOKEN_KEY_PREVIOUS", process.env.MYOB_TOKEN_KEY_PREVIOUS);
    if (previous) return previous;
  }
  throw new MyobTokenCryptoError(
    `This MYOB secret was encrypted with key version ${version}; only version ${current} is configured. Re-link MYOB.`,
  );
}

export interface SealedSecret {
  ciphertext: string;
  keyVersion: number;
}

/** "iv.tag.ciphertext", each base64. */
export function sealSecret(plaintext: string, aad: string): SealedSecret {
  const keyVersion = currentKeyVersion();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFor(keyVersion), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: [iv, tag, body].map((part) => part.toString("base64")).join("."), keyVersion };
}

export function openSecret(sealed: SealedSecret, aad: string): string {
  const parts = sealed.ciphertext.split(".");
  if (parts.length !== 3) throw new MyobTokenCryptoError("The stored MYOB secret is not in the expected format");
  const [iv, tag, body] = parts.map((part) => Buffer.from(part, "base64"));
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new MyobTokenCryptoError("The stored MYOB secret is not in the expected format");
  }
  try {
    // authTagLength pins the full 16-byte tag; GCM would otherwise accept a truncated one.
    const decipher = createDecipheriv("aes-256-gcm", keyFor(sealed.keyVersion), iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof MyobTokenCryptoError) throw error;
    throw new MyobTokenCryptoError("The stored MYOB secret could not be decrypted (wrong key, or it was altered)");
  }
}
