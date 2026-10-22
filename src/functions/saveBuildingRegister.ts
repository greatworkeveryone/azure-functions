import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import {
  authorizeWrite,
  badRequest,
  conflict,
  inTransaction,
  notFound,
  readJsonBody,
  txFail,
  txOk,
} from "../assetRegisterSupport";
import { errorResponse } from "../auth";
import { closeConnection, createRequestConnection, executeQuery, type SqlParam } from "../db";
import { MANAGE_ASSET_TYPES_ROLES } from "../assetRegister";
import { parseBuildingProfile } from "../buildingRegister";
export async function saveBuildingRegister(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, MANAGE_ASSET_TYPES_ROLES);
  if (!auth.ok) return auth.response;
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  let input;
  try {
    input = parseBuildingProfile(body);
  } catch (error) {
    return badRequest((error as Error).message);
  }
  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const result = await inTransaction(conn, async () => {
      const params: SqlParam[] = [{ name: "Building", type: TYPES.Int, value: input.buildingId }];
      if (
        !(
          await executeQuery(
            conn,
            "SELECT BuildingID FROM dbo.Buildings WITH (UPDLOCK,HOLDLOCK) WHERE BuildingID=@Building AND Active=1",
            params,
          )
        ).length
      )
        return txFail(notFound("Building unavailable"));
      const before = (
        await executeQuery(
          conn,
          "SELECT ProfileJson,Revision FROM dbo.BuildingRegister WITH (UPDLOCK,HOLDLOCK) WHERE BuildingId=@Building",
          params,
        )
      )[0];
      if ((before?.Revision ?? 0) !== input.revision)
        return txFail(conflict("Building details changed. Reload before saving."));
      const revision = input.revision + 1;
      params.push(
        { name: "Plan", type: TYPES.NVarChar, value: JSON.stringify(input.profile) },
        { name: "Revision", type: TYPES.Int, value: revision },
        { name: "Actor", type: TYPES.NVarChar, value: auth.caller.name },
        { name: "Oid", type: TYPES.NVarChar, value: auth.caller.oid },
        { name: "Before", type: TYPES.NVarChar, value: before?.ProfileJson ?? null },
      );
      await executeQuery(
        conn,
        before
          ? "UPDATE dbo.BuildingRegister SET ProfileJson=@Plan,Revision=@Revision,UpdatedAt=SYSUTCDATETIME(),UpdatedBy=@Actor,UpdatedByOid=@Oid WHERE BuildingId=@Building"
          : "INSERT dbo.BuildingRegister(BuildingId,ProfileJson,Revision,UpdatedBy,UpdatedByOid) VALUES (@Building,@Plan,@Revision,@Actor,@Oid)",
        params,
      );
      await executeQuery(
        conn,
        "INSERT dbo.BuildingRegisterAudit(BuildingId,Revision,BeforeJson,AfterJson,ActorName,ActorOid) VALUES (@Building,@Revision,@Before,@Plan,@Actor,@Oid)",
        params,
      );
      return txOk({ saved: true, revision });
    });
    return result.ok ? { status: 200, jsonBody: result.value } : result.response;
  } catch (error) {
    context.error("Building register save failed", error);
    return errorResponse("Could not save building details", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}
app.http("saveBuildingRegister", {
  authLevel: "anonymous",
  handler: saveBuildingRegister,
  methods: ["POST"],
});
