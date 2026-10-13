-- Migration 116: Reference codes for Johanne's MYOB reference format.
--
--   Buildings.ReferenceCode           short code used in references, e.g. 66S
--   PurchaseOrders.ChargeCode         charge code the PO number was built from
--   JobInvoices.SupplierInvoiceNumber the supplier's invoice number, verbatim
--
-- Purely additive and re-runnable: every ADD COLUMN and CREATE INDEX is
-- existence-guarded, new columns are NULL, nothing is dropped, deleted or
-- altered. The migration runner (src/migrate.ts) splits on the GO lines and
-- runs each batch on its own, so a column is added in one batch and used in
-- the next. A migration that throws stops the whole API at startup, so the
-- two steps that could fail (the unique index and the building seed) skip
-- themselves with a PRINT instead.
--
-- ReferenceCode is deliberately generic: the asset register reuses it for
-- asset tags. The myBuildings building sync (syncBuildings) updates an
-- explicit column list and never touches this column, so synced rows keep
-- their code.
--
-- Default collation is case-insensitive, so the unique index also refuses
-- 'McM' next to 'MCM'. That is intended; the reference parser is the part
-- that is case-sensitive.

-- 1. The new columns.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Buildings') AND name = 'ReferenceCode')
  ALTER TABLE dbo.Buildings ADD ReferenceCode NVARCHAR(4) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.JobInvoices') AND name = 'SupplierInvoiceNumber')
  ALTER TABLE dbo.JobInvoices ADD SupplierInvoiceNumber NVARCHAR(255) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.PurchaseOrders') AND name = 'ChargeCode')
  ALTER TABLE dbo.PurchaseOrders ADD ChargeCode NVARCHAR(4) NULL;
GO

-- 2. Indexes. The unique index goes in before the seed below, so the seed can
-- never leave two buildings with the same code. Skipped (not failed) if
-- duplicates already exist.

IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_Buildings_ReferenceCode' AND object_id = OBJECT_ID('dbo.Buildings'))
  PRINT '116: UX_Buildings_ReferenceCode already exists - nothing to do.';
ELSE IF EXISTS (
  SELECT 1 FROM dbo.Buildings WHERE ReferenceCode IS NOT NULL
   GROUP BY ReferenceCode HAVING COUNT(*) > 1
)
  PRINT '116: SKIPPED UX_Buildings_ReferenceCode - duplicate Buildings.ReferenceCode values exist. Resolve them and re-run.';
ELSE
  EXEC('CREATE UNIQUE INDEX UX_Buildings_ReferenceCode ON dbo.Buildings(ReferenceCode) WHERE ReferenceCode IS NOT NULL');
GO

-- PO creation reads PONumber with UPDLOCK/HOLDLOCK to pick a free suffix; an
-- index keeps that lock to the matching key range instead of the whole table.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_POs_PONumber' AND object_id = OBJECT_ID('dbo.PurchaseOrders'))
  CREATE INDEX IX_POs_PONumber ON dbo.PurchaseOrders(PONumber);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_JobInvoices_SupplierInvoiceNumber' AND object_id = OBJECT_ID('dbo.JobInvoices'))
  CREATE INDEX IX_JobInvoices_SupplierInvoiceNumber
    ON dbo.JobInvoices(SupplierInvoiceNumber)
    WHERE SupplierInvoiceNumber IS NOT NULL;
GO

-- 3. Seed Buildings.ReferenceCode (backfill of the new column only).
--
-- Each row maps one sheet code to a LIKE pattern, matched against
-- BuildingName, BuildingAddress and the myBuildings BuildingCode of ACTIVE
-- buildings. A code is set only when
--   * exactly one active building matches the code's patterns,
--   * that building matches no other code,
--   * the building has no code yet (ReferenceCode IS NULL), and
--   * no other building already holds the code.
-- Anything ambiguous is left alone for a human; the query at the bottom lists
-- what is still unmapped.
--
-- Patterns come from the sheet's property names plus the names and codes seen
-- in the repo (myBuildings codes look like 66SS, 911CS, 45SH). Codes marked
-- "inferred" follow that pattern but were not seen in real data.
--
-- Left out on purpose:
--   HB   Lot C - Hingston Beach: the handwriting on the sheet is unclear.
--        Confirm with Johanne, then map by hand.
--   2P   2 Palmerston Circuit: no building is known to match. The mock data's
--        "Palmerston Plus" (code 2PALM) might be it, but that is a guess.

