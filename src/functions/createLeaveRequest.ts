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
import { LEAVE_READ_ROLES, leaveApprovers, parseLeave } from "../leavePolicy";
import { loadPeople, peopleAudit } from "../peopleWorkflow";
import { APPROVAL_POLICIES, APPROVAL_SUBJECTS } from "../escalation/approvals/policies";
import { raiseApproval } from "../escalation/approvals/raise";
import { ledgerUserActor } from "../ledger/actor";
import { checkRateLimit } from "../rateLimit";
import { tooManyRequests } from "../rateLimitResponse";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
export async function createLeaveRequest(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, LEAVE_READ_ROLES);
  if (!auth.ok) return auth.response;
  const limited = checkRateLimit(`leave:${auth.caller.oid}`, { limit: 20, windowMs: 60000 });
  if (!limited.allowed)
    return tooManyRequests(limited.retryAfterMs, "Too many leave requests. Try again shortly.");
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  let input;
  try {
    input = parseLeave(body);
  } catch (error) {
    return badRequest((error as Error).message);
  }
  let connection;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const held: { asked?: { approvers: { id: number; name: string }[]; requesterId: number; requesterName: string; requesterRole: string } } = {};
    const result = await inTransaction(conn, async () => {
      const data = await loadPeople(conn, true),
        self = data.staff.find((person) => person.oid === auth.caller.oid);
      if (!self) return txFail({ status: 403, jsonBody: { error: "An active staff record is required" } });
      const approvers = leaveApprovers(self, data.staff, data.links);
      if (!approvers.length)
        return txFail(
          conflict("No active approver is available. Ask the CFO to check reporting relationships."),
        );
      const params = [
        { name: "User", type: TYPES.Int, value: self.id },
        { name: "Kind", type: TYPES.NVarChar, value: input.kind },
        { name: "Start", type: TYPES.Date, value: new Date(input.startDate) },
        { name: "End", type: TYPES.Date, value: new Date(input.endDate) },
        { name: "Hours", type: TYPES.Decimal, value: input.hours, options: { precision: 9, scale: 2 } },
        { name: "Note", type: TYPES.NVarChar, value: input.note },
      ];
      const overlap = await executeQuery(
        conn,
        "SELECT RequestId FROM dbo.LeaveRequests WITH (UPDLOCK,HOLDLOCK) WHERE UserId=@User AND Status IN ('pending','approved') AND StartDate<=@End AND EndDate>=@Start",
        params,
      );
      if (overlap.length)
        return txFail(
          conflict("A pending or approved request overlaps these dates. Withdraw it before replacing it."),
        );
      const row = (
        await executeQuery(
          conn,
          "INSERT dbo.LeaveRequests(UserId,Kind,StartDate,EndDate,Hours,Note) OUTPUT INSERTED.RequestId VALUES(@User,@Kind,@Start,@End,@Hours,@Note)",
          params,
        )
      )[0];
      await peopleAudit(conn, auth.caller, "leave", row.RequestId, "request", null, {
        ...input,
        userId: self.id,
        reportingRevision: data.revision,
      });
      held.asked = {
        approvers: approvers.map(({ id, name }) => ({ id, name })),
        requesterId: self.id,
        requesterName: self.name,
        requesterRole: self.role,
      };
      return txOk({ saved: true, id: row.RequestId });
    });
    if (!result.ok) return result.response;
    // Once the request has committed, the approvers are told and chased through the escalation engine. A policy that
    // is switched off, or a failed send, never undoes the request: the response says whether anyone was told.
    const made = held.asked;
    let notified = false;
    if (made) {
      const row = await raiseApproval(conn, {
        actor: ledgerUserActor({ name: made.requesterName, roles: [made.requesterRole], userId: made.requesterId }),
        headline: "Leave request waiting for a decision",
        log: (message) => context.warn(message),
        policyKey: APPROVAL_POLICIES.leave,
        subjectId: String(result.value.id),
        subjectType: APPROVAL_SUBJECTS.leave,
        userTargets: made.approvers.map((approver) => approver.id),
      });
      notified = row?.notificationState === "sent";
    }
    return { status: 201, jsonBody: { ...result.value, approvers: made?.approvers.map((approver) => approver.name) ?? [], notified } };
  } catch (error) {
    context.error("Leave creation failed", error);
    return { status: 500, jsonBody: { error: "Could not submit leave request" } };
  } finally {
    if (connection) closeConnection(connection);
  }
}
app.http("createLeaveRequest", { methods: ["POST"], authLevel: "anonymous", handler: createLeaveRequest });
