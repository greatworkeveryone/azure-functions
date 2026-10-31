// POST /api/acknowledgeWorkRequest  { workRequestId, withoutEmail? }
//
// Acknowledges an incoming tenant request (TR1, PLAN §15): sends the request_ack email from notices@ through the
// send core (EB1: queued, so COMMS_SEND_ENABLED / COMMS_SEND_DRY_RUN, DEV_EMAIL_OVERRIDE and the test-record egress
// guard all apply exactly as for any send), then records who and when and moves the request to Acknowledged.
// `withoutEmail: true` acknowledges a request the person has already answered another way (a call, in person),
// sends nothing and records that. Only a request still Received can be acknowledged, once.
//
// Who may: ACTION_ROLES.acknowledgeRequest (facilities and accounts staff and above; admin sends nothing real).
// Behind the tenantRequests flag: while it is hidden for the caller's roles this answers 404.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { inTransaction, readJsonBody, txOk } from "../assetRegisterSupport";
import { errorResponse } from "../auth";
import { authorizeActor, badRequest, conflict, noStore, notFound } from "../comms/actor";
import { approvalThreshold, commsMode, fromAddress, fromName } from "../comms/config";
import { applyResolutions, checkRecipients, isBlocked, writeJob } from "../comms/queueJob";
import { unexpectedKey } from "../comms/request";
import { prepareSender } from "../comms/senderSetup";
import type { NewJob } from "../comms/types";
import { findUserByOid } from "../comms/userSignatureStore";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { isFeatureEnabledForRoles } from "../features/flags";
import { ackDelivery } from "../intake/delivery";
import { ACK_TEMPLATE_ID, loadAckTemplate } from "../intake/template";
import { storedState, viewState } from "../intake/state";
import { record } from "../ledger";
import { ledgerUserActor } from "../ledger/actor";
import { checkRateLimit } from "../rateLimit";
import { parseWorkRequestId } from "../workRequestsNative";

