-- Migration 085: Referential integrity for inspection ↔ job links.
--
-- Two columns were created without foreign keys:
--   - Jobs.SourceInspectionId (m036) — deleting an inspection stranded the
--     backlink on any job it raised.
--   - InspectionRaisedJobs.JobId (m034) — deleting a job stranded link rows,
--     inflating the inspection list's raised-point/job counts.
--
-- This migration first cleans any rows those gaps already stranded, then adds:
--   FK Jobs.SourceInspectionId       → dbo.Inspections(Id)  ON DELETE SET NULL
--   FK InspectionRaisedJobs.JobId    → dbo.Jobs(JobID)      ON DELETE CASCADE
--
-- Deliberately NO FK on InspectionRaisedJobs.PointId: points already cascade
-- via Inspections → Levels → Rooms → Points, so a second cascade path through
-- InspectionRaisedJobs would be rejected by SQL Server (multiple cascade
-- paths). deleteInspection clears the link rows explicitly instead.
--
-- Idempotent: cleanups are no-ops on clean data; FK adds are guarded.

-- 1. Clean dangling job backlinks (inspection deleted before this FK existed).
UPDATE j
   SET j.SourceInspectionId = NULL
  FROM dbo.Jobs j
 WHERE j.SourceInspectionId IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM dbo.Inspections i WHERE i.Id = j.SourceInspectionId);
GO

-- 2. Clean dangling raised-job links (job deleted before this FK existed).
DELETE r
  FROM dbo.InspectionRaisedJobs r
 WHERE NOT EXISTS (SELECT 1 FROM dbo.Jobs j WHERE j.JobID = r.JobId);
GO

-- 3. Jobs.SourceInspectionId → Inspections(Id), SET NULL on delete: the job
--    survives its source inspection, it just loses the provenance backlink.
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Jobs_SourceInspection' AND parent_object_id = OBJECT_ID('dbo.Jobs'))
  ALTER TABLE dbo.Jobs
    ADD CONSTRAINT FK_Jobs_SourceInspection
    FOREIGN KEY (SourceInspectionId) REFERENCES dbo.Inspections(Id) ON DELETE SET NULL;
GO

-- 4. InspectionRaisedJobs.JobId → Jobs(JobID), CASCADE on delete: a link row
--    is meaningless without its job.
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_InspectionRaisedJobs_Job' AND parent_object_id = OBJECT_ID('dbo.InspectionRaisedJobs'))
  ALTER TABLE dbo.InspectionRaisedJobs
    ADD CONSTRAINT FK_InspectionRaisedJobs_Job
    FOREIGN KEY (JobId) REFERENCES dbo.Jobs(JobID) ON DELETE CASCADE;
GO
