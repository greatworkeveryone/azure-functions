-- DESTRUCTIVE: normalise role names in dbo.ApprovalLimits · approved by Connor Randazzo 2026-10-13
--
-- Migration 121: approval_limits_normalise (beta sprint J1, LAUNCH-READINESS WP43a-2, JB8)
--
-- Production on 13 Oct 2026 holds: accounts 5000, facilities 5000,
-- accounts_manager 20000, facilities_manager 20000, director NULL, 'Admin' NULL
-- (capital A, so it never matched the admin role) and two legacy
-- timesheet_approval_* rows at 10000 that no code reads by name.
--
-- In one transaction, every step safe to run twice:
--   1. Copy the whole table to dbo.ApprovalLimits_bak_20261014, once. A re-run
--      finds the copy and keeps it: the first copy is the one that matters.
--   2. Remove the two legacy timesheet_approval_* rows, only where the copy
--      holds them. They live on in the copy.
--   3. Trim and lower-case RoleName ('Admin' -> 'admin'), unless the
--      normalised name is already taken (left for a person to resolve; the
--      code normalises on read in any case).
--   4. Admin gets 50000 where its row is NULL (NULL means unlimited) and a
--      50000 row where it has none. A limit someone set deliberately is kept.
--   5. A cfo row (NULL: unlimited below the director threshold) where none exists.
--
-- RUNBOOK (Will, same deploy as the J1 code, never before it):
--   - set DIRECTOR_APPROVAL_THRESHOLD=50000 on the Function App;
--   - this migration seeds admin's $50,000 row; admin approves only records
--     flagged as test data (decision 4), so the row matters on test records only.
-- Applied before the J1 code ships, the old code would read 'admin' at 50000 and
-- derive the director gate from it (moving it from $20,000 to $50,000).
--
-- Undo: the copy holds every row as it stood. Restoring it is a manual,
-- reviewed step, not part of this file.

SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRANSACTION;

  -- 1. Back up first.
  IF OBJECT_ID('dbo.ApprovalLimits_bak_20261014', 'U') IS NULL
  BEGIN
    SELECT RoleName, MaxApprovalAmount, SYSUTCDATETIME() AS BackedUpAt
      INTO dbo.ApprovalLimits_bak_20261014
      FROM dbo.ApprovalLimits;
  END;

  -- 2. Legacy timesheet rows: only those the copy holds.
  DELETE FROM dbo.ApprovalLimits
   WHERE LOWER(LTRIM(RTRIM(RoleName))) IN ('timesheet_approval_accounts', 'timesheet_approval_facilities')
     AND EXISTS (
           SELECT 1 FROM dbo.ApprovalLimits_bak_20261014 AS b
            WHERE b.RoleName = ApprovalLimits.RoleName
         );

  -- 3. Normalised role names. Binary comparison, because the default collation
  --    is case-insensitive and would call 'Admin' and 'admin' equal.
  UPDATE a
     SET RoleName = LOWER(LTRIM(RTRIM(a.RoleName)))
    FROM dbo.ApprovalLimits AS a
   WHERE a.RoleName COLLATE Latin1_General_BIN2 <> LOWER(LTRIM(RTRIM(a.RoleName))) COLLATE Latin1_General_BIN2
     AND NOT EXISTS (
           SELECT 1 FROM dbo.ApprovalLimits AS other
            WHERE other.RoleName COLLATE Latin1_General_BIN2 = LOWER(LTRIM(RTRIM(a.RoleName))) COLLATE Latin1_General_BIN2
         );

  -- 4. Admin at $50,000.
  UPDATE dbo.ApprovalLimits
     SET MaxApprovalAmount = 50000.00
   WHERE RoleName = 'admin'
     AND MaxApprovalAmount IS NULL;

  IF NOT EXISTS (SELECT 1 FROM dbo.ApprovalLimits WHERE RoleName = 'admin')
    INSERT INTO dbo.ApprovalLimits (RoleName, MaxApprovalAmount) VALUES ('admin', 50000.00);

  -- 5. CFO: unlimited below the director threshold.
  IF NOT EXISTS (SELECT 1 FROM dbo.ApprovalLimits WHERE RoleName = 'cfo')
    INSERT INTO dbo.ApprovalLimits (RoleName, MaxApprovalAmount) VALUES ('cfo', NULL);

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
GO
