// src/functions/approval-limits.ts
//
// Admin-only endpoint to upsert a row in dbo.ApprovalLimits. Idempotent.
// The Roles admin page calls this when an admin edits a per-role limit.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { createConnection, executeQuery, closeConnection } from "../db";
import { extractToken, unauthorizedResponse, errorResponse, rolesForRequest } from "../auth";

interface SetApprovalLimitBody {
  RoleName: string;
  /** null = unlimited authority. Numeric values must be >= 0. */
  MaxApprovalAmount: number | null;
}

async function setApprovalLimit(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const userRoles = rolesForRequest(request);
  if (!userRoles.includes("Admin")) {
    return { status: 403, jsonBody: { error: "Admin role required" } };
  }

  let connection;
  try {
    const body = (await request.json()) as SetApprovalLimitBody;
    const { RoleName, MaxApprovalAmount } = body ?? {};
    if (typeof RoleName !== "string" || !RoleName.trim()) {
      return { status: 400, jsonBody: { error: "RoleName (non-empty string) required" } };
    }
    if (MaxApprovalAmount !== null && (typeof MaxApprovalAmount !== "number" || MaxApprovalAmount < 0)) {
      return { status: 400, jsonBody: { error: "MaxApprovalAmount must be null or a non-negative number" } };
    }

    connection = await createConnection(token);

    await executeQuery(
      connection,
      `MERGE dbo.ApprovalLimits AS target
       USING (SELECT @RoleName AS RoleName) AS src
         ON target.RoleName = src.RoleName
       WHEN MATCHED THEN
         UPDATE SET MaxApprovalAmount = @MaxApprovalAmount
       WHEN NOT MATCHED THEN
         INSERT (RoleName, MaxApprovalAmount) VALUES (@RoleName, @MaxApprovalAmount);`,
      [
        { name: "RoleName", type: TYPES.NVarChar, value: RoleName },
        { name: "MaxApprovalAmount", type: TYPES.Decimal, value: MaxApprovalAmount },
      ],
    );

    return { status: 200, jsonBody: { ok: true, roleName: RoleName, maxApprovalAmount: MaxApprovalAmount } };
  } catch (error: any) {
    context.error("setApprovalLimit failed:", error.message);
    return errorResponse("Set approval limit failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("setApprovalLimit", { methods: ["POST"], authLevel: "anonymous", handler: setApprovalLimit });
