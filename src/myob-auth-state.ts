// The OAuth `state` for linking MYOB: random, single-use, bound to the admin
// who started the link, and valid for 10 minutes (SEC-15, MYOB N3).
//
// Only a SHA-256 of the state is stored (dbo.MyobAuthStates, migration 124),
// with the starting admin's Entra oid and name. The callback consumes it with
// one UPDATE ... OUTPUT, so a replayed or second callback finds nothing.
// Rows are never deleted: each is a record of who started a link and when.

import { createHash, randomBytes } from "crypto";
import { TYPES } from "tedious";
import { closeConnection, createServiceRequestConnection, executeQuery } from "./db";

export const STATE_TTL_SECONDS = 10 * 60;
const MAX_STATE_CHARS = 200;

export interface AuthStateOwner {
  name: string;
  oid: string;
}

function hashState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

export async function createAuthState(owner: AuthStateOwner): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  const connection = await createServiceRequestConnection();
  try {
    await executeQuery(
      connection,
      `INSERT INTO dbo.MyobAuthStates (StateHash, StartedByOid, StartedByName, ExpiresAt)
       VALUES (@StateHash, @Oid, @Name, DATEADD(SECOND, @TtlSeconds, SYSUTCDATETIME()))`,
      [
        { name: "StateHash", type: TYPES.Char, value: hashState(state) },
        { name: "Oid", type: TYPES.NVarChar, value: owner.oid.slice(0, 100) },
        { name: "Name", type: TYPES.NVarChar, value: owner.name.slice(0, 200) },
        { name: "TtlSeconds", type: TYPES.Int, value: STATE_TTL_SECONDS },
      ],
    );
  } finally {
    closeConnection(connection);
  }
  return state;
}

/** Marks the state used and returns who started the link; null when it is unknown, used or expired. */
export async function consumeAuthState(state: string): Promise<AuthStateOwner | null> {
  if (!state || state.length > MAX_STATE_CHARS) return null;
  const connection = await createServiceRequestConnection();
  try {
    const rows = await executeQuery(
      connection,
      `UPDATE dbo.MyobAuthStates
          SET ConsumedAt = SYSUTCDATETIME()
       OUTPUT inserted.StartedByOid, inserted.StartedByName
        WHERE StateHash = @StateHash AND ConsumedAt IS NULL AND ExpiresAt > SYSUTCDATETIME()`,
      [{ name: "StateHash", type: TYPES.Char, value: hashState(state) }],
    );
    const row = rows[0];
    if (!row) return null;
    return { name: String(row.StartedByName), oid: String(row.StartedByOid) };
  } finally {
    closeConnection(connection);
  }
}
