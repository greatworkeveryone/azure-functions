-- Migration 062: Planner Tasks
-- Tracks every Planner task created by the sync timer.
-- EntityType + EntityId + TriggerType + LeadTimeDays = unique dedup key.

CREATE TABLE dbo.PlannerTasks (
    Id              INT           IDENTITY PRIMARY KEY,
    EntityType      VARCHAR(50)   NOT NULL,  -- 'tenant' | 'job'
    EntityId        INT           NOT NULL,
    TriggerType     VARCHAR(50)   NOT NULL,  -- 'lease_expiry' | 'option_notice' | 'rent_review' | 'job_update_due'
    LeadTimeDays    INT           NOT NULL,  -- 90 | 60 | 30 | 0
    PlannerTaskId   VARCHAR(100)  NOT NULL,  -- Graph task GUID
    DueDate         DATE          NULL,      -- event date the task was created for
    Status          VARCHAR(20)   NOT NULL DEFAULT 'active',  -- 'active' | 'resolved'
    CreatedAt       DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    ResolvedAt      DATETIME2     NULL,

    CONSTRAINT UQ_PlannerTasks UNIQUE (EntityType, EntityId, TriggerType, LeadTimeDays)
);

CREATE INDEX IX_PlannerTasks_Entity
    ON dbo.PlannerTasks (EntityType, EntityId, Status);

CREATE INDEX IX_PlannerTasks_ActiveDue
    ON dbo.PlannerTasks (Status, DueDate)
    WHERE Status = 'active';
