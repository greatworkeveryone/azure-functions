-- m070: increase precision of tenancy numeric columns from 4 DP to 10 DP
-- ALTER COLUMN is safe here — widening scale never truncates existing data.

-- ── dbo.Tenants ──────────────────────────────────────────────────────────────

ALTER TABLE dbo.Tenants ALTER COLUMN RentPerAnnum             DECIMAL(20,10) NULL;
GO
ALTER TABLE dbo.Tenants ALTER COLUMN SecurityDepositHeld       DECIMAL(20,10) NULL;
GO
ALTER TABLE dbo.Tenants ALTER COLUMN LastReviewIncreasePercent DECIMAL(13,10) NULL;
GO
ALTER TABLE dbo.Tenants ALTER COLUMN FixedReviewPercent        DECIMAL(13,10) NULL;
GO
ALTER TABLE dbo.Tenants ALTER COLUMN CpiCapPercent             DECIMAL(13,10) NULL;
GO
ALTER TABLE dbo.Tenants ALTER COLUMN CpiFloorPercent           DECIMAL(13,10) NULL;
GO
ALTER TABLE dbo.Tenants ALTER COLUMN EscalationPercent         DECIMAL(13,10) NULL;
GO

-- ── dbo.TenantOccupancies ────────────────────────────────────────────────────

ALTER TABLE dbo.TenantOccupancies ALTER COLUMN SizeSqm DECIMAL(16,10) NOT NULL;
GO

-- ── dbo.TenantOccupancyHistory ───────────────────────────────────────────────

ALTER TABLE dbo.TenantOccupancyHistory ALTER COLUMN SizeSqm      DECIMAL(16,10) NOT NULL;
GO
ALTER TABLE dbo.TenantOccupancyHistory ALTER COLUMN RentPerAnnum  DECIMAL(20,10) NULL;
GO

-- ── dbo.RentReviews ──────────────────────────────────────────────────────────

ALTER TABLE dbo.RentReviews ALTER COLUMN OldRentPerAnnum DECIMAL(20,10) NULL;
GO
ALTER TABLE dbo.RentReviews ALTER COLUMN NewRentPerAnnum DECIMAL(20,10) NULL;
GO
ALTER TABLE dbo.RentReviews ALTER COLUMN IncreasePercent DECIMAL(13,10) NULL;
GO
ALTER TABLE dbo.RentReviews ALTER COLUMN CpiBaseValue    DECIMAL(16,10) NULL;
GO
ALTER TABLE dbo.RentReviews ALTER COLUMN CpiCurrentValue DECIMAL(16,10) NULL;
GO

-- ── dbo.Carparks ─────────────────────────────────────────────────────────────

ALTER TABLE dbo.Carparks ALTER COLUMN RentPerAnnum DECIMAL(20,10) NULL;
GO
