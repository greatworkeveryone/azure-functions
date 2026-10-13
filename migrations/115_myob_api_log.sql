-- Migration 115: dbo.MyobApiLog — append-only audit log of every MYOB API call.
--
-- Written by src/myob-api-log.ts. Each call leaves a 'request' row (written
-- BEFORE MYOB is called, secrets redacted) and then a 'response' or 'error'
-- row, linked by CorrelationId. Rows are inserted by the app's service
-- principal and are never updated or deleted.
--
-- Tamper-evidence:
--   Preferred: an Azure SQL APPEND-ONLY LEDGER table (LEDGER = ON
--   (APPEND_ONLY = ON)). The database refuses UPDATE and DELETE, and each
--   block is hashed into the database ledger, which ledgerVerifyTimer checks
--   against off-database digests.
--   Fallback: if the database rejects a ledger table, this migration does NOT
--   fail (a failing migration stops the whole API). It creates the same table
--   as an ordinary table with an INSTEAD OF trigger that refuses UPDATE and
--   DELETE. THE FALLBACK IS NOT TAMPER-EVIDENT: it blocks accidental or casual
--   changes, but TRUNCATE, DROP or an administrator can still alter the data
--   without a trace. Which path was taken is visible with:
--     SELECT name, ledger_type_desc FROM sys.tables WHERE name = 'MyobApiLog';
--   (APPEND_ONLY_LEDGER_TABLE = ledger, NON_LEDGER_TABLE = fallback).
--   If the fallback was taken, also run once, by hand, as a database owner
--   (substitute the app's principal; omitted here because the migration never
--   changes permissions):
--     DENY UPDATE, DELETE ON dbo.MyobApiLog TO [<app principal>];
--
-- Additive and re-runnable: everything sits behind IF OBJECT_ID / IF NOT
-- EXISTS, and no existing data is touched. The column list is held in a
-- variable so the three CREATE TABLE attempts below cannot drift apart.
-- CREATE TRIGGER must be first in its batch, so it goes through EXEC.

IF OBJECT_ID('dbo.MyobApiLog', 'U') IS NULL
BEGIN
  DECLARE @cols NVARCHAR(MAX) = N'
    LogId          BIGINT         IDENTITY(1,1) NOT NULL CONSTRAINT PK_MyobApiLog PRIMARY KEY,
    OccurredAt     DATETIME2      NOT NULL CONSTRAINT DF_MyobApiLog_OccurredAt DEFAULT SYSUTCDATETIME(),
    CorrelationId  UNIQUEIDENTIFIER NOT NULL,
    Phase          NVARCHAR(10)   NOT NULL CONSTRAINT CK_MyobApiLog_Phase CHECK (Phase IN (''request'', ''response'', ''error'')),
    Method         NVARCHAR(10)   NOT NULL,
    Path           NVARCHAR(500)  NOT NULL,
    Purpose        NVARCHAR(100)  NOT NULL,
    ActorKind      NVARCHAR(10)   NOT NULL CONSTRAINT CK_MyobApiLog_ActorKind CHECK (ActorKind IN (''user'', ''system'')),
    ActorName      NVARCHAR(200)  NOT NULL,
    ActorRole      NVARCHAR(50)   NULL,
    ActorOid       NVARCHAR(100)  NULL,
    RequestBody    NVARCHAR(MAX)  NULL,
    HttpStatus     INT            NULL,
    ResponseBody   NVARCHAR(MAX)  NULL,
    MyobUid        NVARCHAR(100)  NULL,
    DurationMs     INT            NULL,
    ErrorMessage   NVARCHAR(2000) NULL,
    Attempt        INT            NOT NULL CONSTRAINT DF_MyobApiLog_Attempt DEFAULT 1,
    AppVersion     NVARCHAR(50)   NULL';

  BEGIN TRY
    EXEC(N'CREATE TABLE dbo.MyobApiLog (' + @cols + N') WITH (SYSTEM_VERSIONING = OFF, LEDGER = ON (APPEND_ONLY = ON));');
  END TRY
  BEGIN CATCH
    BEGIN TRY
      -- Same table with only the documented append-only clause, in case the
      -- extra SYSTEM_VERSIONING option is what was rejected.
      EXEC(N'CREATE TABLE dbo.MyobApiLog (' + @cols + N') WITH (LEDGER = ON (APPEND_ONLY = ON));');
    END TRY
    BEGIN CATCH
      -- No ledger tables here: ordinary table plus a trigger that refuses changes.
      -- Table and trigger commit together (same as 094): a table that
      -- survived without its trigger would be skipped by every later start
      -- and stay editable for good.
      IF OBJECT_ID('dbo.MyobApiLog', 'U') IS NULL
      BEGIN
        BEGIN TRANSACTION;
        BEGIN TRY
          EXEC(N'CREATE TABLE dbo.MyobApiLog (' + @cols + N');');
          EXEC(N'CREATE TRIGGER dbo.TR_MyobApiLog_AppendOnly ON dbo.MyobApiLog INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''MyobApiLog is append-only'', 1; END;');
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

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_MyobApiLog_OccurredAt'
     AND object_id = OBJECT_ID('dbo.MyobApiLog')
)
  CREATE INDEX IX_MyobApiLog_OccurredAt ON dbo.MyobApiLog(OccurredAt);
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_MyobApiLog_CorrelationId'
     AND object_id = OBJECT_ID('dbo.MyobApiLog')
)
  CREATE INDEX IX_MyobApiLog_CorrelationId ON dbo.MyobApiLog(CorrelationId);
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_MyobApiLog_ActorName_OccurredAt'
     AND object_id = OBJECT_ID('dbo.MyobApiLog')
)
  CREATE INDEX IX_MyobApiLog_ActorName_OccurredAt ON dbo.MyobApiLog(ActorName, OccurredAt);
GO