DECLARE @map TABLE (RefCode NVARCHAR(4) NOT NULL, Pattern NVARCHAR(255) NOT NULL);
DECLARE @hits TABLE (RefCode NVARCHAR(4) NOT NULL, BuildingID INT NOT NULL);

INSERT INTO @map (RefCode, Pattern) VALUES
  (N'10G', N'10 Georgina%'),
  (N'10G', N'10GC'),            -- inferred
  (N'12G', N'12 Georgina%'),
  (N'12G', N'12GC'),            -- inferred
  (N'23T', N'23 Temira%'),
  (N'23T', N'23TC'),            -- inferred
  (N'24G', N'24 Gunbar%'),
  (N'24G', N'24GS'),            -- inferred
  (N'26G', N'26 Gunbar%'),
  (N'26G', N'26GS'),            -- inferred
  (N'2P',  N'2 Palmerston%'),
  (N'2P',  N'2PC'),             -- inferred
  (N'30D', N'30 Daly%'),
  (N'30D', N'30DS'),
  (N'45S', N'45 Stuart%'),
  (N'45S', N'45SH'),
  (N'49S', N'49 Stuart%'),
  (N'49S', N'49SH'),            -- inferred
  (N'4S',  N'4 Searcy%'),
  (N'4S',  N'4SS'),             -- inferred
  (N'66S', N'66 Smith%'),
  (N'66S', N'66SS'),
  (N'6S',  N'6 Searcy%'),
  (N'6S',  N'6SS'),
  (N'7M',  N'7 Melville%'),
  (N'7M',  N'7MS'),             -- inferred
  (N'86M', N'86 Mitchell%'),
  (N'86M', N'86MS'),            -- inferred
  (N'9C',  N'9-11 Cav_nagh%'),  -- sheet spells it Cavanagh, myBuildings Cavenagh
  (N'9C',  N'9 Cav_nagh%'),
  (N'9C',  N'911CS'),
  (N'9M',  N'9 Melville%'),
  (N'9M',  N'9MS'),             -- inferred
  (N'ALB', N'Albatross%'),
  (N'ALB', N'19-23 Albatross%'),
  (N'ALB', N'1923AS'),
  (N'HA',  N'Highway Arcade%'),
  (N'HA',  N'47 Stuart%'),
  (N'HA',  N'47SH'),
  (N'HH',  N'Highway House%'),
  (N'HH',  N'14PS'),
  (N'LT',  N'%Lambell T%'),     -- two Lambell Tce buildings would match, and then stay unmapped
  (N'MAN', N'%Mangola C%'),
  (N'McM', N'%McMinn%'),
  (N'McM', N'93MS'),
  (N'RCK', N'Randazzo Centre%'),
  (N'RCK', N'16-18 Katherine%'),
  (N'RCK', N'1618KT');

INSERT INTO @hits (RefCode, BuildingID)
SELECT DISTINCT m.RefCode, b.BuildingID
  FROM @map m
  JOIN dbo.Buildings b
    ON b.Active = 1
   AND (b.BuildingName LIKE m.Pattern
        OR b.BuildingAddress LIKE m.Pattern
        OR b.BuildingCode LIKE m.Pattern);

-- The seed is a convenience, not a requirement (a building without a code
-- just gets the legacy PO number format), so a failure here must not throw
-- and stop the API at startup.
BEGIN TRY
  UPDATE b
     SET b.ReferenceCode = h.RefCode
    FROM dbo.Buildings b
    JOIN @hits h ON h.BuildingID = b.BuildingID
   WHERE b.ReferenceCode IS NULL
     AND h.RefCode IN (SELECT RefCode FROM @hits GROUP BY RefCode HAVING COUNT(*) = 1)
     AND h.BuildingID IN (SELECT BuildingID FROM @hits GROUP BY BuildingID HAVING COUNT(*) = 1)
     AND NOT EXISTS (SELECT 1 FROM dbo.Buildings b2 WHERE b2.ReferenceCode = h.RefCode);
END TRY
BEGIN CATCH
  PRINT '116: Buildings.ReferenceCode seed skipped: ' + ERROR_MESSAGE();
END CATCH;

-- Active buildings that still have no code. Map these by hand, e.g.
--   UPDATE dbo.Buildings SET ReferenceCode = N'HB'
--    WHERE BuildingID = <id> AND ReferenceCode IS NULL;
--
-- SELECT BuildingID, BuildingName, BuildingAddress, BuildingCode
--   FROM dbo.Buildings
--  WHERE Active = 1 AND ReferenceCode IS NULL
--  ORDER BY BuildingName;
