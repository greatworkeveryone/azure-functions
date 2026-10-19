import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { ACTION_ROLES } from "../action-roles";
import { AppRole, errorResponse, forbiddenResponse, rolesForRequest } from "../auth";
import { authorizeWrite, badRequest, conflict, inTransaction, notFound, readJsonBody, txFail, txOk, type Caller } from "../assetRegisterSupport";
import { closeConnection, createRequestConnection, executeQuery, type SqlParam, type SqlRow } from "../db";
import { canManageEvent, canReadEvent, parseEventEntry, parseEventInput, type EventDomain, type EventInput, type EventPlan } from "../majorEvents";
import { checkRateLimit } from "../rateLimit";
import { deleteBlob, downloadBlob, uploadBlob } from "../blob-storage";
import { assertBlobName, MAJOR_EVENT_DOCUMENT_SHAPE } from "../blob-names";
import { majorEventPack } from "../majorEventPack";

const COLS = "EventId, Title, Domain, EventType, EventKind, EventClass, Audience, Status, OwnerName, StartsAt, EndsAt, Brief, PlanJson, Revision, CreatedAt, CreatedBy, UpdatedAt, ClosedAt, ClosedBy";
const int = (name: string, value: number): SqlParam => ({ name, type: TYPES.Int, value });
const str = (name: string, value: string | null): SqlParam => ({ name, type: TYPES.NVarChar, value });
const idOf = (value: unknown): number | null => typeof value === "string" && /^[1-9][0-9]{0,9}$/.test(value) && Number(value) <= 2147483647 ? Number(value) : null;
const iso = (value: unknown): string | null => value ? new Date(value as string).toISOString() : null;
export function eventToApi(r: SqlRow) {
  return { id: Number(r.EventId), title: r.Title, domain: r.Domain as EventDomain, eventType: r.EventKind ?? r.EventType, eventClass: r.EventClass ?? "major", audience: r.Audience ?? (r.Domain === "financial" ? "managers" : "operational_staff"), status: r.Status, ownerName: r.OwnerName, startsAt: iso(r.StartsAt), endsAt: iso(r.EndsAt), brief: r.Brief, plan: JSON.parse(r.PlanJson) as EventPlan, revision: r.Revision, createdAt: iso(r.CreatedAt), createdBy: r.CreatedBy, updatedAt: iso(r.UpdatedAt), closedAt: iso(r.ClosedAt), closedBy: r.ClosedBy };
}
async function eventRow(c: Connection, id: number, lock = false) {
  const LOCK = lock ? "WITH (UPDLOCK, HOLDLOCK)" : "";
  return (await executeQuery(c, `SELECT ${COLS} FROM dbo.MajorEvents ${LOCK} WHERE EventId=@Id`, [int("Id", id)]))[0];
}
async function entries(c: Connection, id: number) {
  return executeQuery(c, "SELECT EntryId, EntryType, BuildingId, Area, Body, ActorName, CreatedAt FROM dbo.MajorEventEntries WHERE EventId=@Id ORDER BY EntryId", [int("Id", id)]);
}
async function documents(c: Connection, id: number) {
  return executeQuery(c, "SELECT DocumentId, FileName, ContentType, SizeBytes, UploadedAt, UploadedBy FROM dbo.MajorEventDocuments WHERE EventId=@Id ORDER BY DocumentId", [int("Id", id)]);
}
async function audit(c: Connection, id: number, caller: Caller, type: string, body: string, buildingId: number | null = null, area: string | null = null) {
  await executeQuery(c, `INSERT INTO dbo.MajorEventEntries (EventId,EntryType,BuildingId,Area,Body,ActorName,ActorOid) VALUES (@Id,@Type,@Building,@Area,@Body,@Name,@Oid)`, [int("Id", id), str("Type", type), { name: "Building", type: TYPES.Int, value: buildingId }, str("Area", area), str("Body", body), str("Name", caller.name), str("Oid", caller.oid)]);
}
async function validateLinks(c: Connection, input: EventInput, roles: string[]): Promise<string | null> {
  for (const id of input.plan.buildingIds) {
    if (!(await executeQuery(c, "SELECT BuildingID FROM dbo.Buildings WHERE BuildingID=@Id AND Active=1", [int("Id", id)])).length) return "An affected building is missing or inactive";
  }
  for (const id of input.plan.jobIds) {
    const row = (await executeQuery(c, "SELECT JobID, BuildingID, IsTest FROM dbo.Jobs WHERE JobID=@Id", [int("Id", id)]))[0];
    if (!row || (row.IsTest && !roles.includes(AppRole.ADMIN)) || !input.plan.buildingIds.includes(Number(row.BuildingID))) return "A linked job is unavailable or belongs to a building outside this event";
  }
  return null;
}
function inputParams(v: EventInput): SqlParam[] {
  return [str("Title", v.title), str("Domain", v.domain), str("Type", v.eventType), str("LegacyType", ["cyclone","flood","shutdown","major_works","financial","other"].includes(v.eventType) ? v.eventType : "other"), str("Class", v.eventClass), str("Audience", v.audience), str("Owner", v.ownerName), { name: "Start", type: TYPES.DateTime2, value: new Date(v.startsAt) }, { name: "End", type: TYPES.DateTime2, value: v.endsAt ? new Date(v.endsAt) : null }, str("Brief", v.brief), str("Plan", JSON.stringify(v.plan))];
}

