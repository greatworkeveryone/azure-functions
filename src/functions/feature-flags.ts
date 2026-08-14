// src/functions/feature-flags.ts
//
// Staged-rollout gates: which modules each role can see, edited from the
// Admin → Features console in the frontend. Rows only ever NARROW what the
// capability map already permits — the frontend fails open to its code
// defaults when this endpoint is unreachable, so flags are a rollout tool,
// not a security boundary. Enforcement stays on each endpoint's role gate.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createConnection, executeQuery } from "../db";
import {
  AppRole,
  errorResponse,
  extractToken,
  requireRole,
  unauthorizedResponse,
  userInfoFromToken,
} from "../auth";

const VISIBILITIES = ["enabled", "preview", "hidden"] as const;

// Mirror of AppRole values + FeatureKey in command-centre src/constants —
// an allowlist rather than free text, because a typo'd row gates nothing
// while quietly reading as "configured".
const ROLE_NAMES: readonly string[] = Object.values(AppRole);
const FEATURE_KEYS = [
  "activity", "incoming", "inspections", "jobs", "keys", "maintenance",
  "payroll", "procedures", "quotes", "tenancySchedule", "tenancyVacancies",
  "timesheets",
] as const;

export async function getFeatureFlags(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT FeatureKey, RoleName, Visibility, UpdatedAt, UpdatedBy FROM dbo.FeatureFlags`,
    );

    const featureFlags = rows
      // A row with an unrecognised visibility would resolve to "hidden" on the
      // client and silently remove a module from everyone holding that role —
      // drop it so a bad hand-edit degrades to the code default instead.
      .filter((row) => VISIBILITIES.includes(String(row.Visibility) as never))
      .map((row) => ({
        featureKey: String(row.FeatureKey),
        roleName: String(row.RoleName).trim().toLowerCase(),
        updatedAt: row.UpdatedAt ? new Date(row.UpdatedAt as Date).toISOString() : undefined,
        updatedBy: row.UpdatedBy ?? undefined,
        visibility: String(row.Visibility),
      }));

    return { status: 200, jsonBody: { featureFlags } };
  } catch (error: any) {
    context.error("getFeatureFlags failed:", error.message);
    return errorResponse("Get feature flags failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

export async function upsertFeatureFlag(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  // Admin only — matches the frontend's viewAdmin gate on the Features
  // console. Director deliberately does not pass an [ADMIN]-only gate.
  const denied = await requireRole(request, [AppRole.ADMIN]);
  if (denied) return denied;

  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const featureKey = String(body?.featureKey ?? "");
    const roleName = String(body?.roleName ?? "").trim().toLowerCase();
    const visibility = String(body?.visibility ?? "");

    if (!FEATURE_KEYS.includes(featureKey as never)) {
      return { status: 400, jsonBody: { error: `Unknown featureKey: ${featureKey}` } };
    }
    if (!ROLE_NAMES.includes(roleName)) {
      return { status: 400, jsonBody: { error: `Unknown roleName: ${roleName}` } };
    }
    if (!VISIBILITIES.includes(visibility as never)) {
      return { status: 400, jsonBody: { error: `Unknown visibility: ${visibility}` } };
    }

    const editor = userInfoFromToken(token);

    connection = await createConnection(token);
    await executeQuery(
      connection,
      `MERGE dbo.FeatureFlags AS target
       USING (SELECT @FeatureKey AS FeatureKey, @RoleName AS RoleName) AS src
         ON target.FeatureKey = src.FeatureKey AND target.RoleName = src.RoleName
       WHEN MATCHED THEN
         UPDATE SET Visibility = @Visibility, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @UpdatedBy
       WHEN NOT MATCHED THEN
         INSERT (FeatureKey, RoleName, Visibility, UpdatedBy)
         VALUES (@FeatureKey, @RoleName, @Visibility, @UpdatedBy);`,
      [
        { name: "FeatureKey", type: TYPES.NVarChar, value: featureKey },
        { name: "RoleName", type: TYPES.NVarChar, value: roleName },
        { name: "Visibility", type: TYPES.NVarChar, value: visibility },
        { name: "UpdatedBy", type: TYPES.NVarChar, value: editor?.email ?? editor?.name ?? null },
      ],
    );

    return { status: 200, jsonBody: { ok: true } };
  } catch (error: any) {
    context.error("upsertFeatureFlag failed:", error.message);
    return errorResponse("Upsert feature flag failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getFeatureFlags", { methods: ["GET"], authLevel: "anonymous", handler: getFeatureFlags });
app.http("upsertFeatureFlag", { methods: ["POST"], authLevel: "anonymous", handler: upsertFeatureFlag });
