-- Migration 061: Rent Schedule Change Log
-- Append-only audit trail for every add, update, and delete
-- made to a tenant's ScheduledRateSteps array.

CREATE TABLE dbo.RentScheduleChangeLog (
    ChangeId        NVARCHAR(40)   NOT NULL PRIMARY KEY,
    TenantId        INT            NOT NULL,
    BuildingId      INT            NOT NULL,
    StepId          NVARCHAR(40)   NOT NULL,
    ChangeKind      NVARCHAR(20)   NOT NULL,   -- 'added' | 'updated' | 'deleted'
    ChangedAt       DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    ChangedById     NVARCHAR(200)  NULL,
    ChangedByName   NVARCHAR(200)  NULL,
    -- Full step JSON after change (or before, for 'deleted')
    StepSnapshot    NVARCHAR(MAX)  NOT NULL,
    -- Field-level diff JSON: { "fieldName": { "from": ..., "to": ... } }
    -- NULL for 'added' and 'deleted' (snapshot is the full record)
    Diff            NVARCHAR(MAX)  NULL,

    CONSTRAINT FK_RentScheduleChangeLog_Tenants
        FOREIGN KEY (TenantId) REFERENCES dbo.Tenants(TenantId)
            ON DELETE CASCADE,

    CONSTRAINT CK_RentScheduleChangeLog_ChangeKind
        CHECK (ChangeKind IN ('added', 'updated', 'deleted'))
);

-- Efficient lookup by tenant (primary query pattern)
CREATE INDEX IX_RentScheduleChangeLog_TenantId
    ON dbo.RentScheduleChangeLog (TenantId, ChangedAt DESC);

-- Efficient lookup by step (for per-step history)
CREATE INDEX IX_RentScheduleChangeLog_StepId
    ON dbo.RentScheduleChangeLog (StepId, ChangedAt DESC);
