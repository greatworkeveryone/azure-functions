// GET /api/getOfficeClosures  (PLAN §15, Connor 31 Oct 2026)
// Office closures, earliest first, archived ones included (the page greys them). Anyone signed in may read.
// Response: { closures: OfficeClosureApi[] }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { authorize } from "../assetRegisterSupport";
import { AppRole } from "../auth";
import { listClosures } from "../officeClosures/closures";
import { runStaff } from "../tenantLinks/http";

export async function getOfficeClosures(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorize(request, Object.values(AppRole));
  if (!auth.ok) return auth.response;
  return runStaff(request, context, "getOfficeClosures", auth.token, false, async ({ connection }) => ({ jsonBody: { closures: await listClosures(connection) }, status: 200 }), null);
}

app.http("getOfficeClosures", { authLevel: "anonymous", handler: getOfficeClosures, methods: ["GET"] });