// Every route authenticates and checks an exact outer capability BEFORE body or DB access.
// Stored domain is checked again inside the transaction; a client cannot relabel a financial event.
type State = { connection: Connection; roles: string[]; caller: Caller };
type Operation = (request: HttpRequest, state: State) => Promise<HttpResponseInit>;
function withMajorEvent(name: string, manage: boolean, operation: Operation) {
  const handler = async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const capability = manage ? ACTION_ROLES.manageMajorEvents : ACTION_ROLES.viewMajorEvents;
    const auth = await authorizeWrite(request, capability.gate);
    if (!auth.ok) return auth.response;
    const roles = await rolesForRequest(request);
    if (!roles.some(role => capability.gate.some(allowed => allowed === role))) return forbiddenResponse("This role cannot perform this event action");
    const limit = checkRateLimit(`majorEvents:${name}:${auth.caller.oid}`, { limit: name === "exportMajorEventPack" ? 4 : 60, windowMs: 60_000 });
    if (!limit.allowed) return { status: 429, headers: { "Retry-After": "60" }, jsonBody: { error: "Please wait before trying again" } };
    let connection: Connection | undefined;
    try {
      connection = await createRequestConnection(auth.token);
      const result = await operation(request, { connection, roles, caller: auth.caller });
      result.headers = { ...result.headers, "Cache-Control": "no-store" };
      return result;
    } catch (error) {
      context.error(`${name} failed`, error instanceof Error ? error.message : "unknown error");
      return errorResponse("Major Event request failed", error);
    } finally {
      if (connection) closeConnection(connection);
    }
  };
  return handler;
}
export const getMajorEvents = async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => withMajorEvent("getMajorEvents", false, async (req, s) => {
  const eventClass = req.query.get("eventClass");
  if (eventClass && !["minor","major","project"].includes(eventClass)) return badRequest("Invalid event class");
  const rows = await executeQuery(s.connection, `SELECT TOP (200) ${COLS} FROM dbo.MajorEvents WHERE (@Class IS NULL OR EventClass=@Class) AND ((Domain='operational' AND @Operational=1) OR (Domain='financial' AND @Financial=1) OR Audience='operational_staff' OR (Audience='accounts_managers' AND @AccountsManager=1) OR (Audience='accounts_team' AND @AccountsTeam=1)) ORDER BY CASE WHEN Status='active' THEN 0 ELSE 1 END, UpdatedAt DESC`, [str("Class", eventClass), { name: "Financial", type: TYPES.Bit, value: canManageEvent(s.roles, "financial") }, { name: "Operational", type: TYPES.Bit, value: canManageEvent(s.roles, "operational") }, { name: "AccountsManager", type: TYPES.Bit, value: s.roles.some(role => ["accounts_manager","cfo","director"].includes(role)) }, { name: "AccountsTeam", type: TYPES.Bit, value: s.roles.some(role => ["accounts","accounts_manager","cfo","director"].includes(role)) }]);
  return { status: 200, jsonBody: { events: rows.map(eventToApi), limit: 200 } };
})(request, context);
export const getMajorEvent = async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => withMajorEvent("getMajorEvent", false, async (req, s) => {
  const id = idOf(req.query.get("eventId"));
  if (!id) return badRequest("Valid eventId required");
  const row = await eventRow(s.connection, id);
  if (!row || !canReadEvent(s.roles, row.Domain, row.Audience)) return notFound("Event not found");
  return { status: 200, jsonBody: { event: eventToApi(row), entries: await entries(s.connection, id), documents: await documents(s.connection, id) } };
})(request, context);
export const createMajorEvent = async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => withMajorEvent("createMajorEvent", true, async (req, s) => {
  const body = await readJsonBody(req);
  let input: EventInput;
  try { input = parseEventInput(body ?? {}); } catch (e) { return badRequest((e as Error).message); }
  if (!canManageEvent(s.roles, input.domain)) return forbiddenResponse("This event needs the appropriate manager or director");
  const result = await inTransaction(s.connection, async () => {
    const invalid = await validateLinks(s.connection, input, s.roles);
    if (invalid) return txFail(badRequest(invalid));
    const rows = await executeQuery(s.connection, `INSERT INTO dbo.MajorEvents (Title,Domain,EventType,EventKind,EventClass,Audience,OwnerName,StartsAt,EndsAt,Brief,PlanJson,CreatedBy,CreatedByOid) OUTPUT INSERTED.EventId VALUES (@Title,@Domain,@LegacyType,@Type,@Class,@Audience,@Owner,@Start,@End,@Brief,@Plan,@Name,@Oid)`, [...inputParams(input), str("Name", s.caller.name), str("Oid", s.caller.oid)]);
    const id = Number(rows[0].EventId);
    await audit(s.connection, id, s.caller, "created", JSON.stringify(input));
    return txOk(eventToApi((await eventRow(s.connection, id))!));
  });
  return result.ok ? { status: 201, jsonBody: { event: result.value } } : result.response;
})(request, context);
export const updateMajorEvent = async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => withMajorEvent("updateMajorEvent", true, async (req, s) => {
  const body = await readJsonBody(req);
  const id = idOf(String(body?.eventId ?? ""));
  if (!id || !Number.isInteger(body?.revision)) return badRequest("Event ID and revision required");
  let input: EventInput;
  try { input = parseEventInput(body!); } catch (e) { return badRequest((e as Error).message); }
  const result = await inTransaction(s.connection, async () => {
    const row = await eventRow(s.connection, id, true);
    if (!row || !canReadEvent(s.roles, row.Domain, row.Audience)) return txFail(notFound("Event not found"));
    if (!canManageEvent(s.roles, row.Domain)) return txFail(forbiddenResponse("Only this event's management authority can change its plan"));
    if (row.Domain !== input.domain || (row.Audience && row.Audience !== input.audience)) return txFail(badRequest("Event authority and audience cannot be changed in a plan edit; create a separate event"));
    if (row.Status !== "active" || row.Revision !== body!.revision) return txFail(conflict("Event changed or closed; refresh before saving"));
    const invalid = await validateLinks(s.connection, input, s.roles);
    if (invalid) return txFail(badRequest(invalid));
    await executeQuery(s.connection, `UPDATE dbo.MajorEvents SET Title=@Title, EventType=@LegacyType, EventKind=@Type, EventClass=@Class, OwnerName=@Owner, StartsAt=@Start, EndsAt=@End, Brief=@Brief, PlanJson=@Plan, Revision=Revision+1, UpdatedAt=SYSUTCDATETIME() WHERE EventId=@Id`, [int("Id", id), ...inputParams(input)]);
    await audit(s.connection, id, s.caller, "plan_changed", JSON.stringify({ before: eventToApi(row), after: input }));
    return txOk(eventToApi((await eventRow(s.connection, id))!));
  });
  return result.ok ? { status: 200, jsonBody: { event: result.value } } : result.response;
})(request, context);
export const closeMajorEvent = async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => withMajorEvent("closeMajorEvent", true, async (req, s) => {
  const body = await readJsonBody(req);
  const id = idOf(String(body?.eventId ?? ""));
  if (!id || !Number.isInteger(body?.revision) || typeof body?.reason !== "string" || !body.reason.trim() || body.reason.length > 6000) return badRequest("Event, revision and a close-out summary are required");
  const reason = body.reason.trim();
  const result = await inTransaction(s.connection, async () => {
    const row = await eventRow(s.connection, id, true);
    if (!row || !canReadEvent(s.roles, row.Domain, row.Audience)) return txFail(notFound("Event not found"));
    if (!canManageEvent(s.roles, row.Domain)) return txFail(forbiddenResponse("Only the event's management authority may close it"));
    if (row.Status !== "active" || row.Revision !== body.revision) return txFail(conflict("Event changed or closed; refresh first"));
    await executeQuery(s.connection, "UPDATE dbo.MajorEvents SET Status='closed', ClosedAt=SYSUTCDATETIME(), ClosedBy=@Name, UpdatedAt=SYSUTCDATETIME(), Revision=Revision+1 WHERE EventId=@Id", [int("Id", id), str("Name", s.caller.name)]);
    await audit(s.connection, id, s.caller, "closed", reason);
    return txOk({ closed: true });
  });
  return result.ok ? { status: 200, jsonBody: result.value } : result.response;
})(request, context);
export const addMajorEventEntry = async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => withMajorEvent("addMajorEventEntry", false, async (req, s) => {
  const body = await readJsonBody(req);
  const id = idOf(String(body?.eventId ?? ""));
  if (!id) return badRequest("Valid eventId required");
  let entry: ReturnType<typeof parseEventEntry>;
  try { entry = parseEventEntry(body!); } catch (e) { return badRequest((e as Error).message); }
  const result = await inTransaction(s.connection, async () => {
    const row = await eventRow(s.connection, id, true);
    if (!row || !canReadEvent(s.roles, row.Domain, row.Audience)) return txFail(notFound("Event not found"));
    if (row.Status !== "active") return txFail(conflict("Closed events preserve their record"));
    if (entry.buildingId !== null && !(JSON.parse(row.PlanJson) as EventPlan).buildingIds.includes(entry.buildingId)) return txFail(badRequest("Building is outside this event"));
    const count = await executeQuery(s.connection, "SELECT COUNT(*) AS N FROM dbo.MajorEventEntries WHERE EventId=@Id", [int("Id", id)]);
    if (Number(count[0]?.N) >= 2000) return txFail(conflict("Event update limit reached; close this phase and start a linked follow-up event"));
    await audit(s.connection, id, s.caller, entry.type, entry.body, entry.buildingId, entry.area);
    await executeQuery(s.connection, "UPDATE dbo.MajorEvents SET UpdatedAt=SYSUTCDATETIME() WHERE EventId=@Id", [int("Id", id)]);
    return txOk({ added: true });
  });
  return result.ok ? { status: 201, jsonBody: result.value } : result.response;
})(request, context);

