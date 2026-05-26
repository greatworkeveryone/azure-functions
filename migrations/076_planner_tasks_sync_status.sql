-- Migration 076: PlannerTasks — per-row sync outcome tracking.
-- Lets the UI show "when was this reminder last attempted, did it fail, why".
-- LastSyncedAt updates on every create / recreate / skip; LastError clears on
-- success and is set on failure. AttemptCount only increments on actual Graph
-- API attempts (not on skipped no-ops).

ALTER TABLE dbo.PlannerTasks ADD
    LastSyncedAt  DATETIME2     NULL,
    LastError     NVARCHAR(1000) NULL,
    AttemptCount  INT           NOT NULL DEFAULT 0;
GO

CREATE INDEX IX_PlannerTasks_LastError
    ON dbo.PlannerTasks (LastError)
    WHERE LastError IS NOT NULL;
