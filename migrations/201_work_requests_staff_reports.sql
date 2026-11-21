-- Staff-reported problems land in Job intake as work requests (decision D4, AF7).
-- Additive and idempotent: three nullable columns on dbo.WorkRequests.
--   Source          NULL for a myBuildings request, 'staff' for one a member of staff reported
--   ReportedByOid   the reporter's Entra object id, from the verified token (never the request body)
--   ReportedByName  their name at the time, so the list reads without a lookup
-- Staff reports use WorkRequestID values from 1,900,000,000 up, a range myBuildings never reaches,
-- so the myBuildings sync (which upserts by WorkRequestID) can neither collide with nor remove them.
IF COL_LENGTH(N'dbo.WorkRequests', N'Source') IS NULL
  ALTER TABLE dbo.WorkRequests ADD Source NVARCHAR(30) NULL;
GO

IF COL_LENGTH(N'dbo.WorkRequests', N'ReportedByOid') IS NULL
  ALTER TABLE dbo.WorkRequests ADD ReportedByOid NVARCHAR(255) NULL;
GO

IF COL_LENGTH(N'dbo.WorkRequests', N'ReportedByName') IS NULL
  ALTER TABLE dbo.WorkRequests ADD ReportedByName NVARCHAR(255) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_WorkRequests_ReportedByOid' AND object_id = OBJECT_ID(N'dbo.WorkRequests'))
  EXEC(N'CREATE INDEX IX_WorkRequests_ReportedByOid ON dbo.WorkRequests (ReportedByOid) WHERE ReportedByOid IS NOT NULL');
GO
