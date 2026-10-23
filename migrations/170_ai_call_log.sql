-- Migration 170: dbo.AiCallLog — append-only log of every call to the AI gateway (SC-AI1).
--
-- Written by src/ai/callLog.ts, one row per call to runAi (src/ai/runAi.ts),
-- refusals included: a call switched off, not allowed, too long, rate limited, timed
-- out, failed or answered all leave a row. Read by listAiCalls (Admin → AI activity,
-- admin and director). Rows are inserted by the app's service principal and are never
-- updated or deleted; src/__tests__/ai-call-log-guards.test.ts holds the line on that.
--
-- What a row holds:
--   Actor*        who the call was made for, as the decision ledger names an actor
--                 (ActorUserId = AppUsers.UserID, ActorName, ActorRole, ActorKind), plus ActorEmail.
--   Purpose       the allowlisted purpose id (src/ai/purposes); a refused call keeps the id it asked for.
--   PromptVersion the purpose's versioned prompt, e.g. echo_test@1; 'unknown' when the purpose was not allowed.
--   Provider      AI_PROVIDER as configured (mock, openai_compatible); Model is NULL when nothing was sent.
--   InputChars    length of the input as given. RedactionCount is how many personal details were found in it
--                 (counted whether or not the call went on). InputSha256 is the SHA-256 of the input AFTER
--                 redaction (of its first 100,000 characters at most): it ties a row to a document without
--                 keeping the text, and it is never derived from the raw input.
--   Outcome       ok (answered), refused (declined before anything was sent) or failed (the provider was
--                 called, or should have been, and gave no usable answer). ErrorCode is the typed refusal
--                 (disabled, purpose_not_allowed, input_too_large, rate_limited, timeout, provider_error,
--                 invalid_output) and is NULL exactly when Outcome is ok.
--   InputText and OutputText are NULL unless AI_LOG_CONTENT is "true", and then hold the REDACTED text.
--                 The table is append-only, so text stored here can never be removed: leave the switch off
--                 except while diagnosing, and treat what it stores as permanent.
--
-- Tamper-evidence, as dbo.DecisionLedger (094) and dbo.MyobApiLog (115):
--   Preferred: an Azure SQL APPEND-ONLY LEDGER table (LEDGER = ON (APPEND_ONLY = ON)). The database
--   refuses UPDATE and DELETE for every principal, and each block is hashed into the database ledger.
--   Fallback: if the database rejects a ledger table, this migration does NOT fail (a failing migration
--   stops the whole API). It creates the same table as an ordinary table with an INSTEAD OF trigger that
--   refuses UPDATE and DELETE. THE FALLBACK IS NOT TAMPER-EVIDENT: it blocks accidental or casual changes,
--   but TRUNCATE, DROP or an administrator can still alter the data without a trace. Which path was taken:
--     SELECT name, ledger_type_desc FROM sys.tables WHERE name = 'AiCallLog';
--   (APPEND_ONLY_LEDGER_TABLE = ledger, NON_LEDGER_TABLE = fallback). If the fallback was taken, also run
--   once, by hand, as a database owner (the migration never changes permissions):
--     DENY UPDATE, DELETE ON dbo.AiCallLog TO [<app principal>];
--   See docs/decision-ledger-fallback.md: the same mechanism.
--
-- Additive and re-runnable: everything sits behind IF OBJECT_ID / IF NOT EXISTS, and no existing data is
-- touched. The column list is held in a variable so the three CREATE TABLE attempts below cannot drift
-- apart. CREATE TRIGGER must be first in its batch, so it goes through EXEC.
--
-- RUNBOOK: apply 170 before the build that serves listAiCalls or runAiHealthCheck (getAiStatus needs no
-- table). Dry-run it on a restored copy of production first (database-safety rules, section 4).