const REQUEST_SQL = `SELECT wr.WorkRequestID, wr.BuildingID, wr.BuildingName, wr.IntakeState, wr.AcknowledgedBy, wr.AcknowledgedAt,
         wr.JobCode, wr.ActualCompletionDate,
         COALESCE(o.TenantName, wr.TenantName) AS TenantName, COALESCE(o.LevelName, wr.LevelName) AS LevelName,
         COALESCE(o.ContactName, wr.ContactName) AS ContactName, COALESCE(o.ContactEmail, wr.ContactEmail) AS ContactEmail,
         COALESCE(o.Category, wr.Category) AS Category, COALESCE(o.[Type], wr.[Type]) AS RequestType,
         CASE WHEN EXISTS (SELECT 1 FROM dbo.Jobs j WHERE j.WorkRequestID = wr.WorkRequestID) THEN 1 ELSE 0 END AS HasJob
    FROM dbo.WorkRequests wr
    LEFT JOIN dbo.WorkRequestOverrides o ON o.WorkRequestID = wr.WorkRequestID
   WHERE wr.WorkRequestID = @Id`;

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export async function acknowledgeWorkRequest(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeActor(request, ACTION_ROLES.acknowledgeRequest.gate, ACTION_ROLES.acknowledgeRequest.refused);
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  const limited = checkRateLimit(`acknowledgeWorkRequest:${actor.oid}`, { limit: 30 });
  if (!limited.allowed) return { headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) }, jsonBody: { error: "Too many acknowledgements, try again shortly" }, status: 429 };
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  const extra = unexpectedKey(body, ["workRequestId", "withoutEmail"]);
  if (extra) return badRequest(extra);
  const id = typeof body.workRequestId === "number" ? parseWorkRequestId(body.workRequestId) : null;
  if (id === null) return badRequest("workRequestId must be a whole number");
  if (body.withoutEmail !== undefined && typeof body.withoutEmail !== "boolean") return badRequest("withoutEmail must be true or false");
  const withoutEmail = body.withoutEmail === true;

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    if (!(await isFeatureEnabledForRoles("tenantRequests", actor.roles, { connection }))) return notFound("Not available");
    const row = (await executeQuery(connection, REQUEST_SQL, [{ name: "Id", type: TYPES.Int, value: id }]))[0];
    if (!row) return notFound("No such request");
    if (Number(row.HasJob) === 1) return conflict("A job has already been raised from this request");
    const state = storedState(row.IntakeState);
    if (state !== "received") {
      const by = text(row.AcknowledgedBy);
      return conflict(state === "acknowledged" || state === "assessing" ? `Already acknowledged${by ? ` by ${by}` : ""}` : "This request has been closed");
    }

    let jobId: number | null = null;
    let queuedJobStatus: string | null = null;
    if (!withoutEmail) {
      const address = text(row.ContactEmail).toLowerCase();
      if (address === "") return badRequest("This request has no contact email. If you have already told them another way, acknowledge without an email.");
      const template = await loadAckTemplate(connection);
      if (!template) return conflict("The request_ack email template isn't in the library yet");
      if (!template.approved && commsMode() === "live") return conflict("The request_ack email template hasn't been approved yet, so it can't be sent");
      const setup = await prepareSender(connection, actor, { replyTo: { kind: "own" }, signatureMode: "personal" });
      if (!setup.ok) return setup.response;
      const reference = text(row.JobCode) || `REQ-${id}`;
      const summary = [text(row.RequestType), text(row.Category)].find(Boolean) ?? "your request";
      const job: NewJob = {
        bodyMarkdown: template.bodyMarkdown,
        createdBy: { email: actor.email, name: actor.name, oid: actor.oid, role: actor.role },
        fromAddress: fromAddress(),
        fromName: fromName(),
        kind: "letter",
        // A typed address: the egress guard still refuses any test tenancy's contact. The request's own contact is not a tenancy record.
        recipients: [
          {
            address,
            mergeValues: {
              "building.name": text(row.BuildingName),
              "request.reference": reference,
              "request.summary": summary,
              "tenant.addressee": text(row.ContactName) || text(row.TenantName),
              "tenant.name": text(row.TenantName),
              "tenant.suite": text(row.LevelName),
            },
            name: text(row.ContactName) || null,
            recipientRefId: null,
            recipientType: "manual",
          },
        ],
        replyTo: { address: setup.replyTo.address, identityId: setup.replyTo.identity?.identityId ?? null, name: setup.replyTo.name },
        signature: setup.signature,
        signatureMode: "personal",
        subject: template.subject,
        templateId: ACK_TEMPLATE_ID,
        templateVersion: template.version,
      };
      const checked = await applyResolutions(connection, checkRecipients(job));
      if (checked.every(isBlocked)) {
        const first = checked[0];
        return badRequest(`The acknowledgement can't be sent. ${first.refusal?.detail ?? (first.composed.ok ? "" : first.composed.detail)}`.trim());
      }
      const user = await findUserByOid(connection, actor.oid);
      // One key per request: a retry after a failure part-way finds the email already queued and doesn't queue a second.
      const queued = await writeJob(connection, job, checked, actor, user?.userId ?? null, approvalThreshold(), `request-ack-wr-${id}`);
      jobId = queued.correspondenceId;
      queuedJobStatus = queued.status;
    }

    const user = await findUserByOid(connection, actor.oid);
    const via = withoutEmail ? "other" : "email";
    const moved = await inTransaction<boolean>(connection, async () => {
      const done = await executeQuery(
        connection as Connection,
        `UPDATE dbo.WorkRequests
            SET IntakeState = N'acknowledged', AcknowledgedAt = SYSUTCDATETIME(), AcknowledgedBy = @By, AcknowledgedVia = @Via,
                AcknowledgementJobId = @JobId, IntakeUpdatedAt = SYSUTCDATETIME()
         OUTPUT inserted.WorkRequestID
          WHERE WorkRequestID = @Id AND ISNULL(IntakeState, N'received') = N'received'`,
        [
          { name: "By", type: TYPES.NVarChar, value: actor.name.slice(0, 160) },
          { name: "Via", type: TYPES.NVarChar, value: via },
          { name: "JobId", type: TYPES.Int, value: jobId },
          { name: "Id", type: TYPES.Int, value: id },
        ],
      );
      if (done.length === 0) return txOk(false);
      await record(connection as Connection, {
        action: "work_request.acknowledge",
        actor: ledgerUserActor({ name: actor.name, roles: actor.roles, userId: user?.userId ?? null }),
        after: { acknowledgementJobId: jobId, intakeState: "acknowledged", via },
        before: { intakeState: viewState(row.IntakeState, false) },
        buildingId: row.BuildingID === null || row.BuildingID === undefined ? null : Number(row.BuildingID),
        subject: { id, type: "work_request" },
      });
      return txOk(true);
    });
    if (!moved.ok || !moved.value) return conflict("Someone else acknowledged this request just now");
    return { headers: noStore, jsonBody: { acknowledgedVia: via, correspondenceId: jobId, delivery: ackDelivery(via, "queued", queuedJobStatus, commsMode()), workRequestId: id }, status: 200 };
  } catch (error) {
    context.error("acknowledgeWorkRequest failed:", error instanceof Error ? error.message : error);
    return errorResponse("Could not acknowledge the request", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("acknowledgeWorkRequest", { authLevel: "anonymous", handler: acknowledgeWorkRequest, methods: ["POST"] });
