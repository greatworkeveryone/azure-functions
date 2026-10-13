-- Migration 094: dbo.DecisionLedger — the decision ledger (WP19b, PLAN §3.12, D17).
--
-- One row per decision: who decided (and whom they named, when someone else's
-- authority was relied on), what, on which subject, why, what changed, what the
-- system had computed, and the money at stake. src/ledger record() writes the
-- row inside the decision's own transaction: no ledger row, no decision.
--
-- Tamper-evidence:
--   Preferred: an Azure SQL APPEND-ONLY LEDGER table (LEDGER = ON
--   (APPEND_ONLY = ON)). The database engine refuses any change or removal of a
--   row, for every principal including dbo and the app's service principal, and
--   keeps a hash chain that database digests can verify
--   (sys.sp_generate_database_ledger_digest / sys.sp_verify_database_ledger).
--   Fallback: if the database rejects a ledger table (no support, or the
--   migrating principal lacks the ENABLE LEDGER permission) this migration does
--   NOT fail, because a failing migration stops the whole API. It creates the
--   same table as an ordinary table with an INSTEAD OF trigger that refuses
--   UPDATE and DELETE. THE FALLBACK IS NOT TAMPER-EVIDENT: it blocks accidental
--   or casual changes, but emptying or removing the table, or an administrator,
--   can still alter the data without a trace. Which path was taken is visible
--   with:
--     SELECT name, ledger_type_desc FROM sys.tables WHERE name = 'DecisionLedger';
--   (APPEND_ONLY_LEDGER_TABLE = ledger, NON_LEDGER_TABLE = fallback).
--   If the fallback was taken, also run once, by hand, as a database owner
--   (substitute the app's principal; omitted here because the migration never
--   changes permissions):
--     DENY UPDATE, DELETE ON dbo.DecisionLedger TO [<app principal>];
--   See docs/decision-ledger-fallback.md.
--
-- Additive and re-runnable: everything sits behind IF OBJECT_ID / IF NOT
-- EXISTS, and no existing data is touched. The column list is held in a
-- variable so the two table definitions below cannot drift apart. CREATE
-- TRIGGER must be first in its batch, so it goes through EXEC. The fallback
-- table and its trigger are created in one transaction, so a failure leaves
-- neither behind and the next start tries again.
--
-- Column groups: scope (TenantId, JobId, BuildingId) is denormalised so history
-- filters without joins; the Attributed columns name a second person whose
-- authority the decider relied on (all three NULL when nobody was named, and
-- never the actor); Before, After and Computed hold JSON objects or arrays;
-- FinancialImpact is annualised AUD, positive = money forgone or at risk;
-- IsException is copied from the action registry at write time.

IF OBJECT_ID('dbo.DecisionLedger', 'U') IS NULL
BEGIN
  DECLARE @cols NVARCHAR(MAX) = N'
    LedgerId         BIGINT           IDENTITY(1,1) NOT NULL,
    OccurredAt       DATETIME2(3)     NOT NULL CONSTRAINT DF_DecisionLedger_OccurredAt DEFAULT SYSUTCDATETIME(),
    Action           NVARCHAR(64)     NOT NULL,
    SubjectType      NVARCHAR(32)     NOT NULL,
    SubjectId        NVARCHAR(64)     NOT NULL,
    TenantId         INT              NULL,
    JobId            INT              NULL,
    BuildingId       INT              NULL,
    ActorUserId      INT              NULL,
    ActorName        NVARCHAR(200)    NOT NULL,
    ActorRole        NVARCHAR(32)     NULL,
    ActorKind        NVARCHAR(8)      NOT NULL,
    AttributedUserId INT              NULL,
    AttributedName   NVARCHAR(200)    NULL,
    AttributedRole   NVARCHAR(32)     NULL,
    Reason           NVARCHAR(2000)   NULL,
    [Before]         NVARCHAR(MAX)    NULL,
    [After]          NVARCHAR(MAX)    NULL,
    [Computed]       NVARCHAR(MAX)    NULL,
    FinancialImpact  DECIMAL(14,2)    NULL,
    RuleApplied      NVARCHAR(64)     NULL,
    CorrelationId    UNIQUEIDENTIFIER NOT NULL,
    AppVersion       NVARCHAR(40)     NULL,
    IsException      BIT              NOT NULL,
    CONSTRAINT PK_DecisionLedger PRIMARY KEY CLUSTERED (LedgerId),
    CONSTRAINT CK_DecisionLedger_ActorKind CHECK (ActorKind IN (N''user'', N''system'')),
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
  ';

  BEGIN TRY
    EXEC(N'CREATE TABLE dbo.DecisionLedger (' + @cols + N') WITH (LEDGER = ON (APPEND_ONLY = ON));');
    PRINT N'094: dbo.DecisionLedger created as an append-only ledger table.';
  END TRY
  BEGIN CATCH
    PRINT N'094: ledger table not available (error ' + CAST(ERROR_NUMBER() AS NVARCHAR(10)) + N': ' + ERROR_MESSAGE() + N').';
    -- Re-check: another instance may have created the table in the meantime.
    IF OBJECT_ID('dbo.DecisionLedger', 'U') IS NULL
    BEGIN
      BEGIN TRANSACTION;
      BEGIN TRY
        EXEC(N'CREATE TABLE dbo.DecisionLedger (' + @cols + N');');
        EXEC(N'CREATE TRIGGER dbo.TR_DecisionLedger_AppendOnly ON dbo.DecisionLedger INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''DecisionLedger is append-only'', 1; END;');
        COMMIT TRANSACTION;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
      END CATCH
      PRINT N'094: fallback taken: dbo.DecisionLedger created as an ordinary table with an INSTEAD OF trigger (NOT tamper-evident).';
    END
  END CATCH
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
