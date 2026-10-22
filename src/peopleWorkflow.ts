import { TYPES, type Connection } from "tedious";
import { executeQuery } from "./db";
import type { Caller } from "./assetRegisterSupport";
import type { ReportingLink, StaffMember } from "./leavePolicy";
export async function loadPeople(connection: Connection, lock = false) {
  const CONFIG_LOCK = lock ? "WITH (UPDLOCK,HOLDLOCK)" : "";
  const STAFF_LOCK = lock ? "WITH (HOLDLOCK)" : "";
  const config = (
    await executeQuery(
      connection,
      `SELECT LinksJson,Revision,UpdatedBy,UpdatedAt FROM dbo.StaffReporting ${CONFIG_LOCK} WHERE Id=1`,
    )
  )[0];
  if (!config) throw new Error("Reporting migration is required");
  const rows = await executeQuery(
    connection,
    `SELECT UserID,DisplayName,Role,EntraOid FROM dbo.AppUsers ${STAFF_LOCK} WHERE IsActive=1 AND EntraOid IS NOT NULL AND Role IS NOT NULL`,
  );
  const staff: StaffMember[] = rows.map((row) => ({
    id: row.UserID,
    name: row.DisplayName,
    role: row.Role,
    oid: row.EntraOid,
  }));
  return {
    staff,
    links: JSON.parse(config.LinksJson) as ReportingLink[],
    revision: Number(config.Revision),
    updatedBy: config.UpdatedBy,
    updatedAt: config.UpdatedAt,
  };
}
export async function peopleAudit(
  connection: Connection,
  caller: Caller,
  subject: string,
  id: number,
  action: string,
  before: unknown,
  after: unknown,
) {
  await executeQuery(
    connection,
    "INSERT dbo.PeopleWorkflowAudit(Subject,SubjectId,Action,BeforeJson,AfterJson,ActorOid,ActorName) VALUES(@Subject,@Id,@Action,@Before,@After,@Oid,@Actor)",
    [
      { name: "Subject", type: TYPES.NVarChar, value: subject },
      { name: "Id", type: TYPES.Int, value: id },
      { name: "Action", type: TYPES.NVarChar, value: action },
      { name: "Before", type: TYPES.NVarChar, value: before ? JSON.stringify(before) : null },
      { name: "After", type: TYPES.NVarChar, value: JSON.stringify(after) },
      { name: "Oid", type: TYPES.NVarChar, value: caller.oid },
      { name: "Actor", type: TYPES.NVarChar, value: caller.name },
    ],
  );
}
