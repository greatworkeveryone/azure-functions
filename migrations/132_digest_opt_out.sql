-- Migration 132: AppUsers.DigestOptOut (N1, the morning digest).
--
-- A person can switch the morning digest email off from the user menu. NULL and
-- 0 both mean they receive it (nobody has to be backfilled); 1 means they have
-- opted out and the digest timer skips them. Nothing else reads this column.
--
-- Additive and re-runnable: one nullable column behind a column check. No
-- existing value is touched and nothing is dropped.

IF COL_LENGTH('dbo.AppUsers', 'DigestOptOut') IS NULL
  ALTER TABLE dbo.AppUsers ADD DigestOptOut BIT NULL;
GO
