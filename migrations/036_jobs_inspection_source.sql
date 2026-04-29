-- Migration 036: Track inspection provenance on Jobs.
--
-- /raiseJobsFromInspection used to mint placeholder JobIds and only insert into
-- the InspectionRaisedJobs link table — no real Jobs row, no audit trail back
-- to which inspection raised the work.
--
-- This migration adds three nullable backlink columns on dbo.Jobs so a job
-- created from an inspection knows which inspection / room / point it came
-- from. They stay NULL for jobs created any other way (manual / WR / email).
--
--   SourceInspectionId       — Inspections.Id of the inspection that raised it
--   SourceInspectionRoomId   — InspectionRooms.Id (set on both per-point and per-room jobs)
--   SourceInspectionPointId  — InspectionPoints.Id (per-point jobs only; NULL when one job rolls up multiple points in a room)
--
-- Idempotent: each ALTER guarded by a sys.columns check.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'SourceInspectionId')
  ALTER TABLE dbo.Jobs ADD SourceInspectionId INT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'SourceInspectionRoomId')
  ALTER TABLE dbo.Jobs ADD SourceInspectionRoomId NVARCHAR(40) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'SourceInspectionPointId')
  ALTER TABLE dbo.Jobs ADD SourceInspectionPointId NVARCHAR(40) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Jobs_SourceInspectionId' AND object_id = OBJECT_ID('dbo.Jobs'))
  CREATE INDEX IX_Jobs_SourceInspectionId ON dbo.Jobs(SourceInspectionId) WHERE SourceInspectionId IS NOT NULL;
GO
