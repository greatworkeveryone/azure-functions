-- Migration 094: dbo.DecisionLedger — the tamper-evident decision ledger
-- (WP19b, PLAN §3.12, D17).
--
-- One row per decision: who decided (and whom they named, when someone else's
-- authority was relied on), what, on which subject, why, what changed, what the
-- system had computed, and the money at stake. src/ledger record() writes the
-- row inside the decision's own transaction: no ledger row, no decision.
--
-- LEDGER = ON (APPEND_ONLY = ON): the database engine itself refuses to change
-- or remove a row, for every principal including dbo and the app's service
-- principal, and keeps a hash chain that database digests can verify
-- (sys.sp_generate_database_ledger_digest / sys.sp_verify_database_ledger).
--
-- Purely additive and safe to run twice: the table and each index are created
-- only when missing. If this database refuses ledger tables, the documented
-- fallback is in docs/decision-ledger-fallback.md.

IF OBJECT_ID('dbo.DecisionLedger') IS NULL
BEGIN
  CREATE TABLE dbo.DecisionLedger (
    LedgerId         BIGINT           IDENTITY(1,1) NOT NULL,
    OccurredAt       DATETIME2(3)     NOT NULL
      CONSTRAINT DF_DecisionLedger_OccurredAt DEFAULT SYSUTCDATETIME(),   -- UTC
    Action           NVARCHAR(64)     NOT NULL,   -- registry code, e.g. quote.approve
    SubjectType      NVARCHAR(32)     NOT NULL,
    SubjectId        NVARCHAR(64)     NOT NULL,

    -- Denormalised scope so history filters without joins.
    TenantId         INT              NULL,
    JobId            INT              NULL,
    BuildingId       INT              NULL,

    -- Who decided. System actors are named by their function.
    ActorUserId      INT              NULL,
    ActorName        NVARCHAR(200)    NOT NULL,
    ActorRole        NVARCHAR(32)     NULL,
    ActorKind        NVARCHAR(8)      NOT NULL,

    -- Whose authority the decider relied on, when they named someone (a quote
    -- approved up to the decider's own limit after talking to a manager).
    -- All three are NULL when nobody was named.
    AttributedUserId INT              NULL,
    AttributedName   NVARCHAR(200)    NULL,
    AttributedRole   NVARCHAR(32)     NULL,

    Reason           NVARCHAR(2000)   NULL,
    [Before]         NVARCHAR(MAX)    NULL,       -- JSON snapshots
    [After]          NVARCHAR(MAX)    NULL,
    [Computed]       NVARCHAR(MAX)    NULL,       -- what the system computed when a person chose otherwise
    FinancialImpact  DECIMAL(14,2)    NULL,       -- annualised AUD; positive = money forgone or at risk
    RuleApplied      NVARCHAR(64)     NULL,
    CorrelationId    UNIQUEIDENTIFIER NOT NULL,   -- shared by every row of one operation
    AppVersion       NVARCHAR(40)     NULL,
    IsException      BIT              NOT NULL,   -- copied from the action registry at write time

    CONSTRAINT PK_DecisionLedger PRIMARY KEY CLUSTERED (LedgerId),
    CONSTRAINT CK_DecisionLedger_ActorKind CHECK (ActorKind IN (N'user', N'system')),
    CONSTRAINT CK_DecisionLedger_Attribution CHECK (
      (AttributedName IS NULL AND AttributedRole IS NULL AND AttributedUserId IS NULL)
      OR (AttributedName IS NOT NULL AND AttributedRole IS NOT NULL)
    ),
    CONSTRAINT CK_DecisionLedger_AttributionNotActor CHECK (
      AttributedUserId IS NULL OR ActorUserId IS NULL OR AttributedUserId <> ActorUserId
    ),
    CONSTRAINT CK_DecisionLedger_BeforeJson   CHECK ([Before]   IS NULL OR ISJSON([Before])   = 1),
    CONSTRAINT CK_DecisionLedger_AfterJson    CHECK ([After]    IS NULL OR ISJSON([After])    = 1),
    CONSTRAINT CK_DecisionLedger_ComputedJson CHECK ([Computed] IS NULL OR ISJSON([Computed]) = 1)
  ) WITH (LEDGER = ON (APPEND_ONLY = ON));
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DecisionLedger_Subject' AND object_id = OBJECT_ID('dbo.DecisionLedger'))
  CREATE INDEX IX_DecisionLedger_Subject ON dbo.DecisionLedger (SubjectType, SubjectId, OccurredAt);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DecisionLedger_Tenant' AND object_id = OBJECT_ID('dbo.DecisionLedger'))
  CREATE INDEX IX_DecisionLedger_Tenant ON dbo.DecisionLedger (TenantId, OccurredAt);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DecisionLedger_Actor' AND object_id = OBJECT_ID('dbo.DecisionLedger'))
  CREATE INDEX IX_DecisionLedger_Actor ON dbo.DecisionLedger (ActorUserId, OccurredAt);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DecisionLedger_Action' AND object_id = OBJECT_ID('dbo.DecisionLedger'))
  CREATE INDEX IX_DecisionLedger_Action ON dbo.DecisionLedger (Action, OccurredAt);
GO

-- Beyond the four indexes in PLAN §3.12: the job history reads
-- (SubjectType = 'job' AND SubjectId = n) OR JobId = n, and /decisions filters
-- by building, so both scope columns get a seek path too.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DecisionLedger_Job' AND object_id = OBJECT_ID('dbo.DecisionLedger'))
  CREATE INDEX IX_DecisionLedger_Job ON dbo.DecisionLedger (JobId, OccurredAt);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DecisionLedger_Building' AND object_id = OBJECT_ID('dbo.DecisionLedger'))
  CREATE INDEX IX_DecisionLedger_Building ON dbo.DecisionLedger (BuildingId, OccurredAt);
GO
