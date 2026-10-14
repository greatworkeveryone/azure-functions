-- Migration 130: Key handover signatures are kept (sprint U3).
--
-- The check-out form has always asked the person taking a key to sign on
-- screen, and thrown the signature away. It is now uploaded as a PNG into
-- dbo.Attachments (the same table asset and tenancy files use) and linked to
-- the handover it belongs to:
--
--   KeyCheckoutBatches.SignatureAttachmentId   the signature for this handover
--
-- The signature sits on the batch, not on KeyCheckouts: one handover covers
-- N keys and has one signature, and a key's history already reads its batch.
--
-- Purely additive and re-runnable. The column is NULL, so every existing
-- checkout, and any client that never sends a signature, is unaffected.
-- There is no ON DELETE action: an attachment that is a signature cannot be
-- deleted out from under the handover record. The migration runner
-- (src/migrate.ts) splits on the GO lines and runs each batch on its own, so
-- the column is added in one batch and referenced in the next.

IF COL_LENGTH('dbo.KeyCheckoutBatches', 'SignatureAttachmentId') IS NULL
    ALTER TABLE dbo.KeyCheckoutBatches
        ADD SignatureAttachmentId INT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_KeyCheckoutBatches_SignatureAttachment')
    ALTER TABLE dbo.KeyCheckoutBatches
        ADD CONSTRAINT FK_KeyCheckoutBatches_SignatureAttachment
        FOREIGN KEY (SignatureAttachmentId)
        REFERENCES dbo.Attachments(Id);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_KeyCheckoutBatches_SignatureAttachmentId' AND object_id = OBJECT_ID('dbo.KeyCheckoutBatches'))
    CREATE UNIQUE INDEX UX_KeyCheckoutBatches_SignatureAttachmentId
        ON dbo.KeyCheckoutBatches (SignatureAttachmentId)
        WHERE SignatureAttachmentId IS NOT NULL;
GO
