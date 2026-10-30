-- 187: tenant page hardening (TR2/TR3 review fixes, PLAN §15). Additive and idempotent.
--
--   TenantRequestPhotos.UploadState   'reserved' (row taken under the lock, blob not yet written),
--                  'stored' (blob written) or 'failed' (upload did not complete; the slot is free again).
--                  Existing rows are 'stored'. A 'reserved' row older than 15 minutes is listed by the
--                  read-only orphan report; nothing is ever deleted.
--   WorkRequests.ClientRequestId   a key the tenant page generates per report, so a retry after a timeout
--                  returns the original request instead of creating a second one. Unique per tenancy.
--   FeatureFlags   the tenantPage flag now reads its own audience row (RoleName 'tenant'). The row is seeded
--                  'hidden' so it is visible and the page stays off: enabling the flag for a staff role no
--                  longer enables it for link holders.
--
-- RUNBOOK: apply after 186. Then set tenantPage to 'enabled' for audience 'tenant' only when ready.

IF COL_LENGTH('dbo.TenantRequestPhotos', 'UploadState') IS NULL
  ALTER TABLE dbo.TenantRequestPhotos ADD UploadState NVARCHAR(10) NOT NULL CONSTRAINT DF_TenantRequestPhotos_UploadState DEFAULT N'stored';
GO

IF COL_LENGTH('dbo.WorkRequests', 'ClientRequestId') IS NULL ALTER TABLE dbo.WorkRequests ADD ClientRequestId NVARCHAR(40) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_WorkRequests_TenantClientRequest' AND object_id = OBJECT_ID('dbo.WorkRequests'))
  CREATE UNIQUE INDEX UX_WorkRequests_TenantClientRequest ON dbo.WorkRequests (SourceTenantId, ClientRequestId)
    WHERE SourceTenantId IS NOT NULL AND ClientRequestId IS NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM dbo.FeatureFlags WHERE FeatureKey = N'tenantPage' AND RoleName = N'tenant')
  INSERT INTO dbo.FeatureFlags (FeatureKey, RoleName, Visibility, UpdatedBy) VALUES (N'tenantPage', N'tenant', N'hidden', N'migration 187');
GO
