-- Migration 142: asking a director to approve a procedure (beta sprint U4).
--
-- A manager writes a procedure draft; only a director publishes it. Until now
-- the manager had to tell the director by some other means. These four columns
-- record the request on the draft itself, so the library can say "Awaiting
-- approval by Dee" and the director's email has something to point at:
--
--   ProcedureVersions.ApprovalRequestedAt          when it was asked (UTC); NULL = not asked
--   ProcedureVersions.ApprovalRequestedBy          who asked, by name
--   ProcedureVersions.ApprovalRequestedFromUserId  the director asked (AppUsers.UserID)
--   ProcedureVersions.ApprovalRequestedFromName    their name, so the line reads if they are renamed
--
-- Editing the draft clears all four: an approval must not survive an edit, and
-- neither should the request for one. Publishing leaves them on the version.
--
-- Purely additive and re-runnable: every ADD COLUMN is guarded and NULL, so every
-- existing version reads as not asked. Nothing is dropped, deleted, altered or
-- rewritten. The migration runner (src/migrate.ts) splits on the GO lines and
-- runs each batch on its own.

IF COL_LENGTH('dbo.ProcedureVersions', 'ApprovalRequestedAt') IS NULL
    ALTER TABLE dbo.ProcedureVersions ADD ApprovalRequestedAt DATETIME2(0) NULL;
GO

IF COL_LENGTH('dbo.ProcedureVersions', 'ApprovalRequestedBy') IS NULL
    ALTER TABLE dbo.ProcedureVersions ADD ApprovalRequestedBy NVARCHAR(256) NULL;
GO

IF COL_LENGTH('dbo.ProcedureVersions', 'ApprovalRequestedFromUserId') IS NULL
    ALTER TABLE dbo.ProcedureVersions ADD ApprovalRequestedFromUserId INT NULL;
GO

IF COL_LENGTH('dbo.ProcedureVersions', 'ApprovalRequestedFromName') IS NULL
    ALTER TABLE dbo.ProcedureVersions ADD ApprovalRequestedFromName NVARCHAR(256) NULL;
GO
