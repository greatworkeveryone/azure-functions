-- Migration 177: cover while away, semi-automatic (PLAN §13, package AW1).
--
-- Two tables and one escalation policy. Nothing existing is touched.
--
--   dbo.CoverDelegates  "who covers for me": the person who will be away, the
--                       colleague who covers, and the dates. Optionally tied to
--                       the leave request it was nominated for. Set by the person
--                       (leave booking, Settings) or by their manager. A row is
--                       ended, never deleted: ArchivedAt / ArchivedBy / ArchivedReason.
--   dbo.CoverActions    the ledger of the cover engine, append-only. One row each
--                       time an item of someone's outstanding work is moved to a
--                       cover (reassigned), pushed up the ladder (escalated),
--                       listed for a manager (suggested), left where it is on a
--                       manager's say-so (kept) or taken back by the person on
--                       return (taken_back). Item type and id, from and to, the
--                       reason in a code and in words, the absence, the due date,
--                       the importance, the run, and who acted (the system or a
--                       person). A row is written in the same transaction as the
--                       change it records, so the move and its ledger row stand
--                       or fall together. Nothing is ever approved here: a move
--                       only changes who has the item.
--   cover.moved         the in-app notice policy (attention, the one person told,
--                       no automatic escalation). Seeded with MERGE ... WHEN NOT
--                       MATCHED THEN INSERT only, so an admin's edit survives.
--
-- ItemType values: job, decision_request, escalation, approval, email, leave_approval.
-- ItemId is text so each type keeps its own key (a job id, a request id, an
-- escalation id, a quote id, an email id, a leave request id).
-- AbsenceRef names the absence a row belongs to ("leave:123" or "inactive:2026-10-24"):
-- a manager's "keep" holds for that absence only.
--
-- Tamper-evidence as dbo.AiCallLog (170), DecisionLedger (094) and MyobApiLog (115):
-- an Azure SQL append-only ledger table where the database has them, else an
-- ordinary table with an INSTEAD OF trigger that refuses UPDATE and DELETE.
-- THE FALLBACK IS NOT TAMPER-EVIDENT: it stops casual changes, but TRUNCATE, DROP or
-- an administrator can still alter the data. Which path was taken:
--   SELECT name, ledger_type_desc FROM sys.tables WHERE name = 'CoverActions';
-- If the fallback was taken, also run once, by hand, as a database owner:
--   DENY UPDATE, DELETE ON dbo.CoverActions TO [<app principal>];
-- src/__tests__/absence-cover-append-only.test.ts keeps source files from asking
-- for an UPDATE or DELETE at all.
--
-- Additive and re-runnable: everything sits behind IF OBJECT_ID / IF NOT EXISTS, the
-- new columns are nullable or defaulted, nothing is dropped, deleted or rewritten.
-- CREATE TRIGGER must be first in its batch, so it goes through EXEC.
--
-- RUNBOOK: apply 177 before turning on the absenceCover flag or any ABSENCE_COVER_*
-- switch. Dry-run it on a restored copy of production first (database-safety rules,
-- section 4). Number 177 is reserved for AW1. Never renumber.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID('dbo.CoverDelegates', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.CoverDelegates (
    CoverDelegateId  INT           IDENTITY(1,1) NOT NULL,
    UserId           INT           NOT NULL,
    DelegateUserId   INT           NOT NULL,
    FromDate         DATE          NOT NULL,
    ToDate           DATE          NOT NULL,
    LeaveRequestId   INT           NULL,
    CreatedBy        NVARCHAR(200) NOT NULL,
    CreatedByUserId  INT           NULL,
    CreatedAt        DATETIME2(3)  NOT NULL CONSTRAINT DF_CoverDelegates_CreatedAt DEFAULT SYSUTCDATETIME(),
    ArchivedAt       DATETIME2(3)  NULL,
    ArchivedBy       NVARCHAR(200) NULL,
    ArchivedByUserId INT           NULL,
    ArchivedReason   NVARCHAR(200) NULL,
    RowVersion       ROWVERSION    NOT NULL,
    CONSTRAINT PK_CoverDelegates PRIMARY KEY CLUSTERED (CoverDelegateId),
    CONSTRAINT FK_CoverDelegates_User FOREIGN KEY (UserId) REFERENCES dbo.AppUsers(UserID),
    CONSTRAINT FK_CoverDelegates_Delegate FOREIGN KEY (DelegateUserId) REFERENCES dbo.AppUsers(UserID),
    CONSTRAINT FK_CoverDelegates_Leave FOREIGN KEY (LeaveRequestId) REFERENCES dbo.LeaveRequests(RequestId),
    CONSTRAINT CK_CoverDelegates_Dates CHECK (ToDate >= FromDate),
    CONSTRAINT CK_CoverDelegates_NotSelf CHECK (DelegateUserId <> UserId),
    CONSTRAINT CK_CoverDelegates_Archived CHECK (
      (ArchivedAt IS NULL AND ArchivedBy IS NULL) OR (ArchivedAt IS NOT NULL AND ArchivedBy IS NOT NULL)
    )
  );
END
GO

-- Who covers for a person today: live rows by person and dates.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CoverDelegates_User' AND object_id = OBJECT_ID('dbo.CoverDelegates'))
  CREATE INDEX IX_CoverDelegates_User ON dbo.CoverDelegates (UserId, FromDate, ToDate) WHERE ArchivedAt IS NULL;
GO

-- Whose cover a person is (the handback summary, the "covering" list).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CoverDelegates_Delegate' AND object_id = OBJECT_ID('dbo.CoverDelegates'))
  CREATE INDEX IX_CoverDelegates_Delegate ON dbo.CoverDelegates (DelegateUserId, FromDate, ToDate) WHERE ArchivedAt IS NULL;
GO

IF OBJECT_ID('dbo.CoverActions', 'U') IS NULL
BEGIN
  DECLARE @cols NVARCHAR(MAX) = N'
    CoverActionId    BIGINT           IDENTITY(1,1) NOT NULL CONSTRAINT PK_CoverActions PRIMARY KEY,
    CreatedAt        DATETIME2(3)     NOT NULL CONSTRAINT DF_CoverActions_CreatedAt DEFAULT SYSUTCDATETIME(),
    ItemType         NVARCHAR(24)     NOT NULL CONSTRAINT CK_CoverActions_ItemType CHECK (ItemType IN (
                       ''job'', ''decision_request'', ''escalation'', ''approval'', ''email'', ''leave_approval'')),
    ItemId           NVARCHAR(40)     NOT NULL,
    ItemLabel        NVARCHAR(300)    NOT NULL,
    FromUserId       INT              NOT NULL,
    ToUserId         INT              NULL,
    Action           NVARCHAR(12)     NOT NULL CONSTRAINT CK_CoverActions_Action CHECK (Action IN (
                       ''reassigned'', ''escalated'', ''suggested'', ''kept'', ''taken_back'')),
    ReasonCode       NVARCHAR(40)     NOT NULL,
    ReasonText       NVARCHAR(500)    NOT NULL,
    AbsenceKind      NVARCHAR(12)     NOT NULL CONSTRAINT CK_CoverActions_AbsenceKind CHECK (AbsenceKind IN (
                       ''planned'', ''unplanned'', ''inactive'')),
    AbsenceRef       NVARCHAR(60)     NOT NULL,
    ReturnDate       DATE             NULL,
    DueAt            DATETIME2(3)     NULL,
    Importance       NVARCHAR(6)      NOT NULL CONSTRAINT CK_CoverActions_Importance CHECK (Importance IN (
                       ''high'', ''medium'', ''low'')),
    RunId            UNIQUEIDENTIFIER NULL,
    ActorKind        NVARCHAR(8)      NOT NULL CONSTRAINT CK_CoverActions_ActorKind CHECK (ActorKind IN (''system'', ''user'')),
    ActorUserId      INT              NULL,
    ActorName        NVARCHAR(200)    NOT NULL,
    DryRun           BIT              NOT NULL CONSTRAINT DF_CoverActions_DryRun DEFAULT 0,
    RelatedActionId  BIGINT           NULL';

  BEGIN TRY
    EXEC(N'CREATE TABLE dbo.CoverActions (' + @cols + N') WITH (SYSTEM_VERSIONING = OFF, LEDGER = ON (APPEND_ONLY = ON));');
  END TRY
  BEGIN CATCH
    BEGIN TRY
      EXEC(N'CREATE TABLE dbo.CoverActions (' + @cols + N') WITH (LEDGER = ON (APPEND_ONLY = ON));');
    END TRY
    BEGIN CATCH
      -- Table and trigger commit together: a table that survived without its
      -- trigger would be skipped by every later run and stay editable.
      IF OBJECT_ID('dbo.CoverActions', 'U') IS NULL
      BEGIN
        BEGIN TRANSACTION;
        BEGIN TRY
          EXEC(N'CREATE TABLE dbo.CoverActions (' + @cols + N');');
          EXEC(N'CREATE TRIGGER dbo.TR_CoverActions_AppendOnly ON dbo.CoverActions INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''CoverActions is append-only'', 1; END;');
          COMMIT TRANSACTION;
        END TRY
        BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
          THROW;
        END CATCH
      END
    END CATCH
  END CATCH
END
GO

-- The latest word on an item (idempotency: already covered, already suggested, kept).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CoverActions_Item' AND object_id = OBJECT_ID('dbo.CoverActions'))
  CREATE INDEX IX_CoverActions_Item ON dbo.CoverActions (ItemType, ItemId, CoverActionId);
GO

-- The manager's list and the handback summary.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CoverActions_From' AND object_id = OBJECT_ID('dbo.CoverActions'))
  CREATE INDEX IX_CoverActions_From ON dbo.CoverActions (FromUserId, CoverActionId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CoverActions_To' AND object_id = OBJECT_ID('dbo.CoverActions'))
  CREATE INDEX IX_CoverActions_To ON dbo.CoverActions (ToUserId, CoverActionId);
GO

-- The in-app notice to a cover. Attention, one named person, no moving up: it ends
-- when they resolve it in For you, or when the move is taken back.
;WITH Seed (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active) AS (
  SELECT * FROM (VALUES
    (N'cover.moved', N'attention', 0, N'business', N'no', N'[{"userTarget":true}]', 1)
  ) AS v (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active)
)
MERGE dbo.EscalationPolicies AS target
USING Seed AS source
  ON target.PolicyKey = source.PolicyKey
WHEN NOT MATCHED BY TARGET THEN
  INSERT (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active, UpdatedBy)
  VALUES (source.PolicyKey, source.Kind, source.Urgent, source.Clock, source.AutoReescalate, source.Ladder, source.Active, N'migration:177_absence_cover');
GO
