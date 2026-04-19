-- Jobs + JobEvents — the overarching "project" track that sits above WRs.
-- Unlike WorkRequests, jobs are local-authoritative (no myBuildings sync),
-- so there is no overlay/overrides table and no LastSyncedAt.
--
-- Jobs.Status is the canonical blocker state (Awaiting Approval, Parts, Tenant,
-- Work, Quote, Done, New). JobEvents is the unified activity feed — comments,
-- status changes, and expected-date bumps all live here. When an event sets
-- NewStatus or ExpectedProgressDate, the corresponding Jobs column is also
-- updated so list views don't need to read the full event log.

CREATE TABLE dbo.Jobs (
    JobID                   INT            IDENTITY(1,1) PRIMARY KEY,
    BuildingID              INT            NOT NULL,
    WorkRequestID           INT            NULL,
    Title                   NVARCHAR(400)  NOT NULL,
    Description             NVARCHAR(MAX)  NULL,
    AssignedTo              NVARCHAR(200)  NULL,
    Status                  NVARCHAR(100)  NOT NULL,
    IsStalled               BIT            NOT NULL CONSTRAINT DF_Jobs_IsStalled DEFAULT 0,
    ExpectedProgressUpdate  DATETIME2      NULL,
    CompletionDate          DATETIME2      NULL,
    CreatedAt               DATETIME2      NOT NULL CONSTRAINT DF_Jobs_CreatedAt DEFAULT SYSUTCDATETIME(),
    CreatedBy               NVARCHAR(200)  NULL,
    LastModifiedDate        DATETIME2      NOT NULL CONSTRAINT DF_Jobs_LastModifiedDate DEFAULT SYSUTCDATETIME()
);

CREATE INDEX IX_Jobs_BuildingID     ON dbo.Jobs(BuildingID);
CREATE INDEX IX_Jobs_WorkRequestID  ON dbo.Jobs(WorkRequestID);
CREATE INDEX IX_Jobs_Status         ON dbo.Jobs(Status);

-- Activity feed. Any event can carry any combination of:
--   Text                  — a free-text comment
--   NewStatus             — a status change (also updates Jobs.Status)
--   ExpectedProgressDate  — a new target date (also updates Jobs.ExpectedProgressUpdate)
-- Pure status changes have Text=NULL; pure comments have NewStatus=NULL.

CREATE TABLE dbo.JobEvents (
    JobEventID              INT            IDENTITY(1,1) PRIMARY KEY,
    JobID                   INT            NOT NULL,
    CreatedAt               DATETIME2      NOT NULL CONSTRAINT DF_JobEvents_CreatedAt DEFAULT SYSUTCDATETIME(),
    CreatedBy               NVARCHAR(200)  NULL,
    [Text]                  NVARCHAR(MAX)  NULL,
    NewStatus               NVARCHAR(100)  NULL,
    ExpectedProgressDate    DATETIME2      NULL,
    CONSTRAINT FK_JobEvents_Jobs FOREIGN KEY (JobID)
        REFERENCES dbo.Jobs(JobID) ON DELETE CASCADE
);

CREATE INDEX IX_JobEvents_JobID ON dbo.JobEvents(JobID);
