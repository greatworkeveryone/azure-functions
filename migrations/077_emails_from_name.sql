-- Migration 077: Emails — capture sender display name from Graph.
-- The Incoming triage list now leads with the sender's name (e.g. "Dave
-- Nguyen") and falls back to the raw address when name is null. Backfill
-- is not required: rows without a name simply fall back at render time
-- and self-heal as new mail arrives via the Graph sync.

ALTER TABLE dbo.Emails ADD
    FromName NVARCHAR(255) NULL;
GO

