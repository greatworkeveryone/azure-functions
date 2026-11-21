-- Timesheet saves carry a version (database-safety rule 6): two devices, or an officer and
-- the manager who edits their sheet, can no longer overwrite each other's week silently.
-- Additive and idempotent. Existing rows start at revision 1; every write adds one.
IF NOT EXISTS (
  SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.Timesheets') AND name = N'Revision'
)
BEGIN
  ALTER TABLE dbo.Timesheets
    ADD Revision INT NOT NULL CONSTRAINT DF_Timesheets_Revision DEFAULT 1;
END
GO
