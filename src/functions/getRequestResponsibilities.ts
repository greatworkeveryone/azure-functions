// GET /api/getRequestResponsibilities?workRequestId=N  (TR7, PLAN §15)
// For the Incoming request panel's "Who pays?" block: the tenancy a request came from (a tenant's personal link names
// it, SourceTenantId), the maintenance category the tenant's choice maps to, and that tenancy's live responsibilities.
// A request with no known tenancy answers { tenantId: null, items: [] }. Read-only; same roles as the tenancy list.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { authorize } from "../assetRegisterSupport";
import { executeQuery } from "../db";
import { refusal, runStaff } from "../tenantLinks/http";
import { tradeForRequestCategory } from "../tenancyResponsibilities/parse";
import { RESPONSIBILITIES_FLAG, VIEW_RESPONSIBILITIES_ROLES } from "../tenancyResponsibilities/roles";
import { listResponsibilities } from "../tenancyResponsibilities/store";

export async function getRequestResponsibilities(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorize(request, VIEW_RESPONSIBILITIES_ROLES);
  if (!auth.ok) return auth.response;
  return runStaff(request, context, "getRequestResponsibilities", auth.token, false, async ({ connection }) => {
    const raw = request.query.get("workRequestId");
    if (raw === null || !/^-?[1-9]\d{0,9}$/.test(raw) || Math.abs(Number(raw)) > 2_147_483_647) return refusal(400, "workRequestId must be a whole number");
    const [row] = await executeQuery(
      connection,
      `SELECT wr.SourceTenantId, COALESCE(wr.TenantCategory, wr.TriageCategory) AS RequestCategory, t.LegalName
         FROM dbo.WorkRequests wr LEFT JOIN dbo.Tenants t ON t.TenantId = wr.SourceTenantId
        WHERE wr.WorkRequestID = @Id`,
      [{ name: "Id", type: TYPES.Int, value: Number(raw) }],
    );
    if (!row) return refusal(404, "Request not found");
    if (row.SourceTenantId == null || row.LegalName == null) {
      return { headers: { "Cache-Control": "no-store" }, jsonBody: { category: null, items: [], tenancyName: null, tenantId: null }, status: 200 };
    }
    const tenantId = Number(row.SourceTenantId);
    const items = (await listResponsibilities(connection, tenantId)).filter((item) => item.archivedAt === null);
    const key = row.RequestCategory == null ? null : String(row.RequestCategory);
    return {
      headers: { "Cache-Control": "no-store" },
      jsonBody: { category: tradeForRequestCategory(key), items, tenancyName: String(row.LegalName), tenantId },
      status: 200,
    };
  }, RESPONSIBILITIES_FLAG);
}

app.http("getRequestResponsibilities", { authLevel: "anonymous", handler: getRequestResponsibilities, methods: ["GET"] });
