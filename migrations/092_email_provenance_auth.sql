-- Migration 092: Emails provenance + sender authentication.
--
-- recordEmailQuoteDecision (src/functions/emails.ts) trusts Emails.FromAddress
-- to identify a director. Two holes: ingestEmail lets an operator store any
-- FromAddress, and the From header itself is spoofable. Now:
--   Source               'graph' (upsertGraphEmails) | 'ingest' (ingestEmail).
--                        NULL = row predates this migration (unknown).
--   SenderAuthenticated  1 = DMARC pass aligned with From, or an
--                        Exchange-authenticated internal sender
--                        (src/email/sender-auth.ts). NULL = not assessed.
--   AuthenticationResults  the raw header(s) behind that verdict, ≤ 2000 chars,
--                        for audit and the approval UI.
-- A director decision needs Source = 'graph' AND SenderAuthenticated = 1, so
-- existing rows (NULLs) can't record one — the director approves in-app.
--
-- Run BEFORE deploying the code: getEmails / getEmail select these columns.
--
-- Idempotent: each column is guarded.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Emails') AND name = 'Source')
  ALTER TABLE dbo.Emails ADD Source NVARCHAR(10) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Emails_Source' AND parent_object_id = OBJECT_ID('dbo.Emails'))
  ALTER TABLE dbo.Emails ADD CONSTRAINT CK_Emails_Source CHECK (Source IN ('graph', 'ingest'));
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Emails') AND name = 'SenderAuthenticated')
  ALTER TABLE dbo.Emails ADD SenderAuthenticated BIT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Emails') AND name = 'AuthenticationResults')
  ALTER TABLE dbo.Emails ADD AuthenticationResults NVARCHAR(2000) NULL;
GO
