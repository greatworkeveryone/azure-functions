import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { createConnection, executeQuery, closeConnection, SqlParam } from "../db";
import { fetchAllContractors, createOrUpdateContractors, MyContractor } from "../mybuildings-client";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";

interface UpdateContractorsBody {
  Contractors?: MyContractor[];
  contractors?: MyContractor[];
  ContractorID?: number;
}

// POST /api/syncContractors - fetch from myBuildings and upsert into SQL
async function syncContractors(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    context.log("Fetching contractors from myBuildings API...");
    const contractors = await fetchAllContractors();
    context.log(`Fetched ${contractors.length} contractors`);

    connection = await createConnection(token);
    let inserted = 0;
    let updated = 0;

    for (const c of contractors) {
      const existing = await executeQuery(connection,
        "SELECT Id FROM Contractors WHERE ContractorID = @ContractorID",
        [{ name: "ContractorID", type: TYPES.Int, value: c.ContractorID }]
      );

      const p = contractorToParams(c);

      if (existing.length > 0) {
        await executeQuery(connection,
          `UPDATE Contractors SET
           ThirdPartySystem_ContractorID=@ThirdPartyContractorID,
           ContractorName=@ContractorName, ContractorComments=@ContractorComments,
           ContractorCategory=@ContractorCategory, ABN=@ABN, Active=@Active,
           Suspended=@Suspended, EmailAddress=@EmailAddress,
           PhoneNumber=@PhoneNumber, MobileNumber=@MobileNumber,
           ContactFirstName=@ContactFirstName, ContactLastName=@ContactLastName,
           LastSyncedAt=GETUTCDATE(), UpdatedAt=GETUTCDATE()
           WHERE ContractorID=@ContractorID`, p);
        updated++;
      } else {
        await executeQuery(connection,
          `INSERT INTO Contractors (ContractorID, ThirdPartySystem_ContractorID,
           ContractorName, ContractorComments, ContractorCategory, ABN, Active,
           Suspended, EmailAddress, PhoneNumber, MobileNumber,
           ContactFirstName, ContactLastName,
           LastSyncedAt, CreatedAt, UpdatedAt)
           VALUES (@ContractorID, @ThirdPartyContractorID,
           @ContractorName, @ContractorComments, @ContractorCategory, @ABN, @Active,
           @Suspended, @EmailAddress, @PhoneNumber, @MobileNumber,
           @ContactFirstName, @ContactLastName,
           GETUTCDATE(), GETUTCDATE(), GETUTCDATE())`, p);
        inserted++;
      }
    }

    return { status: 200, jsonBody: { message: "Sync complete", total: contractors.length, inserted, updated } };
  } catch (error: any) {
    context.error("Sync failed:", error.message);
    return errorResponse("Sync failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// GET /api/getContractors - query from local database
async function getContractors(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    connection = await createConnection(token);

    const contractorId = request.query.get("contractorId");
    const active = request.query.get("active");

    let sql = "SELECT * FROM Contractors WHERE 1=1";
    const params: SqlParam[] = [];

    if (contractorId) {
      sql += " AND ContractorID = @ContractorID";
      params.push({ name: "ContractorID", type: TYPES.Int, value: parseInt(contractorId) });
    }
    if (active !== null && active !== undefined) {
      sql += " AND Active = @Active";
      params.push({ name: "Active", type: TYPES.Bit, value: active === "true" });
    }

    sql += " ORDER BY ContractorName";
    const rows = await executeQuery(connection, sql, params);

    return { status: 200, jsonBody: { contractors: rows, count: rows.length } };
  } catch (error: any) {
    context.error("Query failed:", error.message);
    return errorResponse("Query failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// PUT /api/updateContractors - create/update via myBuildings API
async function handleUpdateContractors(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  try {
    const body = await request.json() as UpdateContractorsBody;
    const contractors = body.Contractors ?? body.contractors ?? [body as MyContractor];
    context.log(`Updating ${contractors.length} contractors via myBuildings API...`);
    const result = await createOrUpdateContractors(contractors);
    return { status: 200, jsonBody: { message: "Contractors updated", result } };
  } catch (error: any) {
    context.error("Update failed:", error.message);
    return errorResponse("Update failed", error.message);
  }
}

function contractorToParams(c: MyContractor) {
  return [
    { name: "ContractorID", type: TYPES.Int, value: c.ContractorID ?? null },
    { name: "ThirdPartyContractorID", type: TYPES.NVarChar, value: c.ThirdPartySystem_ContractorID ?? null },
    { name: "ContractorName", type: TYPES.NVarChar, value: c.ContractorName ?? null },
    { name: "ContractorComments", type: TYPES.NVarChar, value: c.ContractorComments ?? null },
    { name: "ContractorCategory", type: TYPES.NVarChar, value: c.ContractorCategory ?? null },
    { name: "ABN", type: TYPES.NVarChar, value: c.ABN ?? null },
    { name: "Active", type: TYPES.Bit, value: c.Active ?? true },
    { name: "Suspended", type: TYPES.Bit, value: c.Suspended ?? false },
    { name: "EmailAddress", type: TYPES.NVarChar, value: c.EmailAddress ?? null },
    { name: "PhoneNumber", type: TYPES.NVarChar, value: c.PhoneNumber ?? null },
    { name: "MobileNumber", type: TYPES.NVarChar, value: c.MobileNumber ?? null },
    { name: "ContactFirstName", type: TYPES.NVarChar, value: c.ContactFirstName ?? null },
    { name: "ContactLastName", type: TYPES.NVarChar, value: c.ContactLastName ?? null },
  ];
}

app.http("syncContractors", { methods: ["POST"], authLevel: "anonymous", handler: syncContractors });
app.http("getContractors", { methods: ["GET"], authLevel: "anonymous", handler: getContractors });
app.http("updateContractors", { methods: ["PUT"], authLevel: "anonymous", handler: handleUpdateContractors });
