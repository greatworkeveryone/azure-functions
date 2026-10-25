-- Migration 090: Emails.AIClaimedAt — exclusive claim lease for the parse runner.
--
-- claimOne (src/functions/parseEmails.ts) commits its claim immediately, so
-- the attempt counter alone cannot stop a second runner (2-min timer, queue
-- trigger, daily retry) claiming the same row while toddler is still parsing
-- it. claimOne stamps AIClaimedAt and skips rows whose stamp is younger than
-- CLAIM_LEASE_SECONDS; every write-back clears it. NULL = not claimed.
--
-- IX_Emails_AIParse_Claim serves the claim's ORDER BY EmailID scan over the
-- unparsed queue, with the two predicate columns in the leaf.
-- IX_Emails_AIParse_Queue (019) is keyed on (AIParseAttempts, CreatedAt) and
-- cannot supply EmailID order.
--
-- Idempotent: both steps are guarded.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Emails') AND name = 'AIClaimedAt')
  ALTER TABLE dbo.Emails ADD AIClaimedAt DATETIME2 NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Emails_AIParse_Claim' AND object_id = OBJECT_ID('dbo.Emails'))
  CREATE INDEX IX_Emails_AIParse_Claim ON dbo.Emails(EmailID)
    INCLUDE (AIParseAttempts, AIClaimedAt)
    WHERE AIParsedAt IS NULL;
GO
