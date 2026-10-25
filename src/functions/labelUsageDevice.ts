// POST /api/labelUsageDevice   { deviceId, label }
//
// Admin names a shared device ("Facilities tablet") so the Devices view can tell it from the rest, or
// clears the name with a blank or null label. The label is only ever a name: it changes nothing
// about what is recorded. Admin only (ACTION_ROLES.manageUsageAnalytics).
//
// 200 { deviceId, label }   400 malformed   404 no such device   401 / 403 role gate

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { callerFromToken } from "../callerFromToken";
import { closeConnection, createRequestConnection, executeQuery } from "../db";

const DEVICE_ID = /^[ds]_[A-Za-z0-9]{16,32}$/;
const MAX_LABEL_CHARS = 80;
const CONTROL = /[\u0000-\u001f\u007f]/;

export async function labelUsageDevice(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACTION_ROLES.manageUsageAnalytics.gate);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { jsonBody: { error: "Send JSON" }, status: 400 };
  }
  const { deviceId, label } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof deviceId !== "string" || !DEVICE_ID.test(deviceId)) return { jsonBody: { error: "deviceId is not a device id" }, status: 400 };
  if (label !== null && label !== undefined && typeof label !== "string") return { jsonBody: { error: "label must be text, or empty to clear it" }, status: 400 };
  const name = typeof label === "string" ? label.trim() : "";
  if (name.length > MAX_LABEL_CHARS || CONTROL.test(name)) return { jsonBody: { error: `A label is plain text of at most ${MAX_LABEL_CHARS} characters` }, status: 400 };

  let connection;
  try {
    connection = await createRequestConnection(token);
    const rows = await executeQuery(
      connection,
      `UPDATE dbo.UsageDevices
          SET Label = @Label, LabelledBy = CASE WHEN @Label IS NULL THEN NULL ELSE @By END, LabelledAt = CASE WHEN @Label IS NULL THEN NULL ELSE SYSUTCDATETIME() END
        WHERE DeviceId = @DeviceId;
       SELECT @@ROWCOUNT AS Changed;`,
      [
        { name: "DeviceId", type: TYPES.NVarChar, value: deviceId },
        { name: "Label", type: TYPES.NVarChar, value: name === "" ? null : name },
        { name: "By", type: TYPES.NVarChar, value: callerFromToken(token).name },
      ],
    );
    if (Number(rows[0]?.Changed ?? 0) === 0) return { jsonBody: { error: "That device is not known" }, status: 404 };
    return { jsonBody: { deviceId, label: name === "" ? null : name }, status: 200 };
  } catch (error: unknown) {
    context.error("labelUsageDevice failed:", error instanceof Error ? error.message : String(error));
    return errorResponse("Could not name the device", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("labelUsageDevice", { authLevel: "anonymous", handler: labelUsageDevice, methods: ["POST"] });
