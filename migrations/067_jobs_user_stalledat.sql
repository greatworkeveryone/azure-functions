-- Migration 067: Jobs — add AssignedToUserID FK and StalledAt timestamp.
-- AssignedToUserID is nullable; existing jobs keep AssignedTo (display name)
-- until re-assigned. StalledAt is set when IsStalled flips to 1 and cleared
-- when it flips back to 0 — used to set the due date on Planner stall tasks.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'AssignedToUserID')
    ALTER TABLE dbo.Jobs ADD AssignedToUserID INT NULL;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'StalledAt')
    ALTER TABLE dbo.Jobs ADD StalledAt DATETIME2 NULL;

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Jobs_AppUsers')
    ALTER TABLE dbo.Jobs
        ADD CONSTRAINT FK_Jobs_AppUsers
            FOREIGN KEY (AssignedToUserID) REFERENCES dbo.AppUsers(UserID);

-- Dynamic SQL defers column resolution to runtime, avoiding a compile-time
-- "Invalid column name" error when the column was just added in this batch.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.Jobs') AND name = 'IX_Jobs_AssignedToUserID')
    EXEC('CREATE INDEX IX_Jobs_AssignedToUserID ON dbo.Jobs(AssignedToUserID)
              WHERE AssignedToUserID IS NOT NULL');

-- Backfill StalledAt for jobs already stalled before this migration.
-- Uses LastModifiedDate as the best available proxy for when stalling occurred.
EXEC('UPDATE dbo.Jobs SET StalledAt = LastModifiedDate WHERE IsStalled = 1 AND StalledAt IS NULL');
