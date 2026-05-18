-- m056: TenancyAttachments join table
-- Links uploaded documents (leases, schedules) to a tenant record.
-- Follows the same pattern as PurchaseOrderAttachments / QuoteAttachments
-- (migration 010). Deleting an Attachment cascades to remove the join row;
-- deleting a Tenant cascades to remove all join rows (blobs remain until
-- the cleanupAttachments timer runs).

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE object_id = OBJECT_ID('dbo.TenancyAttachments'))
BEGIN
    CREATE TABLE dbo.TenancyAttachments (
        TenantId     INT           NOT NULL REFERENCES dbo.Tenants(TenantId) ON DELETE CASCADE,
        AttachmentID INT           NOT NULL REFERENCES dbo.Attachments(Id)   ON DELETE CASCADE,
        AttachedBy   NVARCHAR(200) NULL,
        AttachedAt   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
        PRIMARY KEY (TenantId, AttachmentID)
    );
END

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TenancyAttachments_TenantId' AND object_id = OBJECT_ID('dbo.TenancyAttachments'))
BEGIN
    CREATE INDEX IX_TenancyAttachments_TenantId ON dbo.TenancyAttachments(TenantId);
END
