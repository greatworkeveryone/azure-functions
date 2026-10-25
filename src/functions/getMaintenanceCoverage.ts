import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { authorize, badRequest } from "../assetRegisterSupport";
import { errorResponse } from "../auth";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { VIEW_FACILITIES_ROLES } from "../facilitiesRoles";
export async function getMaintenanceCoverage(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorize(request, VIEW_FACILITIES_ROLES);
  if (!auth.ok) return auth.response;
  const raw = request.query.get("buildingId");
  const buildingId = raw === null ? null : Number(raw);
  if (
    buildingId !== null &&
    (!Number.isInteger(buildingId) || !buildingId || Math.abs(buildingId) > 2147483647)
  )
    return badRequest("Invalid building");
  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const rows = await executeQuery(
      connection,
      "SELECT c.BuildingId,c.PlanJson,c.Revision,c.UpdatedAt,c.UpdatedBy FROM dbo.MaintenanceCoverage c JOIN dbo.Buildings b ON b.BuildingID=c.BuildingId WHERE b.Active=1 AND (@Building IS NULL OR c.BuildingId=@Building)",
      [{ name: "Building", type: TYPES.Int, value: buildingId }],
    );
    const contractorRows = await executeQuery(
      connection,
      "SELECT ContractorId,CoverageJson,Revision,UpdatedAt,UpdatedBy FROM dbo.ContractorCoverage",
    );
    return {
      status: 200,
      jsonBody: {
        contractors: contractorRows.map((row) => ({
          contractorId: Number(row.ContractorId),
          ...JSON.parse(row.CoverageJson),
          revision: row.Revision,
          updatedAt: row.UpdatedAt,
          updatedBy: row.UpdatedBy,
        })),
        coverage: rows.map((row) => ({
          buildingId: Number(row.BuildingId),
          trades: JSON.parse(row.PlanJson),
          revision: row.Revision,
          updatedAt: row.UpdatedAt,
          updatedBy: row.UpdatedBy,
        })),
      },
    };
  } catch (error) {
    context.error("Maintenance coverage read failed", error);
    return errorResponse("Could not load contractor coverage", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}
app.http("getMaintenanceCoverage", {
  authLevel: "anonymous",
  handler: getMaintenanceCoverage,
  methods: ["GET"],
});
