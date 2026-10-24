import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import {
  authorizeWrite,
  badRequest,
  conflict,
  inTransaction,
  readJsonBody,
  txFail,
  txOk,
} from "../assetRegisterSupport";
import type { ReportingLink } from "../leavePolicy";
import { REPORTING_ROLES, droppedReportingLinks, parseReporting, validRevision } from "../leavePolicy";
import { loadPeople, peopleAudit } from "../peopleWorkflow";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
export async function saveStaffReporting(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, REPORTING_ROLES);
  if (!auth.ok) return auth.response;
  const body = await readJsonBody(request);
  if (!body || !validRevision(body.revision) || !Array.isArray(body.links) || body.links.length > 500)
    return badRequest("Reporting relationships and current revision required");
  let connection;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const result = await inTransaction(conn, async () => {
      const before = await loadPeople(conn, true);
      if (before.revision !== body.revision)
        return txFail(conflict("Reporting changed. Reload before saving."));
      let links;
      try {
        links = parseReporting(body, before.staff);
      } catch (error) {
        return txFail(badRequest((error as Error).message));
      }
      const revision = before.revision + 1;
      await executeQuery(
        conn,
        "UPDATE dbo.StaffReporting SET LinksJson=@Links,Revision=@Revision,UpdatedAt=SYSUTCDATETIME(),UpdatedBy=@Actor WHERE Id=1",
        [
          { name: "Links", type: TYPES.NVarChar, value: JSON.stringify(links) },
          { name: "Revision", type: TYPES.Int, value: revision },
          { name: "Actor", type: TYPES.NVarChar, value: auth.caller.name },
        ],
      );
      const dropped = droppedReportingLinks(body.links as ReportingLink[], links);
      await peopleAudit(conn, auth.caller, "reporting", 1, "change", before.links, {
        links,
        revision,
        ...(dropped.length ? { droppedInactiveLinks: dropped } : {}),
      });
      return txOk({ saved: true, revision });
    });
    return result.ok ? { status: 200, jsonBody: result.value } : result.response;
  } catch (error) {
    context.error("Reporting save failed", error);
    return {
      status: 500,
      jsonBody: { error: "Could not save the reporting structure" },
    };
  } finally {
    if (connection) closeConnection(connection);
  }
}
app.http("saveStaffReporting", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: saveStaffReporting,
});