IF OBJECT_ID('dbo.AiCallLog', 'U') IS NULL
BEGIN
  DECLARE @cols NVARCHAR(MAX) = N'
    Id             BIGINT           IDENTITY(1,1) NOT NULL CONSTRAINT PK_AiCallLog PRIMARY KEY,
    CreatedAt      DATETIME2(3)     NOT NULL CONSTRAINT DF_AiCallLog_CreatedAt DEFAULT SYSUTCDATETIME(),
    ActorKind      NVARCHAR(10)     NOT NULL CONSTRAINT CK_AiCallLog_ActorKind CHECK (ActorKind IN (''user'', ''system'')),
    ActorUserId    INT              NULL,
    ActorEmail     NVARCHAR(320)    NULL,
    ActorName      NVARCHAR(200)    NOT NULL,
    ActorRole      NVARCHAR(32)     NULL,
    Purpose        NVARCHAR(64)     NOT NULL,
    PromptVersion  NVARCHAR(80)     NOT NULL,
    Provider       NVARCHAR(40)     NOT NULL,
    Model          NVARCHAR(200)    NULL,
    InputChars     INT              NOT NULL,
    OutputChars    INT              NULL,
    RedactionCount INT              NOT NULL CONSTRAINT DF_AiCallLog_RedactionCount DEFAULT 0,
    LatencyMs      INT              NULL,
    Outcome        NVARCHAR(10)     NOT NULL CONSTRAINT CK_AiCallLog_Outcome CHECK (Outcome IN (''ok'', ''refused'', ''failed'')),
    ErrorCode      NVARCHAR(40)     NULL,
    RecordType     NVARCHAR(40)     NULL,
    RecordId       NVARCHAR(64)     NULL,
    CorrelationId  UNIQUEIDENTIFIER NULL,
    InputSha256    CHAR(64)         NOT NULL,
    InputText      NVARCHAR(MAX)    NULL,
    OutputText     NVARCHAR(MAX)    NULL,
    CONSTRAINT CK_AiCallLog_OutcomeCode CHECK (
      (Outcome = ''ok'' AND ErrorCode IS NULL) OR (Outcome <> ''ok'' AND ErrorCode IS NOT NULL)
    )';

  BEGIN TRY
    EXEC(N'CREATE TABLE dbo.AiCallLog (' + @cols + N') WITH (SYSTEM_VERSIONING = OFF, LEDGER = ON (APPEND_ONLY = ON));');
  END TRY
  BEGIN CATCH
    BEGIN TRY
      -- Same table with only the documented append-only clause, in case the
      -- extra SYSTEM_VERSIONING option is what was rejected.
      EXEC(N'CREATE TABLE dbo.AiCallLog (' + @cols + N') WITH (LEDGER = ON (APPEND_ONLY = ON));');
    END TRY
    BEGIN CATCH
      -- No ledger tables here: ordinary table plus a trigger that refuses changes.
      -- Table and trigger commit together (as 094 and 115): a table that survived
      -- without its trigger would be skipped by every later run and stay editable.
      IF OBJECT_ID('dbo.AiCallLog', 'U') IS NULL
      BEGIN
        BEGIN TRANSACTION;
        BEGIN TRY
          EXEC(N'CREATE TABLE dbo.AiCallLog (' + @cols + N');');
          EXEC(N'CREATE TRIGGER dbo.TR_AiCallLog_AppendOnly ON dbo.AiCallLog INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''AiCallLog is append-only'', 1; END;');
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
   WHERE name = 'IX_AiCallLog_CreatedAt'
     AND object_id = OBJECT_ID('dbo.AiCallLog')
)
  CREATE INDEX IX_AiCallLog_CreatedAt ON dbo.AiCallLog(CreatedAt);
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = 'IX_AiCallLog_Purpose'
     AND object_id = OBJECT_ID('dbo.AiCallLog')
)
  CREATE INDEX IX_AiCallLog_Purpose ON dbo.AiCallLog(Purpose, CreatedAt);
GO
