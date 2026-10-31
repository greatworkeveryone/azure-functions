// The after-hours line: the number a tenant is told to ring about an urgent building problem after hours
// (PLAN §15, Connor 31 Oct 2026). One company setting (dbo.OrgSettings, key 'afterHoursPhone'), no per-building
// override. The emergency numbers 000, 131 444 and 132 500 are constants on the tenant page and never satisfy the
// gate (orgSettings/phone.ts).
// dbo.Buildings.EmergencyPhone (migration 184) is retired: unused since 31 Oct 2026, may be dropped later only with an approved destructive migration.
//
// Who edits: EDIT_AFTER_HOURS_ROLES (orgSettings/roles.ts).
// Mirrored in the frontend as the `editAfterHours` capability (src/constants/action-roles.json).

import { TYPES, type Connection } from "tedious";
import { inTransaction, txOk } from "../assetRegisterSupport";
import { executeQuery } from "../db";
import { record } from "../ledger";
import type { LedgerActor } from "../ledger/types";
import { parseAustralianPhone } from "./phone";

export const AFTER_HOURS_KEY = "afterHoursPhone";
export { EDIT_AFTER_HOURS_ROLES } from "./roles";

export interface AfterHoursApi {
  companyPhone: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export async function companyAfterHours(connection: Connection): Promise<string | null> {
  const [row] = await executeQuery(connection, `SELECT SettingValue FROM dbo.OrgSettings WHERE SettingKey = @Key`, [
    { name: "Key", type: TYPES.NVarChar, value: AFTER_HOURS_KEY },
  ]);
  return parseAustralianPhone(row?.SettingValue);
}

/** Staff-facing reason the tenant page cannot be enabled yet, or null when it can: the company after-hours number exists. */
export async function afterHoursProblem(connection: Connection): Promise<string | null> {
  if ((await companyAfterHours(connection)) !== null) return null;
  return "The tenant page can't be turned on until the after-hours phone number is set. Tenants are told to ring it about urgent building problems after hours. Set it in Admin under Company settings.";
}

export async function readAfterHours(connection: Connection): Promise<AfterHoursApi> {
  const [setting] = await executeQuery(connection, `SELECT SettingValue, UpdatedAt, UpdatedBy FROM dbo.OrgSettings WHERE SettingKey = @Key`, [
    { name: "Key", type: TYPES.NVarChar, value: AFTER_HOURS_KEY },
  ]);
  return {
    companyPhone: setting?.SettingValue == null ? null : String(setting.SettingValue),
    updatedAt: setting?.UpdatedAt instanceof Date ? setting.UpdatedAt.toISOString() : null,
    updatedBy: setting?.UpdatedBy == null ? null : String(setting.UpdatedBy),
  };
}

export type SaveResult = { ok: true } | { error: string; ok: false; status: number };

/** Sets (or clears, with null) the company number. Ledgered old and new. */
export async function saveAfterHours(connection: Connection, input: { actor: LedgerActor; phone: unknown }): Promise<SaveResult> {
  const cleared = input.phone === null || (typeof input.phone === "string" && input.phone.trim() === "");
  const phone = cleared ? null : parseAustralianPhone(input.phone);
  if (!cleared && phone === null) return { error: "That doesn't look like an Australian phone number. Use digits and spaces, for example 08 8941 1234 or 0412 345 678.", ok: false, status: 400 };
  const out = await inTransaction<true>(connection, async () => {
    const [row] = await executeQuery(connection, `SELECT SettingValue FROM dbo.OrgSettings WITH (UPDLOCK, HOLDLOCK) WHERE SettingKey = @Key`, [
      { name: "Key", type: TYPES.NVarChar, value: AFTER_HOURS_KEY },
    ]);
    const before = row?.SettingValue == null ? null : String(row.SettingValue);
    await executeQuery(
      connection,
      `MERGE dbo.OrgSettings AS t USING (SELECT @Key AS SettingKey) AS s ON t.SettingKey = s.SettingKey
       WHEN MATCHED THEN UPDATE SET SettingValue = @Value, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @By
       WHEN NOT MATCHED THEN INSERT (SettingKey, SettingValue, UpdatedBy) VALUES (@Key, @Value, @By);`,
      [
        { name: "Key", type: TYPES.NVarChar, value: AFTER_HOURS_KEY },
        { name: "Value", type: TYPES.NVarChar, value: phone },
        { name: "By", type: TYPES.NVarChar, value: input.actor.name },
      ],
    );
    await record(connection, {
      action: "settings.after_hours_set",
      actor: input.actor,
      after: { phone, scope: "company" },
      before: { phone: before, scope: "company" },
      subject: { id: AFTER_HOURS_KEY, type: "org_setting" },
    });
    return txOk(true as const);
  });
  return out.ok ? { ok: true } : { error: (out.response.jsonBody as { error: string }).error, ok: false, status: out.response.status ?? 500 };
}
