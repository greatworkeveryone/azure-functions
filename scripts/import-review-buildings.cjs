#!/usr/bin/env node
// Import an explicitly obtained portfolio snapshot into the isolated local DB.
// Never connects to cloud SQL, deletes buildings, or writes back to the source.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const cached = path.join(root, ".review-local/buildings-source.json");
const source = path.resolve(process.argv[2] || (fs.existsSync(cached) ? cached : path.join(root, "migrations/seeding/review-buildings.json")));
const rows = JSON.parse(fs.readFileSync(source, "utf8"));
if (!Array.isArray(rows) || !rows.length) throw new Error("Expected a non-empty building array.");
const ids = new Set();
for (const row of rows) {
  if (!Number.isInteger(row.BuildingID) || row.BuildingID <= 0 || !row.BuildingName || ids.has(row.BuildingID)) {
    throw new Error("Every source building needs a unique positive BuildingID and a name.");
  }
  ids.add(row.BuildingID);
}
Object.assign(process.env, {
  LOCAL_SQL: "true", SQL_SERVER: "localhost", SQL_DATABASE: "floorplan_review",
  SQL_USERNAME: "sa", SQL_PASSWORD: "FloorplanReview2026_LocalOnly",
});
const db = require("../dist/db");
const { TYPES } = require("tedious");
async function main() {
  const connection = await db.createLocalConnection();
  try {
    await db.executeQuery(connection, `MERGE dbo.Buildings WITH (HOLDLOCK) AS t
      USING (SELECT * FROM OPENJSON(@Rows) WITH (
        BuildingID INT, BuildingName NVARCHAR(255), BuildingCode NVARCHAR(100),
        BuildingAddress NVARCHAR(500), ThirdPartySystem_BuildingID NVARCHAR(255),
        RegionID INT, Region NVARCHAR(255), NLA NVARCHAR(100), InvoicingAddress NVARCHAR(500),
        ContactPhoneNumber NVARCHAR(100), Levels NVARCHAR(MAX) AS JSON, Active BIT,
        LastModifiedDate NVARCHAR(50))) s ON s.BuildingID=t.BuildingID
      WHEN MATCHED THEN UPDATE SET BuildingName=s.BuildingName, BuildingCode=s.BuildingCode,
        BuildingAddress=s.BuildingAddress, ThirdPartySystem_BuildingID=COALESCE(s.ThirdPartySystem_BuildingID,t.ThirdPartySystem_BuildingID),
        RegionID=COALESCE(s.RegionID,t.RegionID),Region=COALESCE(s.Region,t.Region),NLA=COALESCE(s.NLA,t.NLA),InvoicingAddress=COALESCE(s.InvoicingAddress,t.InvoicingAddress),
        ContactPhoneNumber=COALESCE(s.ContactPhoneNumber,t.ContactPhoneNumber),Levels=COALESCE(s.Levels,t.Levels),Active=COALESCE(s.Active,1),
        LastModifiedDate=COALESCE(s.LastModifiedDate,t.LastModifiedDate),LastSyncedAt=SYSUTCDATETIME(),UpdatedAt=SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (BuildingID,BuildingName,BuildingCode,BuildingAddress,
        ThirdPartySystem_BuildingID,RegionID,Region,NLA,InvoicingAddress,ContactPhoneNumber,
        Levels,Active,LastModifiedDate,LastSyncedAt)
      VALUES (s.BuildingID,s.BuildingName,s.BuildingCode,s.BuildingAddress,s.ThirdPartySystem_BuildingID,
        s.RegionID,s.Region,s.NLA,s.InvoicingAddress,s.ContactPhoneNumber,s.Levels,COALESCE(s.Active,1),
        s.LastModifiedDate,SYSUTCDATETIME());`, [{ name: "Rows", type: TYPES.NVarChar, value: JSON.stringify(rows) }]);
    const report = { importedAt: new Date().toISOString(), source: path.basename(source), sourceCount: rows.length, buildingIds: [...ids] };
    fs.writeFileSync(path.join(root, ".review-local/portfolio-import-report.json"), JSON.stringify(report, null, 2));
    console.log(`Imported ${rows.length} source buildings into localhost/floorplan_review; existing extra buildings retained.`);
  } finally { connection.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