export const uploadMajorEventDocument = async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => withMajorEvent("uploadMajorEventDocument", false, async (req, s) => {
  let form: FormData;
  try { form = await req.formData(); } catch { return badRequest("Multipart file and eventId required"); }
  const id = idOf(String(form.get("eventId") ?? ""));
  const file = form.get("file") as File | null;
  if (!id || !file || typeof file.arrayBuffer !== "function") return badRequest("File and eventId required");
  if (file.size < 1 || file.size > 10 * 1024 * 1024) return { status: 413, jsonBody: { error: "Use a file up to 10 MB" } };
  if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.type)) return { status: 415, jsonBody: { error: "Use PDF, JPEG, PNG or WebP" } };
  const row = await eventRow(s.connection, id);
  if (!row || !canReadEvent(s.roles, row.Domain, row.Audience)) return notFound("Event not found");
  if (row.Status !== "active") return conflict("Closed events preserve their record");
  const bytes = Buffer.from(await file.arrayBuffer());
  const isSignature = file.type === "application/pdf" ? bytes.subarray(0, 5).toString() === "%PDF-" : file.type === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : file.type === "image/png" ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP";
  if (!isSignature) return badRequest("File contents do not match its type");
  const fileName = file.name.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 200) || "document";
  let blobName: string | undefined;
  let committed = false;
  try {
    const uploaded = await uploadBlob(bytes, fileName, file.type, `major-events/${id}`);
    blobName = uploaded.blobName;
    const result = await inTransaction(s.connection, async () => {
      const current = await eventRow(s.connection, id, true);
      if (!current || current.Status !== "active") return txFail(conflict("Event closed during upload"));
      const counts = await executeQuery(s.connection, "SELECT COUNT(*) AS N, ISNULL(SUM(SizeBytes),0) AS Bytes FROM dbo.MajorEventDocuments WHERE EventId=@Id", [int("Id", id)]);
      if (Number(counts[0]?.N) >= 50 || Number(counts[0]?.Bytes) + bytes.length > 40 * 1024 * 1024) return txFail(conflict("Event document limit is 50 files / 40 MB"));
      await executeQuery(s.connection, "INSERT INTO dbo.MajorEventDocuments (EventId,FileName,BlobName,ContentType,SizeBytes,UploadedBy) VALUES (@Id,@File,@Blob,@Type,@Size,@Name)", [int("Id", id), str("File", fileName), str("Blob", uploaded.blobName), str("Type", file.type), int("Size", bytes.length), str("Name", s.caller.name)]);
      await audit(s.connection, id, s.caller, "document_added", fileName);
      return txOk({ added: true });
    });
    committed = result.ok;
    return result.ok ? { status: 201, jsonBody: result.value } : result.response;
  } finally {
    if (blobName && !committed) await deleteBlob(blobName).catch(() => undefined);
  }
})(request, context);
export const getMajorEventDocument = async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => withMajorEvent("getMajorEventDocument", false, async (req, s) => {
  const id = idOf(req.query.get("eventId"));
  const docId = idOf(req.query.get("documentId"));
  if (!id || !docId) return badRequest("Event and document required");
  const row = await eventRow(s.connection, id);
  if (!row || !canReadEvent(s.roles, row.Domain, row.Audience)) return notFound("Event not found");
  const doc = (await executeQuery(s.connection, "SELECT FileName, BlobName FROM dbo.MajorEventDocuments WHERE EventId=@Id AND DocumentId=@Document", [int("Id", id), int("Document", docId)]))[0];
  if (!doc) return notFound("Document not found");
  assertBlobName(doc.BlobName, MAJOR_EVENT_DOCUMENT_SHAPE);
  if (!String(doc.BlobName).startsWith(`major-events/${id}/`)) return notFound("Document not found");
  return { status: 200, body: await downloadBlob(doc.BlobName), headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.FileName)}`, "X-Content-Type-Options": "nosniff" } };
})(request, context);
export const exportMajorEventPack = async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => withMajorEvent("exportMajorEventPack", false, async (req, s) => {
  const id = idOf(req.query.get("eventId"));
  if (!id) return badRequest("Event required");
  const row = await eventRow(s.connection, id);
  if (!row || !canReadEvent(s.roles, row.Domain, row.Audience)) return notFound("Event not found");
  const docs = await executeQuery(s.connection, "SELECT DocumentId,FileName,BlobName,SizeBytes,ContentType,UploadedBy,UploadedAt FROM dbo.MajorEventDocuments WHERE EventId=@Id ORDER BY DocumentId", [int("Id", id)]);
  if (docs.length > 50 || docs.reduce((n, d) => n + Number(d.SizeBytes), 0) > 40 * 1024 * 1024) return conflict("Pack exceeds export limit");
  const files: { name: string; bytes: Buffer; contentType: string }[] = [];
  for (const doc of docs) {
    assertBlobName(doc.BlobName, MAJOR_EVENT_DOCUMENT_SHAPE);
    if (!String(doc.BlobName).startsWith(`major-events/${id}/`)) return notFound("Document not found");
    const bytes = await downloadBlob(doc.BlobName);
    if (bytes.length !== Number(doc.SizeBytes)) throw new Error("Document size mismatch");
    files.push({ name: `${doc.DocumentId}-${doc.FileName}`, bytes, contentType: doc.ContentType });
  }
  const buildingRows = await executeQuery(s.connection, "SELECT BuildingID, BuildingName FROM dbo.Buildings");
  const pack = await majorEventPack(eventToApi(row), await entries(s.connection, id), buildingRows, files);
  return { status: 200, body: pack, headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="event-${id}-handover.pdf"`, "X-Content-Type-Options": "nosniff" } };
})(request, context);

app.http("getMajorEvents", { authLevel: "anonymous", handler: getMajorEvents, methods: ["GET"] });

app.http("getMajorEvent", { authLevel: "anonymous", handler: getMajorEvent, methods: ["GET"] });

app.http("createMajorEvent", { authLevel: "anonymous", handler: createMajorEvent, methods: ["POST"] });

app.http("updateMajorEvent", { authLevel: "anonymous", handler: updateMajorEvent, methods: ["POST"] });

app.http("closeMajorEvent", { authLevel: "anonymous", handler: closeMajorEvent, methods: ["POST"] });

app.http("addMajorEventEntry", { authLevel: "anonymous", handler: addMajorEventEntry, methods: ["POST"] });

app.http("uploadMajorEventDocument", { authLevel: "anonymous", handler: uploadMajorEventDocument, methods: ["POST"] });

app.http("getMajorEventDocument", { authLevel: "anonymous", handler: getMajorEventDocument, methods: ["GET"] });

app.http("exportMajorEventPack", { authLevel: "anonymous", handler: exportMajorEventPack, methods: ["GET"] });
