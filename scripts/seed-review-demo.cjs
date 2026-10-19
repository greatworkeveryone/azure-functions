#!/usr/bin/env node
// Connected, fictional demo pack. Hard-coded local target; no cloud settings,
// external API calls, deletion or overwrite of records edited during a demo.
const fs = require('node:fs');
const path = require('node:path');
const PACK = 'floorplan-demo-v1';
const target = { server: 'localhost', database: 'floorplan_review' };
const CONTRACTORS = ['Top End Mechanical','Northern Electrical','Harbour Plumbing','Territory Fire Services','Monsoon Roofing','Palmerston Grounds','Territory Painting','Arafura Building Services','Darwin Commercial Cleaning'];
const SCENARIOS = [
  ['Air-conditioning condensate leak','HVAC / mechanical',0], ['Emergency lighting test','Electrical',1],
  ['Roof flashing after heavy rain','Other',4], ['Switchboard thermal inspection','Electrical',1],
  ['Garden irrigation repair','Grounds',5], ['Common-area repaint','Other',6],
  ['Tenant access coordination','HVAC / mechanical',0], ['Water pressure investigation','Hydraulic',2],
  ['Fire-door closer replacement','Fire & life safety',3], ['Cleaning contract renewal','Cleaning',8],
  ['Insurance renewal recommendation','Other',7], ['Replace corroded handrail','Other',7],
];
function demoScenario(buildingIndex, jobIndex, residence) {
  const index = residence ? (jobIndex === 0 ? 0 : 2) : (buildingIndex * 2 + jobIndex) % SCENARIOS.length;
  const [title, category, contractorIndex] = SCENARIOS[index];
  return { title, category, contractorIndex, contractor: `${CONTRACTORS[contractorIndex]} (Demo)` };
}
function assertTarget(server, database) {
  if (server !== target.server || database !== target.database) throw new Error('Demo pack only supports localhost/floorplan_review.');
}
function day(offset) { return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10); }
async function seed() {
  assertTarget(target.server, target.database);
  Object.assign(process.env, { LOCAL_SQL: 'true', SQL_SERVER: target.server, SQL_DATABASE: target.database, SQL_USERNAME: 'sa', SQL_PASSWORD: 'FloorplanReview2026_LocalOnly' });
  const db = require('../dist/db');
  const { TYPES } = require('tedious');
  const connection = await db.createLocalConnection();
  const counts = {};
  const newKeys = new Set();
  let inserted = 0;
  let reused = 0;
  const report = { pack: PACK, target: `${target.server}/${target.database}`, seededAt: new Date().toISOString(), fictional: true, records: [] };
  const param = (name, value) => ({ name, value, type: typeof value === 'number' ? TYPES.Float : typeof value === 'boolean' ? TYPES.Bit : TYPES.NVarChar });
  const query = (sql, values = {}) => db.executeQuery(connection, sql, Object.entries(values).map(([name, value]) => param(name, value)));
  async function add(table, pk, key, values) {
    const existing = await query('SELECT RecordId FROM dbo.ReviewDemoRecords WHERE Pack=@Pack AND RecordKey=@Key', { Pack: PACK, Key: key });
    let id;
    if (existing.length) { id = existing[0].RecordId; reused++; }
    else {
      try {
        const columns = Object.keys(values);
        const rows = await query(`INSERT INTO dbo.[${table}] (${columns.map(c => `[${c}]`).join(',')}) OUTPUT INSERTED.[${pk}] AS RecordId VALUES (${columns.map((_, i) => `@v${i}`).join(',')})`, Object.fromEntries(Object.values(values).map((v, i) => [`v${i}`, v])));
        id = String(rows[0].RecordId);
        await query('INSERT INTO dbo.ReviewDemoRecords (Pack,RecordKey,TableName,RecordId) VALUES (@Pack,@Key,@Table,@Id)', { Pack: PACK, Key: key, Table: table, Id: id });
        inserted++; newKeys.add(key);
      } catch (error) { throw new Error(`${key} (${table}): ${error.message}`); }
    }
    counts[table] = (counts[table] ?? 0) + 1;
    report.records.push({ table, key, id });
    return /^\d+$/.test(id) ? Number(id) : id;
  }
  try {
    const actual = await query('SELECT DB_NAME() AS DatabaseName');
    assertTarget(target.server, actual[0].DatabaseName);
    await db.executeBatch(connection, `SET XACT_ABORT ON;
      IF OBJECT_ID('dbo.ReviewDemoRecords','U') IS NULL CREATE TABLE dbo.ReviewDemoRecords (Pack NVARCHAR(80) NOT NULL,RecordKey NVARCHAR(200) NOT NULL,TableName NVARCHAR(80) NOT NULL,RecordId NVARCHAR(100) NOT NULL,CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),CONSTRAINT PK_ReviewDemoRecords PRIMARY KEY(Pack,RecordKey));
      BEGIN TRANSACTION;`);
    // Freeze scenario positions: adding another property must never change an
    // existing property's workflow, document numbers, intake IDs or dates.
    const originalOrder = [-3,-2,-1,33525,33526,33527,33528,33529,33530,33531,33532,33533,33534,33535,35612];
    await query("IF OBJECT_ID('dbo.ReviewDemoBuildingOrder','U') IS NULL CREATE TABLE dbo.ReviewDemoBuildingOrder (BuildingID INT NOT NULL PRIMARY KEY, ScenarioIndex INT NOT NULL UNIQUE)");
    for (let index=0;index<originalOrder.length;index++) await query('IF NOT EXISTS (SELECT 1 FROM dbo.ReviewDemoBuildingOrder WHERE BuildingID=@Building) INSERT dbo.ReviewDemoBuildingOrder (BuildingID,ScenarioIndex) VALUES (@Building,@Index)', { Building: originalOrder[index], Index: index });
    await query("INSERT dbo.ReviewDemoBuildingOrder (BuildingID,ScenarioIndex) SELECT b.BuildingID, (SELECT COALESCE(MAX(ScenarioIndex),-1) FROM dbo.ReviewDemoBuildingOrder) + ROW_NUMBER() OVER (ORDER BY b.BuildingID) FROM dbo.Buildings b WHERE b.Active=1 AND b.Category<>'development' AND b.BuildingID<>950001 AND NOT EXISTS (SELECT 1 FROM dbo.ReviewDemoBuildingOrder o WHERE o.BuildingID=b.BuildingID)");
    const buildings = await query("SELECT b.BuildingID,b.BuildingName,b.Levels,b.Category,o.ScenarioIndex FROM dbo.Buildings b JOIN dbo.ReviewDemoBuildingOrder o ON o.BuildingID=b.BuildingID WHERE b.Active=1 AND b.Category<>'development' AND b.BuildingID<>950001 ORDER BY o.ScenarioIndex");
    if (buildings.length < 15) throw new Error('Import the full reference portfolio before seeding the demo pack.');
    const users = await query("SELECT UserID,Role,DisplayName FROM dbo.AppUsers WHERE Email LIKE '%@review.invalid' AND IsActive=1");
    const user = role => { const row = users.find(u => u.Role === role); if (!row) throw new Error(`Run local-review prepare first: missing ${role} demo colleague.`); return row; };
    const fm = user('facilities_manager'), am = user('accounts_manager');
    const contractors = CONTRACTORS;
    for (let i = 0; i < contractors.length; i++) await add('Contractors','Id',`contractor-${i}`, { ContractorID: 980000 + i, ContractorName: `${contractors[i]} (Demo)`, EmailAddress: `contractor-${i}@demo.invalid`, Active: true, Suspended: false, ContractorCategory: ['HVAC / mechanical','Electrical','Hydraulic','Fire & life safety','Other','Grounds','Other','Other','Cleaning'][i], Acronym: `DM${i}` });
    for (let position = 0; position < buildings.length; position++) {
      const b = buildings[position];
      const i = b.ScenarioIndex;
      const residence = b.Category === 'residence';
      const prefix = `building-${b.BuildingID}`;
      let levels; try { levels = JSON.parse(b.Levels || '[]'); } catch { levels = []; }
      const level = typeof levels[0] === 'string' ? levels[0] : 'Ground Floor';
      const tenantId = await add('Tenants','TenantId',`${prefix}-tenant`, { BuildingId: b.BuildingID, LegalName: residence ? `Demo household ${i + 1}` : `${['Arafura Design Studio','Saltwater Allied Health','Territory Survey Group','North Coast Advisory'][i % 4]} ${i + 1} (Demo)`, TradingName: residence ? `Demo household ${i + 1}` : `Demo tenancy ${i + 1}`, PrimaryContactName: 'Demo tenant representative', PrimaryContactEmail: `tenant-${i}@demo.invalid`, AccountsEmail: `accounts-${i}@demo.invalid`, Commencement: residence ? null : day(-730), Expiry: residence ? null : day(i % 6 === 0 ? -30 : i % 4 === 0 ? 45 : 365 + i * 30), RentPerAnnum: residence ? 0 : 48000 + i * 7200, ReviewType: residence ? 'none' : i % 2 === 0 ? 'fixedPercent' : 'cpi', FixedReviewPercent: residence ? null : 3, ReviewIntervalMonths: 12, NextReviewDate: residence ? null : day(i % 3 === 0 ? -7 : 30 + i), LastReviewDate: residence ? null : day(-365), Status: !residence && i % 6 === 0 ? 'holdover' : 'current', Comments: 'Fictional client-demo tenancy. No real lease or financial record.', CreatedById: PACK, CreatedByName: 'Demo pack', UpdatedById: PACK, UpdatedByName: 'Demo pack', IsTest: true });
      await add('TenantOccupancies','OccupancyId',`${prefix}-occupancy`, { OccupancyId: `demo-occ-${b.BuildingID}`, TenantId: tenantId, BuildingId: b.BuildingID, Level: level, Area: 'Demo suite', SizeSqm: 180 + i * 25 });
      const locationId = await add('Locations','LocationId',`${prefix}-level`, { BuildingId: b.BuildingID, Kind: 'level', Name: `Demo · ${level}`, CreatedBy: PACK });
      const assetId = await add('Assets','AssetId',`${prefix}-asset`, { BuildingId: b.BuildingID, LocationId: locationId, Name: 'Demo split-system air conditioner', AssetTag: `DEMO-AC-${i + 1}`, Category: 'HVAC / mechanical', Make: 'Demonstration unit', Model: 'Sample 7.1kW', Status: 'active', Responsibility: 'owner', Criticality: 'standard', ServiceContractorId: 980000, WarrantyExpiry: day(365), Source: 'manual', CreatedBy: PACK, Notes: 'Fictional equipment for client demonstration.' });
      await add('ServiceSchedules','ServiceScheduleId',`${prefix}-service`, { BuildingId: b.BuildingID, AssetId: assetId, Category: 'HVAC / mechanical', Name: 'Demo quarterly air-conditioning service', ContractorId: 980000, IntervalCount: 3, IntervalUnit: 'months', AnchorDate: day(-90), NextDue: day(i % 3 === 0 ? -3 : 14 + i), CreatedBy: PACK });
      const keyId = await add('Keys','Id',`${prefix}-key`, { BuildingId: b.BuildingID, Level: level, KeyNumber: `DEMO-${i + 1}-MASTER`, Description: 'Demo contractor access key', StorageLocation: `Demo cabinet · hook ${i + 1}`, CreatedById: PACK, CreatedByName: 'Demo pack', IsTest: true });
      if (i < 4) {
        const batch = await add('KeyCheckoutBatches','Id',`${prefix}-checkout-batch`, { CheckedOutBy: 'Review Facilities (Demo)', CheckedOutTo: 'Demo contractor representative', CheckedOutAt: day(-3), ExpectedReturnAt: day(i % 2 ? 1 : -1), Notes: 'Fictional key handover for demonstration; no real keys released.' });
        await add('KeyCheckouts','Id',`${prefix}-checkout`, { BatchId: batch, KeyId: keyId, CheckedInAt: i === 3 ? day(-1) : null, IsTest: true });
      }
      const inspectionId = await add('Inspections','Id',`${prefix}-inspection`, { BuildingId: b.BuildingID, Title: `[DEMO] ${i % 2 ? 'Routine condition inspection' : 'Wet-season building check'}`, Status: 'draft', CreatedById: PACK, CreatedByName: 'Review Facilities', IsTest: true });
      const levelId = await add('InspectionLevels','Id',`${prefix}-inspection-level`, { Id: `demo-level-${b.BuildingID}`, InspectionId: inspectionId, Name: level });
      const roomId = await add('InspectionRooms','Id',`${prefix}-room`, { Id: `demo-room-${b.BuildingID}`, LevelId: levelId, Name: 'Common corridor', AddedById: PACK, AddedByName: 'Review Facilities' });
      const pointId = await add('InspectionPoints','Id',`${prefix}-point`, { Id: `demo-point-${b.BuildingID}`, RoomId: roomId, Description: `Demo finding: ${demoScenario(i, 0, residence).title}. Investigate the cause and record the required repair.`, AddedById: PACK, AddedByName: 'Review Facilities' });
      for (let j = 0; j < 2; j++) {
        const n = i * 2 + j;
        const scenario = demoScenario(i, j, residence);
        const status = ['New','Quote','Awaiting Approval','Work','Tenant','Done'][n % 6];
        const isAdmin = n % 11 === 10;
        const jobKey = `${prefix}-job-${j}`;
        const jobId = await add('Jobs','JobID',jobKey, { BuildingID: b.BuildingID, Title: `[DEMO] ${scenario.title}`, Description: 'Fictional connected demonstration scenario. Scope: inspect, document cause, obtain an itemised quote and arrange access. Retain completion evidence before closing.', AssignedTo: fm.DisplayName, AssignedToUserID: fm.UserID, Status: status, Priority: ['High','Normal','Low','Critical'][n % 4], IsStalled: n % 7 === 3, StalledReason: n % 7 === 3 ? 'Contractor not replying' : null, ExpectedProgressUpdate: status === 'Done' ? null : day(n % 7 === 3 ? -3 : 2 + j), CompletionDate: status === 'Done' ? day(-2) : null, CreatedAt: day(-10 - n), StatusSince: day(-5), CreatedBy: 'Demo pack', CreatedById: PACK, JobCode: `DEMO-${String(n + 1).padStart(3, '0')}`, LevelName: level, TenantID: tenantId, TenantName: residence ? `Demo household ${i + 1}` : `Demo tenancy ${i + 1}`, IsInternal: isAdmin, Kind: isAdmin ? 'admin' : n % 3 === 0 ? 'maintenance' : 'facilities', AwaitingRole: status === 'Awaiting Approval' ? 'accounts' : 'facilities', Category: scenario.category, CreationMethod: 'manual', IsTest: true, ...(j === 0 && !isAdmin ? { SourceInspectionId: inspectionId, SourceInspectionRoomId: roomId, SourceInspectionPointId: pointId } : {}) });
        await add('JobEvents','JobEventID',`${jobKey}-event`, { JobID: jobId, CreatedBy: 'Demo pack', CreatedAt: day(-9 - n), Text: 'Demo scenario created with fictional parties. Next step: confirm scope and access, then review the contractor proposal.', EventType: 'created', CreationSource: 'manual' });
        if (scenario.category === 'HVAC / mechanical') await add('JobAssets','LinkId',`${jobKey}-asset`, { JobId: jobId, AssetId: assetId, LinkedBy: PACK });
        if (j === 0 && !isAdmin) await add('InspectionRaisedJobs','Id',`${jobKey}-raised`, { InspectionId: inspectionId, PointId: pointId, JobId: jobId, RaisedById: PACK });
        if (!isAdmin && status !== 'New' && status !== 'Tenant') {
          const approved = status === 'Work' || status === 'Done';
          const amount = n % 6 === 2 ? 28500 : 1800 + n * 185;
          const quoteId = await add('Quotes','QuoteID',`${jobKey}-quote`, { JobID: jobId, QuoteNumber: `DEMO-Q-${n + 1}`, Seq: 1, ContractorID: 980000 + scenario.contractorIndex, ContractorName: scenario.contractor, Amount: amount, ReceivedAt: day(-8 - n), CreatedAt: day(-8 - n), Notes: 'Fictional quote. Supply, labour, testing and site clean-up included. Amount is for demonstration only.', Status: approved ? 'approved' : 'pending', ApprovedBy: approved ? 'Review Facilities Manager (demo history)' : null, ApprovedAt: approved ? day(-4) : null, CreatedBy: PACK, IsTest: true });
          if (approved) {
            if (newKeys.has(jobKey)) await query('UPDATE dbo.Jobs SET ApprovedQuoteID=@Quote WHERE JobID=@Job AND ApprovedQuoteID IS NULL', { Quote: quoteId, Job: jobId });
            await add('PurchaseOrders','PurchaseOrderID',`${jobKey}-po`, { JobID: jobId, PONumber: `DEMO-PO-${n + 1}`, Seq: 1, ContractorID: 980000 + scenario.contractorIndex, ContractorName: scenario.contractor, Scope: 'Demo repair scope, access and commissioning. Draft PO; never dispatched.', EstimatedCost: amount, CostNotToExceed: amount, CreatedBy: PACK, IsTest: true });
            await add('JobInvoices','JobInvoiceID',`${jobKey}-invoice`, { JobID: jobId, InvoiceNumber: `DEMO-I-${n + 1}`, SupplierInvoiceNumber: `SAMPLE-${n + 1}`, Seq: 1, ContractorID: 980000 + scenario.contractorIndex, ContractorName: scenario.contractor, Amount: Math.round(amount * (n % 2 ? 1.08 : 1)), ReceivedAt: day(-3), CreatedAt: day(-3), Notes: 'Fictional invoice for comparison. No payment was made or recorded.', Status: status === 'Done' ? 'approved' : 'pending', ApprovedBy: status === 'Done' ? 'Review Accounts Manager (demo history)' : null, ApprovedAt: status === 'Done' ? day(-2) : null, CreatedBy: PACK, IsTest: true });
          }
        }
        await add('DecisionLedger','LedgerId',`${jobKey}-ledger`, { Action: 'job.created', SubjectType: 'job', SubjectId: String(jobId), JobId: jobId, BuildingId: b.BuildingID, ActorName: 'Demo pack (fictional scenario)', ActorKind: 'system', Reason: 'Demonstration fixture, not an actual staff decision.', After: JSON.stringify({ status, title: scenario.title, demo: true }), CorrelationId: require('node:crypto').randomUUID(), IsException: false, AppVersion: PACK });
        if (isAdmin) {
          await add('JobDecisionRequests','RequestId',`${jobKey}-decision`, { JobId: jobId, Question: 'Demo: endorse the proposed renewal scope and authorise the manager to obtain final terms?', DecisionMakers: JSON.stringify({ role: 'director', userIds: [] }), AssignmentMode: 'role', Tier: 'soon', RespondBy: day(3), AutoEscalate: true, RequestedBy: 'Review Accounts Manager', RequestedByUserId: am.UserID });
          await add('Escalations','EscalationId',`${jobKey}-escalation`, { SubjectType: 'job', SubjectId: String(jobId), BuildingId: b.BuildingID, Kind: 'authority', PolicyKey: 'job.decision_pending', TargetRole: 'director', RaisedByUserId: am.UserID, RaisedByName: 'Review Accounts Manager', RaisedByKind: 'user', Summary: `[DEMO] Decision required · ${b.BuildingName}`, DueAt: day(3), Status: 'open', NotificationState: 'pending', Note: 'Demo routing only; background workers and outbound messages remain disabled.' });
        }
      }
      if (i < 6) await add('WorkRequests','Id',`${prefix}-intake`, { WorkRequestID: 980000 + i, JobCode: `DEMO-WR-${i + 1}`, BuildingID: b.BuildingID, BuildingName: b.BuildingName, LevelName: level, Details: `[DEMO] ${demoScenario(i, 0, residence).title} — tenant reported issue, awaiting triage.`, StatusID: 1, Status: 'New', Priority: 'Normal', ContactName: 'Demo tenant representative', ContactEmail: `tenant-${i}@demo.invalid`, SourceHost: 'demo.invalid' });
      if (i < 6) await add('Emails','EmailID',`${prefix}-email`, { MessageID: `demo-v1-${i}@demo.invalid`, FromAddress: `tenant-${i}@demo.invalid`, FromName: 'Demo tenant representative', Subject: `[DEMO] ${demoScenario(i, 0, residence).title} · ${b.BuildingName}`, Body: `Fictional demo email: please arrange a visit to ${level}. Photos and access can be confirmed with the demo facilities team. No real message was received.`, Status: i % 2 ? 'matched' : 'unread', ReceivedAt: day(-i), Source: 'ingest', IsTest: true });
      if (!residence && i >= 3 && i < 9) {
        const vacantTenant = await add('Tenants','TenantId',`${prefix}-vacant-tenant`, { BuildingId: b.BuildingID, LegalName: `Former demonstration tenant ${i + 1} (Demo)`, Status: 'vacated', ReviewType: 'none', Expiry: day(-15), RentPerAnnum: 0, CreatedById: PACK, CreatedByName: 'Demo pack', UpdatedById: PACK, UpdatedByName: 'Demo pack', IsTest: true });
        await add('TenantOccupancies','OccupancyId',`${prefix}-vacant-area`, { OccupancyId: `demo-vacant-${b.BuildingID}`, TenantId: vacantTenant, BuildingId: b.BuildingID, Level: level, Area: 'Demo vacant suite', SizeSqm: 90 });
        const vacancyId = await add('Vacancies','Id',`${prefix}-vacancy`, { BuildingId: b.BuildingID, TenancyId: vacantTenant, Title: `[DEMO] Office suite available · ${b.BuildingName}`, Address: b.BuildingName, Description: 'Fictional vacancy for demonstrating leasing workflow. Not an advertised real availability.', Status: 'draft', Images: '[]', IsTest: true });
        if (newKeys.has(`${prefix}-vacant-tenant`)) await query('UPDATE dbo.Vacancies SET TenancyId=@Tenant WHERE Id=@Id AND TenancyId IS NULL', { Tenant: vacantTenant, Id: vacancyId });
      }
    }
    for (const role of Object.values(require('../dist/auth').AppRole)) await query("IF NOT EXISTS (SELECT 1 FROM dbo.FeatureFlags WHERE FeatureKey='majorEvents' AND RoleName=@Role) INSERT dbo.FeatureFlags (FeatureKey,RoleName,Visibility,UpdatedBy) VALUES ('majorEvents',@Role,'enabled','local-review')", { Role: role });
    // Major Events are conspicuously fictional, additive and rerunnable. No mail is sent.
    const allEventBuildings = await query("SELECT BuildingID,BuildingName FROM dbo.Buildings WHERE Active=1");
    const eventBuilding = name => { const b = allEventBuildings.find(b => b.BuildingName.includes(name)); if (!b) throw new Error(`Missing event demo building ${name}`); return b.BuildingID; };
    const eventScenarios = [
      ['cyclone', 'Cyclone readiness exercise', 'operational', 'cyclone', [eventBuilding('Daly'), eventBuilding('Melville')], fm.DisplayName, 'Exercise only: secure roof access, check drainage and prepare a tenant notice before the wet season. No real weather warning.', false],
      ['shutdown', 'Melville electrical shutdown', 'operational', 'shutdown', [eventBuilding('Melville')], fm.DisplayName, 'Fictional planned switchboard isolation. Confirm contractor access and tenant notice before the demonstration shutdown.', false],
      ['finance', 'Insurance renewal review', 'financial', 'financial', [eventBuilding('Daly')], user('cfo').DisplayName, 'Fictional coordination record for policy documents and renewal options. Any expenditure must go through the existing job approval flow.', false],
      ['project', 'Melville refurbishment planning', 'operational', 'major_works', [eventBuilding('Melville')], fm.DisplayName, 'Fictional refurbishment project: coordinate scope, contractor access and evidence. Budget approval remains on jobs.', false],
      ['cyber', 'IT recovery exercise', 'financial', 'other', [eventBuilding('Daly')], user('cfo').DisplayName, 'Fictional exercise: isolate affected systems, preserve records and coordinate restoration. No real security incident occurred.', false],
      ['development', 'Old Red Cross site planning', 'operational', 'major_works', [eventBuilding('Red Cross')], fm.DisplayName, 'Fictional development project briefing for reviewing scope and action ownership. No actual development commitment.', false],
      ['flood', 'Stormwater response recap', 'operational', 'flood', [eventBuilding('Daly')], fm.DisplayName, 'Fictional completed response: drainage checked and access restored. Use this record to review the handover pack.', true],
    ];
    for (const [slug,title,domain,eventType,buildingIds,owner,brief,closed] of eventScenarios) {
      const plan = { buildingIds, jobIds: [], actions: [
        { id: 'access', title: 'Confirm contractor access and safe work area', owner: fm.DisplayName, due: `${day(1)}T08:00:00.000Z`, done: true },
        { id: 'notice', title: 'Confirm next steps and record the handover', owner: 'Review Facilities', due: `${day(2)}T08:00:00.000Z`, done: closed },
      ] };
      const event = await add('MajorEvents','EventId',`event-${slug}`, { Title: `[DEMO] ${title}`, Domain: domain, EventType: eventType, EventKind: slug === 'cyber' ? 'it_failure' : slug === 'development' ? 'development' : slug === 'project' ? 'refurbishment' : eventType, EventClass: ['project','development'].includes(slug) ? 'project' : ['shutdown','flood'].includes(slug) ? 'minor' : 'major', Audience: domain === 'financial' ? 'managers' : 'operational_staff', Status: closed ? 'closed' : 'active', OwnerName: owner, StartsAt: `${day(-1)}T08:00:00.000Z`, EndsAt: `${day(3)}T08:00:00.000Z`, Brief: brief, PlanJson: JSON.stringify(plan), CreatedBy: 'Fictional demo pack', CreatedByOid: PACK, ...(closed ? { ClosedAt: `${day(0)}T08:00:00.000Z`, ClosedBy: owner } : {}) });
      // Classify only untouched seed-owned rows from the first review; never overwrite an edited plan.
      await query("UPDATE dbo.MajorEvents SET EventClass=@Class WHERE EventId=@Event AND CreatedByOid=@Pack AND Revision=1", { Class: ['project','development'].includes(slug) ? 'project' : ['shutdown','flood'].includes(slug) ? 'minor' : 'major', Event: event, Pack: PACK });
      await add('MajorEventEntries','EntryId',`event-${slug}-created`, { EventId: event, EntryType: 'created', Body: JSON.stringify(plan), ActorName: owner, ActorOid: PACK });
      await add('MajorEventEntries','EntryId',`event-${slug}-update`, { EventId: event, EntryType: 'update', BuildingId: buildingIds[0], Area: 'Ground / common areas', Body: 'DEMO: site access checked; contractor coordination is recorded here rather than in a separate chat.', ActorName: 'Review Facilities', ActorOid: PACK });
      if (closed) await add('MajorEventEntries','EntryId',`event-${slug}-closed`, { EventId: event, EntryType: 'closed', Body: 'DEMO: All exercise actions complete. No real incident occurred.', ActorName: owner, ActorOid: PACK });
    }
    const data = Object.fromEntries(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map((d, i) => [d, i < 5 ? [{ startTime: '08:30', endTime: '17:00', breakMinutes: 30, comment: 'Demo inspections and contractor coordination' }] : []]));
    const monday = new Date(); monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7 - 7);
    for (const role of ['facilities','accounts']) { const u = user(role); await add('Timesheets','TimesheetID',`timesheet-${role}`, { UserID: u.UserID, UserDisplayName: u.DisplayName, WeekStartDate: monday.toISOString().slice(0, 10), Role: role, Data: JSON.stringify(data), ReadyForApproval: true, CreatedBy: PACK }); }
    if (!process.argv.includes("--without-evidence")) {
    // Store real, openable evidence in loopback Azurite, using valid job blob names.
    const { BlobServiceClient } = require('@azure/storage-blob');
    const { createDemoEvidence } = require('./lib/review-demo-pdf.cjs');
    const blobContainer = BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true').getContainerClient('wr-attachments');
    await blobContainer.createIfNotExists();
    const documents = [
      ...await query(`SELECT q.QuoteID AS Id,q.JobID,q.QuoteNumber AS Number,q.ContractorName,q.Amount,j.Title,b.BuildingName FROM dbo.Quotes q JOIN dbo.Jobs j ON j.JobID=q.JobID JOIN dbo.Buildings b ON b.BuildingID=j.BuildingID JOIN dbo.ReviewDemoRecords r ON r.TableName='Quotes' AND r.RecordId=CAST(q.QuoteID AS NVARCHAR(100)) AND r.Pack=@Pack`, { Pack: PACK }).then(rows => rows.map(row => ({ ...row, kind: 'quote' }))),
      ...await query(`SELECT q.JobInvoiceID AS Id,q.JobID,q.InvoiceNumber AS Number,q.ContractorName,q.Amount,j.Title,b.BuildingName FROM dbo.JobInvoices q JOIN dbo.Jobs j ON j.JobID=q.JobID JOIN dbo.Buildings b ON b.BuildingID=j.BuildingID JOIN dbo.ReviewDemoRecords r ON r.TableName='JobInvoices' AND r.RecordId=CAST(q.JobInvoiceID AS NVARCHAR(100)) AND r.Pack=@Pack`, { Pack: PACK }).then(rows => rows.map(row => ({ ...row, kind: 'invoice' }))),
    ];
    const documentDir = path.join(__dirname, '../.review-local/documents'); fs.mkdirSync(documentDir, { recursive: true });
    for (const record of documents) {
      const docKey = `evidence-${record.kind}-${record.Id}`;
      const hash = require('node:crypto').createHash('sha256').update(`${PACK}-${docKey}`).digest('hex').slice(0, 32);
      const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
      const blobName = `attachments/jobs/${record.JobID}/${uuid}.pdf`;
      const blob = blobContainer.getBlockBlobClient(blobName);
      const pdf = await createDemoEvidence({ kind: record.kind, number: record.Number, contractor: record.ContractorName, building: record.BuildingName, title: record.Title, amount: record.Amount });
      if (!await blob.exists()) await blob.uploadData(pdf, { blobHTTPHeaders: { blobContentType: 'application/pdf', blobContentDisposition: `inline; filename="${record.Number}.pdf"` } });
      fs.writeFileSync(path.join(documentDir, `${record.Number}.pdf`), pdf);
      const attachmentId = await add('Attachments','Id',docKey, { JobID: record.JobID, BlobName: blobName, OriginalName: `${record.Number}.pdf`, Extension: 'pdf', ContentType: 'application/pdf', SizeBytes: pdf.length, UploadedBy: PACK });
      await add(record.kind === 'quote' ? 'QuoteAttachments' : 'JobInvoiceAttachments', record.kind === 'quote' ? 'QuoteID' : 'JobInvoiceID', `${docKey}-link`, { [record.kind === 'quote' ? 'QuoteID' : 'JobInvoiceID']: record.Id, AttachmentID: attachmentId, AttachedBy: PACK });
      if (newKeys.has(docKey)) await query(record.kind === 'quote' ? 'UPDATE dbo.Quotes SET QuotePDFBlobName=@Blob WHERE QuoteID=@Id AND QuotePDFBlobName IS NULL' : 'UPDATE dbo.JobInvoices SET InvoicePDFBlobName=@Blob WHERE JobInvoiceID=@Id AND InvoicePDFBlobName IS NULL', { Blob: blobName, Id: record.Id });
    }
    }
    if (!process.argv.includes('--without-evidence')) {
      const { BlobServiceClient } = require('@azure/storage-blob');
      const { majorEventPack } = require('../dist/majorEventPack');
      const eventToApi = e => ({ id: e.EventId, title: e.Title, domain: e.Domain, status: e.Status, brief: e.Brief, ownerName: e.OwnerName, startsAt: new Date(e.StartsAt).toISOString(), endsAt: e.EndsAt ? new Date(e.EndsAt).toISOString() : null, plan: JSON.parse(e.PlanJson) });
      const storage = BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true').getContainerClient('wr-attachments');
      const events = await query("SELECT e.* FROM dbo.MajorEvents e JOIN dbo.ReviewDemoRecords r ON r.TableName='MajorEvents' AND r.RecordId=CAST(e.EventId AS NVARCHAR(100)) AND r.Pack=@Pack", { Pack: PACK });
      for (const event of events) {
        const hash = require('node:crypto').createHash('sha256').update(`${PACK}-event-${event.EventId}`).digest('hex').slice(0,32);
        const uuid = `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20)}`;
        const blobName = `major-events/${event.EventId}/${uuid}.pdf`;
        const blob = storage.getBlockBlobClient(blobName);
        const pdf = await majorEventPack(eventToApi(event), [], buildings, []);
        if (!await blob.exists()) await blob.uploadData(pdf, { blobHTTPHeaders: { blobContentType: 'application/pdf' } });
        const props = await blob.getProperties();
        await add('MajorEventDocuments','DocumentId',`event-${event.EventId}-document`, { EventId: event.EventId, FileName: 'DEMO-initial-briefing.pdf', BlobName: blobName, ContentType: 'application/pdf', SizeBytes: props.contentLength, UploadedBy: 'Fictional demo pack' });
      }
    }
    for (const role of Object.values(require('../dist/auth').AppRole)) await query("IF NOT EXISTS (SELECT 1 FROM dbo.FeatureFlags WHERE FeatureKey='documentation' AND RoleName=@Role) INSERT dbo.FeatureFlags (FeatureKey,RoleName,Visibility,UpdatedBy) VALUES ('documentation',@Role,'enabled','local-review')", { Role: role });
    if (!process.argv.includes('--without-evidence')) {
      const { BlobServiceClient } = require('@azure/storage-blob');
      const { createRegisterEvidence } = require('./lib/review-register-pdf.cjs');
      const storage = BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true').getContainerClient('wr-attachments');
      const samples = [
        ['mechanical', 'Mechanical / air conditioning', 'Air-conditioning service certificate', 'certificate', -240, 18, 12],
        ['fire', 'Fire / life safety', 'Fire systems inspection certificate', 'certificate', -390, -25, -30],
        ['evacuation', 'Evacuation', 'Emergency evacuation plan', 'plan', -180, null, 25],
        ['telecom', 'Telecommunications', 'Structured cabling test report', 'report', -60, 305, 120],
        ['plumbing', 'Plumbing / hydraulic', 'Backflow prevention test certificate', 'certificate', -355, 10, null],
        ['electrical', 'Electrical', 'Electrical safety inspection certificate', 'certificate', -50, 315, 180],
        ['manual', 'Building / structural', 'Building access and plant manual', 'manual', -60, null, null],
      ];
      for (let index=0;index<samples.length;index++) {
        const [key,category,title,kind,issued,expiry,review] = samples[index];
        const building = buildings[index % buildings.length];
        const metadata = { Title:`[DEMO] ${title}`, Kind:kind, ServiceCategory:category, BuildingId:building.BuildingID, TenantId:null, IssuedOn:day(issued), ExpiresOn:expiry===null?null:day(expiry), ReviewDue:review===null?null:day(review), OwnerName:fm.DisplayName, Notes:'Fictional demonstration record. Dates illustrate expiry tracking only; they do not establish a statutory certification interval.' };
        const hash=require('node:crypto').createHash('sha256').update(`${PACK}-register-${key}`).digest('hex').slice(0,32);
        const uuid=`${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20)}`;
        const blobName=`documentation/${uuid}.pdf`;
        const blob=storage.getBlockBlobClient(blobName);
        const pdf=await createRegisterEvidence({ ...metadata, BuildingName:building.BuildingName });
        if (!await blob.exists()) await blob.uploadData(pdf,{blobHTTPHeaders:{blobContentType:'application/pdf'}});
        const props=await blob.getProperties();
        const documentId=await add('RegisterDocuments','DocumentId',`register-${key}`,{...metadata,FileName:`DEMO-${key}.pdf`,BlobName:blobName,ContentType:'application/pdf',SizeBytes:props.contentLength,CreatedBy:'Fictional demo pack',CreatedByOid:PACK});
        await add('RegisterDocumentAudit','AuditId',`register-${key}-audit`,{DocumentId:documentId,Action:'created',SnapshotJson:JSON.stringify(metadata),ActorName:'Fictional demo pack',ActorOid:PACK});
      }
      const tenants=await query("SELECT TOP(3) t.TenantId,t.LegalName,t.BuildingId,t.Expiry,b.BuildingName FROM dbo.Tenants t JOIN dbo.Buildings b ON b.BuildingID=t.BuildingId JOIN dbo.ReviewDemoRecords r ON r.TableName='Tenants' AND r.RecordId=CAST(t.TenantId AS NVARCHAR(100)) AND r.Pack=@Pack WHERE t.Expiry IS NOT NULL AND t.Status<>'vacated' ORDER BY t.Expiry,t.TenantId",{Pack:PACK});
      for (const tenant of tenants) {
        const hash=require('node:crypto').createHash('sha256').update(`${PACK}-lease-${tenant.TenantId}`).digest('hex').slice(0,32);
        const uuid=`${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20)}`;
        const blobName=`tenancy-${tenant.TenantId}/${uuid}.pdf`;
        const pdf=await createRegisterEvidence({Title:`[DEMO] Lease evidence — ${tenant.LegalName}`,BuildingName:tenant.BuildingName,OwnerName:am.DisplayName,IssuedOn:day(-90),ExpiresOn:tenant.Expiry?new Date(tenant.Expiry).toISOString().slice(0,10):null,Notes:'Fictional lease evidence for navigation and permissions testing. This is not a lease or legal agreement.'});
        const blob=storage.getBlockBlobClient(blobName);
        if (!await blob.exists()) await blob.uploadData(pdf,{blobHTTPHeaders:{blobContentType:'application/pdf'}});
        const props=await blob.getProperties();
        const attachment=await add('Attachments','Id',`lease-${tenant.TenantId}`,{JobID:null,BlobName:blobName,OriginalName:`DEMO-lease-${tenant.TenantId}.pdf`,Extension:'pdf',ContentType:'application/pdf',SizeBytes:props.contentLength,UploadedBy:PACK});
        await add('TenancyAttachments','AttachmentID',`lease-${tenant.TenantId}-link`,{TenantId:tenant.TenantId,AttachmentID:attachment,AttachedBy:PACK});
      }
    }
    const [integrity] = await query(`SELECT (SELECT COUNT(*) FROM dbo.JobAssets a JOIN dbo.Jobs j ON j.JobID=a.JobId JOIN dbo.Assets x ON x.AssetId=a.AssetId WHERE j.CreatedById=@Pack AND j.BuildingID<>x.BuildingId) AS WrongBuildingAssetLinks,(SELECT COUNT(*) FROM dbo.Jobs j JOIN dbo.Quotes q ON q.QuoteID=j.ApprovedQuoteID WHERE j.CreatedById=@Pack AND q.JobID<>j.JobID) AS WrongQuoteLinks,(SELECT COUNT(*) FROM dbo.Jobs j JOIN dbo.Tenants t ON t.TenantId=j.TenantID WHERE j.CreatedById=@Pack AND t.BuildingId<>j.BuildingID) AS WrongTenancyLinks`, { Pack: PACK });
    if (Object.values(integrity).some(value => value !== 0)) throw new Error('Demo relationship integrity check failed.');
    report.integrity = integrity;
    await db.executeBatch(connection, 'COMMIT TRANSACTION;');
    report.counts = counts; report.inserted = inserted; report.reused = reused;
    const logDir = path.join(__dirname, '../.review-local/logs'); fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'demo-pack.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ pack: PACK, target: report.target, inserted, reused, counts }, null, 2));
  } catch (error) { await db.executeBatch(connection, 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;').catch(() => {}); throw error; }
  finally { connection.close(); }
}
module.exports = { assertTarget, demoScenario, CONTRACTORS };
if (require.main === module) seed().catch(error => { console.error(error.message); process.exitCode = 1; });
