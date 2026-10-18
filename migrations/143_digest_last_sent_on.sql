-- Migration 143: AppUsers.DigestLastSentOn (N, the morning digest's same-day guard).
--
-- The digest goes to a person at most once per Darwin day. The timer fires once
-- at 07:30, but a restart inside the 07:00 to 12:00 window can run it again, and
-- a run that dies part-way is replayed; without a record the people already told
-- would be told twice. After each send the timer stamps that person's row with
-- the Darwin calendar date it went on (UTC+9:30, no daylight saving, so the
-- date the person's morning is on, not the UTC date), and a run skips anyone
-- already stamped with today.
--
--   NULL   never emailed a digest (nobody is backfilled; the first run sends).
--   a date the last digest went to this person, by Darwin's calendar. Only a
--          stamp for today suppresses anything; any other day is ignored.
--
-- Nothing else reads this column. It hides no record and merges nothing: it only
-- stops a duplicate email. To send someone's digest again today, clear it:
--   UPDATE dbo.AppUsers SET DigestLastSentOn = NULL WHERE UserID = <id>;
-- (by hand, as the admin; the app never clears it). Staging, where
-- DEV_EMAIL_OVERRIDE is set, neither reads nor writes it.
--
-- Additive and re-runnable: one nullable column behind a column check. No
-- existing value is touched and nothing is dropped.
--
-- RUNBOOK: apply 143 before the build that stamps it. The digest timer reads the
-- column; without it the run fails loudly on an unknown column name.

IF COL_LENGTH('dbo.AppUsers', 'DigestLastSentOn') IS NULL
  ALTER TABLE dbo.AppUsers ADD DigestLastSentOn DATE NULL;
GO
