import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";

// The usageAnalytics flag, checked on the server (privacy review L2). The browser only starts recording when the flag
// is enabled for the person's role, but a modified browser could send anyway, so the server asks the same question
// before it writes. The flag ships hidden: no row for the role means not enabled, and only an enabled row counts
// (preview and hidden do not), as in the frontend's beacon. Most permissive row wins, like resolveFeatureVisibility.

export async function usageFlagEnabledFor(connection: Connection, roles: readonly string[]): Promise<boolean> {
  if (roles.length === 0) return false;
  const rows = await executeQuery(
    connection,
    `SELECT Visibility FROM dbo.FeatureFlags WHERE FeatureKey = N'usageAnalytics' AND LOWER(RoleName) IN (SELECT value FROM OPENJSON(@Roles))`,
    [{ name: "Roles", type: TYPES.NVarChar, value: JSON.stringify(roles.map((role) => role.toLowerCase())) }],
  );
  return rows.some((row) => row.Visibility === "enabled");
}
