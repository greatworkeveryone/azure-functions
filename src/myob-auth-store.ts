// dbo.MyobAuth, the one MYOB link (Id = 1). Access and refresh tokens are held
// only as AES-256-GCM ciphertext (TokenCiphertext + TokenKeyVersion, migration
// 124); every save blanks the legacy plaintext columns, which stay NOT NULL.
// A row with no ciphertext (linked before migration 124) is treated as needing
// a re-link rather than read in plaintext.
//
// Writers take sp_getapplock('myob_refresh') inside their transaction, so a
// refresh, a second refresh and a re-link never interleave (MYOB rotates the
// refresh token on every use; a lost race would strand the link).

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "./db";
import { openSecret, sealSecret } from "./myob-token-crypto";

const TOKEN_AAD = "dbo.MyobAuth#1";
const LOCK_TIMEOUT_MS = 45_000;
const DEFAULT_EXPIRES_IN_SECONDS = 1200;

export interface MyobTokenResponse {
  access_token: string;
  refresh_token: string;
  /** MYOB sends this as a string ("1200"). */
  expires_in: number | string;
  scope?: string;
  user?: { uid?: string; username?: string };
}

export interface MyobAuthRow {
  AuthorizedAt: Date | null;
  AuthorizedBy: string | null;
  BusinessId: string | null;
  CompanyFileName: string | null;
  ExpiresAt: Date;
  LinkedByName: string | null;
  LinkedByOid: string | null;
  MyobUserUid: string | null;
  MyobUsername: string | null;
  Scope: string | null;
  TokenCiphertext: string | null;
  TokenKeyVersion: number | null;
}

export class MyobRelinkRequiredError extends Error {
  constructor(reason: string) {
    super(`MYOB needs to be linked again: ${reason}`);
    this.name = "MyobRelinkRequiredError";
  }
}

export async function readMyobAuthRow(connection: Connection): Promise<MyobAuthRow | null> {
  const rows = await executeQuery(
    connection,
    `SELECT TokenCiphertext, TokenKeyVersion, ExpiresAt, Scope, AuthorizedBy, AuthorizedAt,
            BusinessId, MyobUserUid, MyobUsername, LinkedByOid, LinkedByName, CompanyFileName
       FROM dbo.MyobAuth WHERE Id = 1`,
  );
  return rows.length ? (rows[0] as unknown as MyobAuthRow) : null;
}

export function openStoredTokens(row: MyobAuthRow): { accessToken: string; refreshToken: string } {
  if (!row.TokenCiphertext || row.TokenKeyVersion == null) {
    throw new MyobRelinkRequiredError("the stored link predates token encryption");
  }
  const parsed = JSON.parse(openSecret({ ciphertext: row.TokenCiphertext, keyVersion: row.TokenKeyVersion }, TOKEN_AAD)) as {
    a?: unknown;
    r?: unknown;
  };
  if (typeof parsed.a !== "string" || typeof parsed.r !== "string") {
    throw new MyobRelinkRequiredError("the stored tokens are incomplete");
  }
  return { accessToken: parsed.a, refreshToken: parsed.r };
}

function expiresAt(tokens: MyobTokenResponse): Date {
  const seconds = Number(tokens.expires_in);
  const valid = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_EXPIRES_IN_SECONDS;
  return new Date(Date.now() + valid * 1000);
}

function tokenParams(tokens: MyobTokenResponse) {
  const sealed = sealSecret(JSON.stringify({ a: tokens.access_token, r: tokens.refresh_token }), TOKEN_AAD);
  return [
    { name: "Ciphertext", type: TYPES.NVarChar, value: sealed.ciphertext },
    { name: "KeyVersion", type: TYPES.Int, value: sealed.keyVersion },
    { name: "ExpiresAt", type: TYPES.DateTime2, value: expiresAt(tokens) },
    { name: "Scope", type: TYPES.NVarChar, value: tokens.scope?.slice(0, 500) ?? null },
  ];
}

/** Serialises token writers. Call inside an open transaction; released on commit or rollback. */
export async function lockMyobTokens(connection: Connection): Promise<void> {
  const rows = await executeQuery(
    connection,
    `DECLARE @Result INT;
     EXEC @Result = sp_getapplock @Resource = N'myob_refresh', @LockMode = N'Exclusive',
                                  @LockOwner = N'Transaction', @LockTimeout = @TimeoutMs;
     SELECT @Result AS LockResult;`,
    [{ name: "TimeoutMs", type: TYPES.Int, value: LOCK_TIMEOUT_MS }],
  );
  const result = Number(rows[0]?.LockResult ?? -999);
  if (!(result >= 0)) throw new Error(`Could not take the MYOB token lock (sp_getapplock returned ${result})`);
}

export async function saveRefreshedTokens(connection: Connection, tokens: MyobTokenResponse): Promise<void> {
  await executeQuery(
    connection,
    `UPDATE dbo.MyobAuth
        SET AccessToken = N'', RefreshToken = N'',
            TokenCiphertext = @Ciphertext, TokenKeyVersion = @KeyVersion,
            ExpiresAt = @ExpiresAt, Scope = COALESCE(@Scope, Scope), UpdatedAt = SYSUTCDATETIME()
      WHERE Id = 1`,
    tokenParams(tokens),
  );
}

export interface LinkedTokens {
  businessId: string;
  linkedBy: { name: string; oid: string };
  tokens: MyobTokenResponse;
}

export async function saveLinkedTokens(connection: Connection, link: LinkedTokens): Promise<void> {
  await executeQuery(
    connection,
    `MERGE dbo.MyobAuth AS target
     USING (SELECT 1 AS Id) AS src ON target.Id = src.Id
     WHEN MATCHED THEN UPDATE SET
       AccessToken = N'', RefreshToken = N'',
       TokenCiphertext = @Ciphertext, TokenKeyVersion = @KeyVersion,
       ExpiresAt = @ExpiresAt, Scope = @Scope,
       BusinessId = @BusinessId, MyobUserUid = @MyobUserUid, MyobUsername = @MyobUsername,
       LinkedByOid = @LinkedByOid, LinkedByName = @LinkedByName,
       AuthorizedBy = @LinkedByName, AuthorizedAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT
       (Id, AccessToken, RefreshToken, TokenCiphertext, TokenKeyVersion, ExpiresAt, Scope,
        BusinessId, MyobUserUid, MyobUsername, LinkedByOid, LinkedByName, AuthorizedBy, AuthorizedAt, UpdatedAt)
       VALUES (1, N'', N'', @Ciphertext, @KeyVersion, @ExpiresAt, @Scope,
        @BusinessId, @MyobUserUid, @MyobUsername, @LinkedByOid, @LinkedByName, @LinkedByName, SYSUTCDATETIME(), SYSUTCDATETIME());`,
    [
      ...tokenParams(link.tokens),
      { name: "BusinessId", type: TYPES.NVarChar, value: link.businessId },
      { name: "MyobUserUid", type: TYPES.NVarChar, value: link.tokens.user?.uid?.slice(0, 100) ?? null },
      { name: "MyobUsername", type: TYPES.NVarChar, value: link.tokens.user?.username?.slice(0, 200) ?? null },
      { name: "LinkedByOid", type: TYPES.NVarChar, value: link.linkedBy.oid.slice(0, 100) },
      { name: "LinkedByName", type: TYPES.NVarChar, value: link.linkedBy.name.slice(0, 200) },
    ],
  );
}
