// The after-hours line: the number a tenant is told to ring about an urgent building problem after hours
// (PLAN §15, Connor 31 Oct 2026). One company setting (dbo.OrgSettings, key 'afterHoursPhone') plus an
// optional per-building override (dbo.Buildings.EmergencyPhone, "After-hours line for this building").
// 000 and 131 444 are constants on the tenant page and never satisfy the gate.
//
// Who edits: ADMIN, DIRECTOR and FACILITIES_APPROVAL (the facilities manager, the role that approves work).
// Mirrored in the frontend as the `editAfterHours` capability (src/constants/action-roles.json).

import { TYPES, type Connection } from "tedious";
import { inTransaction, txFail, txOk } from "../assetRegisterSupport";
import { AppRole } from "../auth";
import { executeQuery } from "../db";
import { record } from "../ledger";
import type { LedgerActor } from "../ledger/types";
import { parseAustralianPhone } from "./phone";

export const AFTER_HOURS_KEY = "afterHoursPhone";
export const EDIT_AFTER_HOURS_ROLES = [AppRole.ADMIN, AppRole.DIRECTOR, AppRole.FACILITIES_APPROVAL] as const;

export interface AfterHoursApi {
  buildings: { buildingId: number; buildingName: string; phone: string | null }[];
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

/** The building's override, else the company number; null when neither is a usable number. */
export async function afterHoursFor(connection: Connection, buildingId: number): Promise<string | null> {
  const [row] = await executeQuery(connection, `SELECT EmergencyPhone FROM dbo.Buildings WHERE BuildingID = @BuildingId`, [
    { name: "BuildingId", type: TYPES.Int, value: buildingId },
  ]);
  return parseAustralianPhone(row?.EmergencyPhone) ?? (await companyAfterHours(connection));
}

/**
 * Staff-facing reason the tenant page cannot be enabled yet, or null when it can: a company after-hours
 * number exists, or every building with an active tenancy has its own.
 */
export async function afterHoursProblem(connection: Connection): Promise<string | null> {
  if ((await companyAfterHours(connection)) !== null) return null;
  const rows = await executeQuery(
    connection,
    `SELECT b.BuildingName, b.EmergencyPhone FROM dbo.Buildings b
      WHERE EXISTS (SELECT 1 FROM dbo.Tenants t WHERE t.BuildingID = b.BuildingID AND t.ArchivedAt IS NULL)`,
  );
  const missing = rows.filter((r) => parseAustralianPhone(r.EmergencyPhone) === null).map((r) => String(r.BuildingName ?? "a building"));
  if (rows.length > 0 && missing.length === 0) return null;
  const where = missing.length > 0 ? ` (missing for: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " and others" : ""})` : "";
  return `The tenant page can't be turned on until the after-hours phone number is set. Tenants are told to ring it about urgent building problems after hours. Set it in Admin under Company settings, or give every building with tenants its own${where}.`;
}

export async function readAfterHours(connection: Connection): Promise<AfterHoursApi> {
  const [setting] = await executeQuery(connection, `SELECT SettingValue, UpdatedAt, UpdatedBy FROM dbo.OrgSettings WHERE SettingKey = @Key`, [
    { name: "Key", type: TYPES.NVarChar, value: AFTER_HOURS_KEY },
  ]);
  const buildings = await executeQuery(connection, `SELECT BuildingID, BuildingName, EmergencyPhone FROM dbo.Buildings WHERE Active = 1 ORDER BY BuildingName`);
  return {
    buildings: buildings.map((b) => ({ buildingId: Number(b.BuildingID), buildingName: String(b.BuildingName ?? ""), phone: b.EmergencyPhone == null ? null : String(b.EmergencyPhone) })),
    companyPhone: setting?.SettingValue == null ? null : String(setting.SettingValue),
    updatedAt: setting?.UpdatedAt instanceof Date ? setting.UpdatedAt.toISOString() : null,
    updatedBy: setting?.UpdatedBy == null ? null : String(setting.UpdatedBy),
  };
}

export type SaveResult = { ok: true } | { error: string; ok: false; status: number };

/** Sets (or clears, with null) the company number, or a building's override when buildingId is given. Ledgered old and new. */
export async function saveAfterHours(
  connection: Connection,
  input: { actor: LedgerActor; buildingId: number | null; phone: unknown },
): Promise<SaveResult> {
  const cleared = input.phone === null || (typeof input.phone === "string" && input.phone.trim() === "");
  const phone = cleared ? null : parseAustralianPhone(input.phone);
  if (!cleared && phone === null) return { error: "That doesn't look like an Australian phone number. Use digits and spaces, for example 08 8941 1234 or 0412 345 678.", ok: false, status: 400 };
  const out = await inTransaction<true>(connection, async () => {
    let before: string | null;
    let buildingName: string | null = null;
    if (input.buildingId === null) {
      const [row] = await executeQuery(connection, `SELECT SettingValue FROM dbo.OrgSettings WITH (UPDLOCK, HOLDLOCK) WHERE SettingKey = @Key`, [
        { name: "Key", type: TYPES.NVarChar, value: AFTER_HOURS_KEY },
      ]);
      before = row?.SettingValue == null ? null : String(row.SettingValue);
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
    } else {
      const [row] = await executeQuery(connection, `SELECT BuildingName, EmergencyPhone FROM dbo.Buildings WITH (UPDLOCK, HOLDLOCK) WHERE BuildingID = @Id AND Active = 1`, [
        { name: "Id", type: TYPES.Int, value: input.buildingId },
      ]);
      if (!row) return txFail({ jsonBody: { error: "Building not found" }, status: 404 });
      before = row.EmergencyPhone == null ? null : String(row.EmergencyPhone);
      buildingName = String(row.BuildingName ?? "");
      await executeQuery(connection, `UPDATE dbo.Buildings SET EmergencyPhone = @Value WHERE BuildingID = @Id`, [
        { name: "Value", type: TYPES.NVarChar, value: phone },
        { name: "Id", type: TYPES.Int, value: input.buildingId },
      ]);
    }
    await record(connection, {
      action: "settings.after_hours_set",
      actor: input.actor,
      after: { buildingName, phone, scope: input.buildingId === null ? "company" : "building" },
      before: { buildingName, phone: before, scope: input.buildingId === null ? "company" : "building" },
      buildingId: input.buildingId,
      subject: { id: input.buildingId === null ? AFTER_HOURS_KEY : `${AFTER_HOURS_KEY}:${input.buildingId}`, type: "org_setting" },
    });
    return txOk(true as const);
  });
  return out.ok ? { ok: true } : { error: (out.response.jsonBody as { error: string }).error, ok: false, status: out.response.status ?? 500 };
}
