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
import { LEAVE_READ_ROLES, leaveApprovers, validRevision } from "../leavePolicy";
import { loadPeople, peopleAudit } from "../peopleWorkflow";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
export async function decideLeaveRequest(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, LEAVE_READ_ROLES);
  if (!auth.ok) return auth.response;
  const body = await readJsonBody(request);
  if (
    !body ||
    !Number.isInteger(body.id) ||
    Number(body.id) <= 0 ||
    Number(body.id) > 2147483647 ||
    !validRevision(body.revision) ||
    !["approve", "decline", "withdraw"].includes(String(body.action)) ||
    typeof body.note !== "string" ||
    body.note.length > 500
  )
    return badRequest("Request, revision, action and note required");
  if (body.action === "decline" && !body.note.trim()) return badRequest("Give a short reason for declining");
  const note = body.note.trim();
  let connection;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const result = await inTransaction(conn, async () => {
      const data = await loadPeople(conn, true),
        self = data.staff.find((person) => person.oid === auth.caller.oid);
      const params = [{ name: "Id", type: TYPES.Int, value: body.id }];
      const row = (
        await executeQuery(
          conn,
          "SELECT UserId,Status,Revision FROM dbo.LeaveRequests WITH (UPDLOCK,HOLDLOCK) WHERE RequestId=@Id",
          params,
        )
      )[0];
      if (!row) return txFail({ status: 404, jsonBody: { error: "Request unavailable" } });
      const owner = data.staff.find((person) => person.id === row.UserId),
        own = self?.id === row.UserId;
      if (
        !self ||
        (body.action === "withdraw"
          ? !own
          : !owner || !leaveApprovers(owner, data.staff, data.links).some((person) => person.id === self.id))
      )
        return txFail({ status: 403, jsonBody: { error: "You cannot make this decision" } });
      if (row.Revision !== body.revision) return txFail(conflict("Request changed. Reload before deciding."));
      if (
        body.action === "withdraw" ? !["pending", "approved"].includes(row.Status) : row.Status !== "pending"
      )
        return txFail(conflict("This request is no longer available for that action"));
      const status =
        body.action === "approve" ? "approved" : body.action === "decline" ? "declined" : "withdrawn";
      await executeQuery(
        conn,
        "UPDATE dbo.LeaveRequests SET Status=@Status,Revision=Revision+1,UpdatedAt=SYSUTCDATETIME(),DecidedBy=@Actor,DecisionNote=@Note WHERE RequestId=@Id",
        [
          ...params,
          { name: "Status", type: TYPES.NVarChar, value: status },
          { name: "Actor", type: TYPES.NVarChar, value: auth.caller.name },
          { name: "Note", type: TYPES.NVarChar, value: note },
        ],
      );
      await peopleAudit(conn, auth.caller, "leave", Number(body.id), String(body.action), row, {
        status,
        reportingRevision: data.revision,
      });
      return txOk({ saved: true });
    });
    return result.ok ? { status: 200, jsonBody: result.value } : result.response;
  } catch (error) {
    context.error("Leave decision failed", error);
    return { status: 500, jsonBody: { error: "Could not record the leave decision" } };
  } finally {
    if (connection) closeConnection(connection);
  }
}
app.http("decideLeaveRequest", { methods: ["POST"], authLevel: "anonymous", handler: decideLeaveRequest });
