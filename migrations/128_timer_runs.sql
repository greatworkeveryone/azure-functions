-- 128_timer_runs — one row per timer invocation (DL-12, beta sprint D3).
--
-- Written by src/timerRuns.ts: runTimer inserts a 'running' row when a timer
-- starts and sets FinishedAt, Outcome ('ok' / 'error'), Error and Counts (JSON
-- the timer returns, e.g. {"scanned":3,"deleted":3,"failed":0}) when it ends.
-- A row left at 'running' means the worker died mid-run. /api/health?deep=true
-- shows the last row per timer.
--
-- Additive and re-runnable: the table and index are created only when missing.
-- Nothing here deletes; pruning old rows, if ever needed, is its own reviewed
-- migration or job (database-safety rule 2).

IF OBJECT_ID(N'dbo.TimerRuns', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TimerRuns (
    TimerRunId  INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TimerRuns PRIMARY KEY,
    Name        NVARCHAR(100)  NOT NULL,
    StartedAt   DATETIME2(3)   NOT NULL,
    FinishedAt  DATETIME2(3)   NULL,
    Outcome     NVARCHAR(20)   NOT NULL CONSTRAINT DF_TimerRuns_Outcome DEFAULT N'running',
    Error       NVARCHAR(4000) NULL,
    Counts      NVARCHAR(4000) NULL,
    CONSTRAINT CK_TimerRuns_Outcome CHECK (Outcome IN (N'running', N'ok', N'error'))
  );
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
   WHERE name = N'IX_TimerRuns_Name_StartedAt' AND object_id = OBJECT_ID(N'dbo.TimerRuns')
)
  CREATE INDEX IX_TimerRuns_Name_StartedAt
    ON dbo.TimerRuns (Name, StartedAt DESC)
    INCLUDE (FinishedAt, Outcome);
