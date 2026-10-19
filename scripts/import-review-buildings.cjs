#!/usr/bin/env node
// Import an explicitly obtained portfolio snapshot into the isolated local DB.
// Never connects to cloud SQL, deletes buildings, or writes back to the source.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const cached = path.join(root, ".review-local/buildings-source.json");
const source = path.resolve(process.argv[2] || (fs.existsSync(cached) ? cached : path.join(root, "migrations/seeding/review-buildings.json")));
const sourceRows = JSON.parse(fs.readFileSync(source, "utf8"));
if (!Array.isArray(sourceRows) || !sourceRows.length) throw new Error("Expected a non-empty building array.");
const manualRows = JSON.parse(fs.readFileSync(path.join(root, "migrations/seeding/review-manual-buildings.json"), "utf8"));
// These local IDs come from the base manual seed / normal local API, not production.
const normalName = value => value.toLowerCase().replace(/terrace/g, "tce").replace(/crescent/g, "cres").replace(/court/g, "crt").replace(/street/g, "st").trim();
const rows = [...sourceRows, ...manualRows.filter(manual => !sourceRows.some(row => normalName(row.BuildingName) === normalName(manual.BuildingName)))];
const ids = new Set();
for (const row of rows) {
  if (!Number.isInteger(row.BuildingID) || row.BuildingID === 0 || !row.BuildingName || ids.has(row.BuildingID)) {
    throw new Error("Every source building needs a unique non-zero BuildingID and a name.");
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
    // Refuse a local ID collision instead of overwriting a different manual property.
    const conflicts = await db.executeQuery(connection, `SELECT b.BuildingID FROM dbo.Buildings b JOIN OPENJSON(@Rows) WITH (BuildingID INT, BuildingName NVARCHAR(255)) s ON b.BuildingID=s.BuildingID WHERE b.BuildingID<0 AND b.BuildingName<>s.BuildingName`, [{ name: "Rows", type: TYPES.NVarChar, value: JSON.stringify(rows) }]);
    if (conflicts.length) throw new Error("Manual building ID collision: reconcile the local reference fixture before importing.");
    await db.executeQuery(connection, `MERGE dbo.Buildings WITH (HOLDLOCK) AS t
      USING (SELECT * FROM OPENJSON(@Rows) WITH (
        BuildingID INT, BuildingName NVARCHAR(255), BuildingCode NVARCHAR(100),
        BuildingAddress NVARCHAR(500), ThirdPartySystem_BuildingID NVARCHAR(255),
        RegionID INT, Region NVARCHAR(255), NLA NVARCHAR(100), InvoicingAddress NVARCHAR(500),
        ContactPhoneNumber NVARCHAR(100), Levels NVARCHAR(MAX) AS JSON, Active BIT,
        LastModifiedDate NVARCHAR(50),Category NVARCHAR(20),OwnerName NVARCHAR(200))) s ON s.BuildingID=t.BuildingID
      WHEN MATCHED THEN UPDATE SET Category=COALESCE(s.Category,t.Category),OwnerName=CASE WHEN t.OwnerName='Carlo' AND s.OwnerName='Carlo & Maria' THEN s.OwnerName WHEN t.OwnerName='Paolo' AND s.OwnerName='Paolo & Kirstin' THEN s.OwnerName ELSE COALESCE(t.OwnerName,s.OwnerName) END,BuildingName=s.BuildingName, BuildingCode=s.BuildingCode,
        BuildingAddress=s.BuildingAddress, ThirdPartySystem_BuildingID=COALESCE(s.ThirdPartySystem_BuildingID,t.ThirdPartySystem_BuildingID),
        RegionID=COALESCE(s.RegionID,t.RegionID),Region=COALESCE(s.Region,t.Region),NLA=COALESCE(s.NLA,t.NLA),InvoicingAddress=COALESCE(s.InvoicingAddress,t.InvoicingAddress),
        ContactPhoneNumber=COALESCE(s.ContactPhoneNumber,t.ContactPhoneNumber),Levels=COALESCE(s.Levels,t.Levels),Active=COALESCE(s.Active,1),
        LastModifiedDate=COALESCE(s.LastModifiedDate,t.LastModifiedDate),LastSyncedAt=SYSUTCDATETIME(),UpdatedAt=SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (BuildingID,BuildingName,BuildingCode,BuildingAddress,
        ThirdPartySystem_BuildingID,RegionID,Region,NLA,InvoicingAddress,ContactPhoneNumber,
        Levels,Active,LastModifiedDate,LastSyncedAt,Category,OwnerName)
      VALUES (s.BuildingID,s.BuildingName,s.BuildingCode,s.BuildingAddress,s.ThirdPartySystem_BuildingID,
        s.RegionID,s.Region,s.NLA,s.InvoicingAddress,s.ContactPhoneNumber,s.Levels,COALESCE(s.Active,1),
        s.LastModifiedDate,SYSUTCDATETIME(),COALESCE(s.Category,'commercial'),s.OwnerName);`, [{ name: "Rows", type: TYPES.NVarChar, value: JSON.stringify(rows) }]);
    const report = { importedAt: new Date().toISOString(), source: path.basename(source), sourceCount: sourceRows.length, manualReferenceCount: rows.length - sourceRows.length, referenceBasis: "Commercial snapshot plus Connor-confirmed manual references; manual production IDs unverified", buildingIds: [...ids] };
    fs.writeFileSync(path.join(root, ".review-local/portfolio-import-report.json"), JSON.stringify(report, null, 2));
    console.log(`Imported ${rows.length} source buildings into localhost/floorplan_review; existing extra buildings retained.`);
  } finally { connection.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
