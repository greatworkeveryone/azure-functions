-- Migration 091: unique Emails.MessageID (filtered).
--
-- upsertGraphEmails (src/functions/emails.ts) checks IF NOT EXISTS before
-- INSERT. Concurrent syncs (webhook + manual + backstop queue messages) could
-- both pass the check and store the same message twice. The code now takes
-- UPDLOCK + HOLDLOCK on the check; this index is the hard backstop, and the
-- code treats a unique violation (2601/2627) as "already stored".
--
-- MessageID is NVARCHAR(400) (008) = 800 bytes, inside the 1700-byte
-- nonclustered key limit, so it can be indexed. Filtered on IS NOT NULL
-- because manually ingested rows may have no MessageID.
--
-- Guarded: if duplicates already exist the index is NOT created (it would
-- fail). Find them with:
--   SELECT MessageID, COUNT(*) AS Copies, MIN(EmailID) AS KeepEmailID
--     FROM dbo.Emails
--    WHERE MessageID IS NOT NULL
--    GROUP BY MessageID
--   HAVING COUNT(*) > 1;
-- Resolve them (re-point any Quotes.SourceEmailID / jobs at the kept row
-- first), then re-run this migration.
--
-- Idempotent.

IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_Emails_MessageID' AND object_id = OBJECT_ID('dbo.Emails'))
  PRINT '091: UX_Emails_MessageID already exists — nothing to do.';
ELSE IF EXISTS (
  SELECT 1 FROM dbo.Emails WHERE MessageID IS NOT NULL
   GROUP BY MessageID HAVING COUNT(*) > 1
)
  PRINT '091: SKIPPED — duplicate Emails.MessageID values exist. Find them with the SELECT ... GROUP BY MessageID HAVING COUNT(*) > 1 query in this file''s header, resolve them, then re-run.';
ELSE
  EXEC('CREATE UNIQUE INDEX UX_Emails_MessageID ON dbo.Emails(MessageID) WHERE MessageID IS NOT NULL');
GO
