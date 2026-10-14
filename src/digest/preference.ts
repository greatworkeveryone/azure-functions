// A person's own digest switch (AppUsers.DigestOptOut, migration 132). The row is
// found by the verified token's object id, never by anything the client sends.
// NULL (never chose) reads as "receives it".

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";

const oidParam = (oid: string) => ({ name: "Oid", type: TYPES.NVarChar, value: oid });

/** True when the person opted out; null when no active user has this sign-in. */
export async function readDigestOptOut(connection: Connection, oid: string): Promise<boolean | null> {
  const rows = await executeQuery(
    connection,
    "SELECT DigestOptOut FROM dbo.AppUsers WHERE EntraOid = @Oid AND IsActive = 1",
    [oidParam(oid)],
  );
  return rows.length === 0 ? null : Boolean(rows[0].DigestOptOut);
}

/** Sets the switch and returns it as stored; null when no active user has this sign-in. */
export async function writeDigestOptOut(connection: Connection, oid: string, optOut: boolean): Promise<boolean | null> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.AppUsers SET DigestOptOut = @OptOut WHERE EntraOid = @Oid AND IsActive = 1;
     SELECT DigestOptOut FROM dbo.AppUsers WHERE EntraOid = @Oid AND IsActive = 1;`,
    [{ name: "OptOut", type: TYPES.Bit, value: optOut }, oidParam(oid)],
  );
  return rows.length === 0 ? null : Boolean(rows[0].DigestOptOut);
}
