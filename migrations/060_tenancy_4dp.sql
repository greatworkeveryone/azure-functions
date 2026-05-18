-- m060: increase precision of tenancy numeric columns from 2 DP to 4 DP
-- Structured DECIMAL columns only. JSON blobs (ScheduledRateSteps, Incentives,
-- MiscFees, CarparkScheduleGroups) already carry full JS float precision.
-- ALTER COLUMN is safe here — widening scale never truncates existing data.

-- ── dbo.Tenants ──────────────────────────────────────────────────────────────

ALTER TABLE dbo.Tenants ALTER COLUMN RentPerAnnum             DECIMAL(14,4) NULL;
GO
ALTER TABLE dbo.Tenants ALTER COLUMN SecurityDepositHeld       DECIMAL(14,4) NULL;
GO
ALTER TABLE dbo.Tenants ALTER COLUMN LastReviewIncreasePercent DECIMAL(7,4)  NULL;
GO
ALTER TABLE dbo.Tenants ALTER COLUMN FixedReviewPercent        DECIMAL(7,4)  NULL;
GO
ALTER TABLE dbo.Tenants ALTER COLUMN CpiCapPercent             DECIMAL(7,4)  NULL;
GO
ALTER TABLE dbo.Tenants ALTER COLUMN CpiFloorPercent           DECIMAL(7,4)  NULL;
GO
ALTER TABLE dbo.Tenants ALTER COLUMN EscalationPercent         DECIMAL(7,4)  NULL;
GO

-- ── dbo.TenantOccupancies ────────────────────────────────────────────────────

ALTER TABLE dbo.TenantOccupancies ALTER COLUMN SizeSqm DECIMAL(10,4) NOT NULL;
GO

-- ── dbo.TenantOccupancyHistory ───────────────────────────────────────────────

ALTER TABLE dbo.TenantOccupancyHistory ALTER COLUMN SizeSqm      DECIMAL(10,4) NOT NULL;
GO
ALTER TABLE dbo.TenantOccupancyHistory ALTER COLUMN RentPerAnnum  DECIMAL(14,4) NULL;
GO

-- ── dbo.RentReviews ──────────────────────────────────────────────────────────

ALTER TABLE dbo.RentReviews ALTER COLUMN OldRentPerAnnum DECIMAL(14,4) NULL;
GO
ALTER TABLE dbo.RentReviews ALTER COLUMN NewRentPerAnnum DECIMAL(14,4) NULL;
GO
ALTER TABLE dbo.RentReviews ALTER COLUMN IncreasePercent DECIMAL(7,4)  NULL;
GO
ALTER TABLE dbo.RentReviews ALTER COLUMN CpiBaseValue    DECIMAL(10,4) NULL;
GO
ALTER TABLE dbo.RentReviews ALTER COLUMN CpiCurrentValue DECIMAL(10,4) NULL;
GO

-- ── dbo.Carparks ─────────────────────────────────────────────────────────────

ALTER TABLE dbo.Carparks ALTER COLUMN RentPerAnnum DECIMAL(14,4) NULL;
GO
