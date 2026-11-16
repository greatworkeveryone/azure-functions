-- Migration 182: record who added a quote or invoice by Entra object id (security audit, 15 Nov 2026).
--
-- Separation of duties ("whoever added it doesn't approve it", src/moneyRules.ts creatorRefusal) compared
-- display names, the only creator detail these tables kept. A name changed in Entra between adding and
-- approving slipped past it, and two people sharing a name blocked each other. CreatedByOid is the stable
-- id; the check uses it when both sides have one and falls back to the name for rows from before this.
--
-- Backfill: an existing row gets the oid only when its CreatedBy names exactly one AppUsers row that has
-- signed in (EntraOid set); a shared or unknown name stays NULL and keeps the name check. Re-runnable.

IF COL_LENGTH('dbo.Quotes', 'CreatedByOid') IS NULL
  ALTER TABLE dbo.Quotes ADD CreatedByOid NVARCHAR(255) NULL;
GO

IF COL_LENGTH('dbo.JobInvoices', 'CreatedByOid') IS NULL
  ALTER TABLE dbo.JobInvoices ADD CreatedByOid NVARCHAR(255) NULL;
GO

WITH UniqueNames AS (
  SELECT LOWER(LTRIM(RTRIM(DisplayName))) AS NameKey, MIN(EntraOid) AS EntraOid
  FROM dbo.AppUsers
  WHERE EntraOid IS NOT NULL AND LTRIM(RTRIM(ISNULL(DisplayName, N''))) <> N''
  GROUP BY LOWER(LTRIM(RTRIM(DisplayName)))
  HAVING COUNT(*) = 1
)
UPDATE q SET CreatedByOid = u.EntraOid
FROM dbo.Quotes q
JOIN UniqueNames u ON u.NameKey = LOWER(LTRIM(RTRIM(q.CreatedBy)))
WHERE q.CreatedByOid IS NULL;
GO

WITH UniqueNames AS (
  SELECT LOWER(LTRIM(RTRIM(DisplayName))) AS NameKey, MIN(EntraOid) AS EntraOid
  FROM dbo.AppUsers
  WHERE EntraOid IS NOT NULL AND LTRIM(RTRIM(ISNULL(DisplayName, N''))) <> N''
  GROUP BY LOWER(LTRIM(RTRIM(DisplayName)))
  HAVING COUNT(*) = 1
)
UPDATE i SET CreatedByOid = u.EntraOid
FROM dbo.JobInvoices i
JOIN UniqueNames u ON u.NameKey = LOWER(LTRIM(RTRIM(i.CreatedBy)))
WHERE i.CreatedByOid IS NULL;
GO
