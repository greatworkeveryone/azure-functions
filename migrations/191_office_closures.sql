-- 191: office closures (PLAN §15, Connor 31 Oct 2026). Additive and idempotent.
--
--   dbo.OfficeClosures  whole Darwin days the office is shut: public holidays and the Christmas shutdown. A date
--                 range (StartsOn..EndsOn inclusive) with a label. Company-wide, no per-building. Office hours
--                 themselves (Mon-Fri 08:30-16:30 Darwin) stay in code (src/escalation/businessTime.ts).
--                 Rows are archived (ArchivedAt/ArchivedBy), never deleted. RowVersion makes a stale edit a 409.
--                 The business-time engine skips active closures like weekends, and the tenant page tells
--                 tenants when the office is closed and when it reopens.
--
-- SEED: NT public holidays for 2026 and 2027, insert-only (WHEN NOT MATCHED), so running this again never
-- overwrites an edit or brings back an archived row.
--   Source: NT Government, "NT public and regional holidays", https://nt.gov.au/nt-public-holidays
--   (Public Holidays Act 1981). The page blocked automated download from the build session (HTTP 403), so the
--   dates were read through search results quoting that page and the weekday of each was checked by calendar.
--   Included: only holidays that fall on a weekday (weekend ones change nothing).
--   NOT seeded, staff add or confirm in Admin > Company settings:
--     - Christmas Eve and New Year's Eve: part-day (from 7pm), the office is shut by then anyway; not closures.
--     - Anzac Day 2027 (Sunday 25 April): sources disagreed on a substitute Monday, so it is left out.
--     - Regional show days (Darwin Show Day, July): regional holidays, not confirmed from the source; add if the
--       office closes for it.
--     - The Christmas shutdown: staff add it.
--
-- RUNBOOK: apply after 190.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID('dbo.OfficeClosures', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.OfficeClosures (
    ClosureId  INT           IDENTITY(1,1) NOT NULL,
    StartsOn   DATE          NOT NULL,
    EndsOn     DATE          NOT NULL,
    Label      NVARCHAR(100) NOT NULL,
    Kind       NVARCHAR(20)  NOT NULL,
    CreatedAt  DATETIME2     NOT NULL CONSTRAINT DF_OfficeClosures_CreatedAt DEFAULT SYSUTCDATETIME(),
    CreatedBy  NVARCHAR(200) NULL,
    UpdatedAt  DATETIME2     NOT NULL CONSTRAINT DF_OfficeClosures_UpdatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedBy  NVARCHAR(200) NULL,
    ArchivedAt DATETIME2     NULL,
    ArchivedBy NVARCHAR(200) NULL,
    RowVersion ROWVERSION    NOT NULL,
    CONSTRAINT PK_OfficeClosures PRIMARY KEY (ClosureId),
    CONSTRAINT CK_OfficeClosures_Dates CHECK (EndsOn >= StartsOn),
    CONSTRAINT CK_OfficeClosures_Kind CHECK (Kind IN (N'public_holiday', N'shutdown'))
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_OfficeClosures_Live' AND object_id = OBJECT_ID('dbo.OfficeClosures'))
  CREATE INDEX IX_OfficeClosures_Live ON dbo.OfficeClosures (StartsOn, EndsOn) INCLUDE (Label, Kind) WHERE ArchivedAt IS NULL;
GO

MERGE dbo.OfficeClosures AS target
USING (VALUES
  (CAST('2026-01-01' AS DATE), N'New Year''s Day'),
  (CAST('2026-01-26' AS DATE), N'Australia Day'),
  (CAST('2026-04-03' AS DATE), N'Good Friday'),
  (CAST('2026-04-06' AS DATE), N'Easter Monday'),
  (CAST('2026-05-04' AS DATE), N'May Day'),
  (CAST('2026-06-08' AS DATE), N'King''s Birthday'),
  (CAST('2026-08-03' AS DATE), N'Picnic Day'),
  (CAST('2026-12-25' AS DATE), N'Christmas Day'),
  (CAST('2026-12-28' AS DATE), N'Boxing Day (substitute)'),
  (CAST('2027-01-01' AS DATE), N'New Year''s Day'),
  (CAST('2027-01-26' AS DATE), N'Australia Day'),
  (CAST('2027-03-26' AS DATE), N'Good Friday'),
  (CAST('2027-03-29' AS DATE), N'Easter Monday'),
  (CAST('2027-05-03' AS DATE), N'May Day'),
  (CAST('2027-06-14' AS DATE), N'King''s Birthday'),
  (CAST('2027-08-02' AS DATE), N'Picnic Day'),
  (CAST('2027-12-27' AS DATE), N'Christmas Day (substitute)'),
  (CAST('2027-12-28' AS DATE), N'Boxing Day (substitute)')
) AS source (OnDate, Label)
  ON target.StartsOn = source.OnDate AND target.EndsOn = source.OnDate AND target.Kind = N'public_holiday'
WHEN NOT MATCHED BY TARGET THEN
  INSERT (StartsOn, EndsOn, Label, Kind, CreatedBy, UpdatedBy)
  VALUES (source.OnDate, source.OnDate, source.Label, N'public_holiday', N'migration:191_office_closures', N'migration:191_office_closures');
GO
