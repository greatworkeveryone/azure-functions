-- Migration 007: Seed ~20 test Jobs
--
-- Half are linked to randomly-picked existing WorkRequests (Jobs.WorkRequestID
-- set, same BuildingID as the WR so the relationship is coherent). The other
-- half are standalone jobs across random active Buildings.
--
-- Distribution goals: every status (Awaiting Approval, Quote, Work, Tenant,
-- Parts, Done) appears in both batches, and IsStalled=1 is spread across
-- multiple statuses rather than concentrated on Awaiting Approval. Done rows
-- carry CompletionDate (past) instead of ExpectedProgressUpdate (future).
--
-- Idempotent: tagged with CreatedBy='seed:007' and guarded so re-running this
-- migration against a DB that already has seed jobs is a no-op. To reseed:
--   DELETE FROM dbo.Jobs WHERE CreatedBy = 'seed:007'; -- events cascade
--   then re-run this file.

IF NOT EXISTS (SELECT 1 FROM dbo.Jobs WHERE CreatedBy = 'seed:007')
BEGIN
  -- ── 10 jobs linked to random existing WRs ─────────────────────────────────
  -- Takes the WR's BuildingID so Jobs.BuildingID stays consistent with the
  -- linked WorkRequest.BuildingID. Skips WRs that already have a job attached.
  WITH picked_wrs AS (
    SELECT TOP (10)
           wr.WorkRequestID,
           wr.BuildingID,
           ROW_NUMBER() OVER (ORDER BY NEWID()) AS rn
    FROM dbo.WorkRequests wr
    WHERE wr.BuildingID IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM dbo.Jobs j WHERE j.WorkRequestID = wr.WorkRequestID
      )
    ORDER BY NEWID()
  ),
  linked_template AS (
    SELECT v.rn, v.title, v.descr, v.status, v.assignee, v.is_stalled, v.days_out
    FROM (VALUES
      ( 1, 'Approval pending',                    'Sent to property manager for sign-off',      'Awaiting Approval', 'admin@rpcc.com.au',       1,  3),
      ( 2, 'Second quote requested',              'First quote was over budget',                'Quote',             'maintenance@rpcc.com.au', 0,  6),
      ( 3, 'Quote stuck with contractor',         'Chasing contractor for revised figures',     'Quote',             'ops@rpcc.com.au',         1,  9),
      ( 4, 'Scheduling work',                     'Contractor confirmed, booking slot',         'Work',              'maintenance@rpcc.com.au', 0,  4),
      ( 5, 'Work paused — access issue',          'Site access blocked, escalating',            'Work',              'ops@rpcc.com.au',         1,  5),
      ( 6, 'Awaiting tenant access',              'Tenant to confirm preferred date',           'Tenant',            'admin@rpcc.com.au',       0,  7),
      ( 7, 'Tenant unresponsive',                 'Two follow-ups sent, no reply',              'Tenant',            'admin@rpcc.com.au',       1, 11),
      ( 8, 'Warranty claim in progress',          'Awaiting manufacturer response',             'Parts',             'maintenance@rpcc.com.au', 1, 14),
      ( 9, 'Parts arrived, scheduling install',   'Booking contractor for next week',           'Parts',             'ops@rpcc.com.au',         0,  5),
      (10, 'Install complete',                    'Signed off by site manager',                 'Done',              'maintenance@rpcc.com.au', 0,  2)
    ) v(rn, title, descr, status, assignee, is_stalled, days_out)
  )
  INSERT INTO dbo.Jobs
    (BuildingID, WorkRequestID, Title, Description, AssignedTo, Status,
     IsStalled, ExpectedProgressUpdate, CompletionDate, CreatedBy)
  SELECT
    p.BuildingID,
    p.WorkRequestID,
    t.title,
    t.descr,
    t.assignee,
    t.status,
    t.is_stalled,
    CASE WHEN t.status = 'Done' THEN NULL
         ELSE DATEADD(DAY,  t.days_out, SYSUTCDATETIME()) END,
    CASE WHEN t.status = 'Done' THEN DATEADD(DAY, -t.days_out, SYSUTCDATETIME())
         ELSE NULL END,
    'seed:007'
  FROM picked_wrs p
  INNER JOIN linked_template t ON t.rn = p.rn;

  -- ── 10 standalone jobs across random active buildings ────────────────────
  WITH picked_buildings AS (
    SELECT TOP (10)
           BuildingID,
           ROW_NUMBER() OVER (ORDER BY NEWID()) AS rn
    FROM dbo.Buildings
    WHERE Active = 1
    ORDER BY NEWID()
  ),
  standalone_template AS (
    SELECT v.rn, v.title, v.descr, v.status, v.assignee, v.is_stalled, v.days_out
    FROM (VALUES
      ( 1, 'Cleaning contract renewal review',    'Current contract expires next quarter',      'Awaiting Approval', 'admin@rpcc.com.au',       0,  7),
      ( 2, 'New plumber onboarding',              'Insurance and inductions pending',           'Awaiting Approval', 'admin@rpcc.com.au',       1,  3),
      ( 3, 'Roof works budget planning',          'Gather three quotes for next FY',            'Quote',             'ops@rpcc.com.au',         1, 12),
      ( 4, 'Carpark line-marking refresh',        'Scoping works for next month',               'Quote',             'ops@rpcc.com.au',         0,  8),
      ( 5, 'Annual HVAC service scheduling',      'Lock in dates across portfolio',             'Work',              'maintenance@rpcc.com.au', 0,  6),
      ( 6, 'Site inspection follow-up',           'Items flagged during last walk-around',      'Work',              'maintenance@rpcc.com.au', 1,  4),
      ( 7, 'Tenant fit-out coordination',         'Awaiting tenant architect drawings',         'Tenant',            'admin@rpcc.com.au',       0,  9),
      ( 8, 'Lift consultant engagement',          '10-year plan assessment required',           'Tenant',            'admin@rpcc.com.au',       1, 14),
      ( 9, 'Fire equipment stocktake',            'Confirm extinguishers serviced and logged',  'Parts',             'maintenance@rpcc.com.au', 1,  4),
      (10, 'Quarterly compliance review',         'Fire + safety certifications filed',         'Done',              'admin@rpcc.com.au',       0,  5)
    ) v(rn, title, descr, status, assignee, is_stalled, days_out)
  )
  INSERT INTO dbo.Jobs
    (BuildingID, WorkRequestID, Title, Description, AssignedTo, Status,
     IsStalled, ExpectedProgressUpdate, CompletionDate, CreatedBy)
  SELECT
    b.BuildingID,
    NULL,
    t.title,
    t.descr,
    t.assignee,
    t.status,
    t.is_stalled,
    CASE WHEN t.status = 'Done' THEN NULL
         ELSE DATEADD(DAY,  t.days_out, SYSUTCDATETIME()) END,
    CASE WHEN t.status = 'Done' THEN DATEADD(DAY, -t.days_out, SYSUTCDATETIME())
         ELSE NULL END,
    'seed:007'
  FROM picked_buildings b
  INNER JOIN standalone_template t ON t.rn = b.rn;
END
GO
