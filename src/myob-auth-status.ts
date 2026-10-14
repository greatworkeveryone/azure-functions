// What the admin panel shows about the MYOB link. A row that can't be used
// (no ciphertext, or a key version that is no longer configured) reads as not
// linked, with the reason.

import type { Connection } from "tedious";
import { closeConnection, createRequestConnection, createServiceRequestConnection } from "./db";
import { readMyobAuthRow } from "./myob-auth-store";
import { currentKeyVersion } from "./myob-token-crypto";

export interface MyobAuthStatus {
  linked: boolean;
  expiresAt: string | null;
  authorizedBy: string | null;
  authorizedAt: string | null;
  isExpired: boolean;
  scope: string | null;
  businessId: string | null;
  companyFileName: string | null;
  myobUsername: string | null;
  /** Why the stored link can't be used, when it can't. */
  relinkReason: string | null;
}

async function openDbConnection(sqlToken: string | null): Promise<Connection> {
  return sqlToken ? createRequestConnection(sqlToken) : createServiceRequestConnection();
}

function relinkReason(row: { TokenCiphertext: string | null; TokenKeyVersion: number | null }): string | null {
  if (!row.TokenCiphertext || row.TokenKeyVersion == null) return "the stored link predates token encryption";
  if (!process.env.MYOB_TOKEN_KEY?.trim()) return "MYOB_TOKEN_KEY is not configured";
  try {
    const current = currentKeyVersion();
    const previousUsable = row.TokenKeyVersion === current - 1 && Boolean(process.env.MYOB_TOKEN_KEY_PREVIOUS?.trim());
    if (row.TokenKeyVersion !== current && !previousUsable) {
      return `the tokens were encrypted with key version ${row.TokenKeyVersion}`;
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

export async function getMyobAuthStatus(sqlToken: string | null): Promise<MyobAuthStatus> {
  const connection = await openDbConnection(sqlToken);
  try {
    const row = await readMyobAuthRow(connection);
    if (!row) {
      return {
        authorizedAt: null, authorizedBy: null, businessId: null, companyFileName: null, expiresAt: null,
        isExpired: false, linked: false, myobUsername: null, relinkReason: null, scope: null,
      };
    }
    const reason = relinkReason(row);
    return {
      authorizedAt: row.AuthorizedAt ? row.AuthorizedAt.toISOString() : null,
      authorizedBy: row.LinkedByName ?? row.AuthorizedBy,
      businessId: row.BusinessId,
      companyFileName: row.CompanyFileName,
      expiresAt: row.ExpiresAt.toISOString(),
      isExpired: row.ExpiresAt.getTime() <= Date.now(),
      linked: reason === null,
      myobUsername: row.MyobUsername,
      relinkReason: reason,
      scope: row.Scope,
    };
  } finally {
    closeConnection(connection);
  }
}
