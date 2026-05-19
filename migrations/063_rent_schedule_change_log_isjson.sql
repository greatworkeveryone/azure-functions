-- Migration 063: Add ISJSON check constraints to RentScheduleChangeLog JSON columns.
-- Prevents malformed JSON from being written to StepSnapshot / Diff, which would
-- crash the getRegisterTenant endpoint at JSON.parse time.

ALTER TABLE dbo.RentScheduleChangeLog
  ADD CONSTRAINT CK_RentScheduleChangeLog_StepSnapshotJson
    CHECK (ISJSON(StepSnapshot) = 1);
GO

ALTER TABLE dbo.RentScheduleChangeLog
  ADD CONSTRAINT CK_RentScheduleChangeLog_DiffJson
    CHECK (Diff IS NULL OR ISJSON(Diff) = 1);
GO
