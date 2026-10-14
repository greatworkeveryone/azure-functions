// POST /api/setAccessProfile   (Admin → Users → "Access profile", S10)
//
//   { userId: number, profile: AccessProfile | null }   null = back to the role default
//
// 200 { userId, profile, isDefault }. The change and its access.profile_change
// ledger row commit together; saving what is already stored writes nothing.
// Gate: ACCESS_MANAGE_ROLES (admin).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { defaultAccessProfile, parseStoredProfile, validateAccessProfile, type AccessProfile } from "../access/profile";
import { ACCESS_MANAGE_ROLES, lockAccessProfile, saveAccessProfile } from "../access/store";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createRequestConnection,
  rollbackTransaction,
} from "../db";
import { LedgerValidationError, record } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";

type Parsed = { profile: AccessProfile | null; userId: number } | string;

async function readBody(request: HttpRequest): Promise<Parsed> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return "A JSON body is required";
  }
  const raw = (body ?? {}) as { profile?: unknown; userId?: unknown };
  if (typeof raw.userId !== "number" || !Number.isInteger(raw.userId) || raw.userId < 1) {
    return "userId (positive whole number) is required";
  }
  if (raw.profile === null) return { profile: null, userId: raw.userId };
  const checked = validateAccessProfile(raw.profile);
  return checked.ok ? { profile: checked.profile, userId: raw.userId } : checked.error;
}

export async function setAccessProfile(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACCESS_MANAGE_ROLES);
  if (denied) return denied;

  const parsed = await readBody(request);
  if (typeof parsed === "string") return { status: 400, jsonBody: { error: parsed } };
  const { profile, userId } = parsed;

  let connection;
  try {
    connection = await createRequestConnection(token);
    const actor = await resolveLedgerActor(request, connection);
    if (!actor) return unauthorizedResponse();

    await beginTransaction(connection);
    let role: string | null;
    try {
      const current = await lockAccessProfile(connection, userId);
      if (!current) {
        await rollbackTransaction(connection);
        return { status: 404, jsonBody: { error: "No active user with that id" } };
      }
      role = current.role;
      const nextText = profile ? JSON.stringify(profile) : null;
      if (nextText !== current.stored) {
        await saveAccessProfile(connection, userId, profile);
        await record(connection, {
          action: "access.profile_change",
          actor,
          after: { isDefault: profile === null, profile: profile ?? defaultAccessProfile(role) },
          before: { isDefault: current.stored === null, profile: parseStoredProfile(current.stored, role) },
          subject: { id: userId, type: "app_user" },
        });
      }
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    return {
      status: 200,
      jsonBody: { isDefault: profile === null, profile: profile ?? defaultAccessProfile(role), userId },
    };
  } catch (error: unknown) {
    if (error instanceof LedgerValidationError) return { status: 400, jsonBody: { error: error.message } };
    context.error("setAccessProfile failed:", error instanceof Error ? error.message : String(error));
    return errorResponse("Could not save the access profile", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("setAccessProfile", { methods: ["POST"], authLevel: "anonymous", handler: setAccessProfile });
