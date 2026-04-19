-- Migration 012: Seed purchase orders, quotes, and source emails.
--
-- Exercises the full PO → Quote → (AI-validate) → approve UI loop with mixed
-- data:
--
--   · ~10 sent POs across active jobs, each paired with an active contractor
--   · 5 AI-extracted quotes (SourceEmailID set, AIValidatedAt NULL so the
--     orange "must be validated" tag shows)
--   · 5 manually-added quotes on the other POs
--   · 5 Email rows backing the AI quotes, marked "promoted"
--
-- Quote contractors intentionally match the PO contractor on the same job so
-- the Quotes-step eligibility rule (only contractors who were sent a PO) is
-- satisfied.
--
-- Idempotent — everything is tagged `seed:012` (POs/Quotes.CreatedBy) or
-- `seed-012-<poId>` (Emails.MessageID), so re-running after the first seed
-- has landed is a no-op. To reseed:
--
--   DELETE FROM dbo.Quotes            WHERE CreatedBy = 'seed:012';
--   DELETE FROM dbo.Emails            WHERE MessageID LIKE 'seed-012-%';
--   DELETE FROM dbo.PurchaseOrders    WHERE CreatedBy = 'seed:012';
--
-- then re-run this file.

IF NOT EXISTS (SELECT 1 FROM dbo.PurchaseOrders WHERE CreatedBy = 'seed:012')
BEGIN
  -- ── Pair 10 active jobs with 10 random active contractors ────────────────
  -- Uses ROW_NUMBER() over NEWID() on both sides to get a random pairing that
  -- still joins cleanly. Gracefully yields fewer rows if the DB has fewer
  -- than 10 active jobs or contractors.

  WITH picked_jobs AS (
    SELECT TOP (10)
           j.JobID,
           ROW_NUMBER() OVER (ORDER BY NEWID()) AS rn
      FROM dbo.Jobs j
     WHERE j.Status <> 'Done'
  ),
  picked_contractors AS (
    SELECT TOP (10)
           c.ContractorID,
           c.ContractorName,
           c.EmailAddress,
           ROW_NUMBER() OVER (ORDER BY NEWID()) AS rn
      FROM dbo.Contractors c
     WHERE c.Active = 1
  ),
  pairs AS (
    SELECT j.JobID,
           c.ContractorID,
           c.ContractorName,
           c.EmailAddress
      FROM picked_jobs j
      INNER JOIN picked_contractors c ON c.rn = j.rn
  )
  INSERT INTO dbo.PurchaseOrders
    (JobID, PONumber, Seq, ContractorID, ContractorName, Scope,
     EstimatedCost, CostNotToExceed, EmailSubject, EmailBody,
     SentAt, SentBy, CreatedBy)
  SELECT
    JobID,
    CONCAT('PO-', JobID, '-1'),
    1,
    ContractorID,
    ContractorName,
    'Scope — see attached purchase order for the described works.',
    1200.00,
    1500.00,
    CONCAT('Purchase Order for Job #', JobID),
    'Please quote against the attached purchase order at your earliest convenience.',
    DATEADD(DAY, -7, SYSUTCDATETIME()),
    'seed:012',
    'seed:012'
  FROM pairs;
END
GO

-- ── Emails for the first 5 seeded POs ─────────────────────────────────────
-- These represent the contractor's reply email that the AI extracted a
-- quote from. Status = 'promoted' indicates ingest + promotion already ran.

IF NOT EXISTS (SELECT 1 FROM dbo.Emails WHERE MessageID LIKE 'seed-012-%')
BEGIN
  WITH po_ranked AS (
    SELECT po.PurchaseOrderID, po.JobID, po.ContractorID, po.ContractorName,
           c.EmailAddress,
           ROW_NUMBER() OVER (ORDER BY po.PurchaseOrderID) AS rn
      FROM dbo.PurchaseOrders po
      LEFT JOIN dbo.Contractors c ON c.ContractorID = po.ContractorID
     WHERE po.CreatedBy = 'seed:012'
  )
  INSERT INTO dbo.Emails
    (MessageID, FromAddress, Subject, Body, ReceivedAt,
     MatchedJobID, Status, ProcessedAt)
  SELECT
    CONCAT('seed-012-', CAST(PurchaseOrderID AS NVARCHAR(20))),
    COALESCE(EmailAddress, 'contractor@example.com'),
    CONCAT('Re: PO-', JobID, '-1 — Quote attached'),
    CONCAT(
      'Hi,' + CHAR(10) + CHAR(10) +
      'Please find our quote attached for Job #', JobID, '.' + CHAR(10) +
      'Total: $1,450.00 (inc. GST).' + CHAR(10) +
      'Lead time: 2 weeks from approval.' + CHAR(10) + CHAR(10) +
      'Regards,' + CHAR(10),
      ContractorName
    ),
    DATEADD(DAY, -3, SYSUTCDATETIME()),
    JobID,
    'promoted',
    DATEADD(DAY, -3, SYSUTCDATETIME())
  FROM po_ranked
  WHERE rn <= 5;
END
GO

-- ── Quotes: 5 AI-extracted + 5 manual ─────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM dbo.Quotes WHERE CreatedBy = 'seed:012')
BEGIN
  -- AI-extracted quotes (first 5 POs, linked to the seed-012 emails)
  WITH po_ranked AS (
    SELECT po.PurchaseOrderID, po.JobID, po.ContractorID, po.ContractorName,
           ROW_NUMBER() OVER (ORDER BY po.PurchaseOrderID) AS rn
      FROM dbo.PurchaseOrders po
     WHERE po.CreatedBy = 'seed:012'
  )
  INSERT INTO dbo.Quotes
    (JobID, QuoteNumber, Seq, ContractorID, ContractorName, Amount, Currency,
     Notes, SourceEmailID, ReceivedAt, Status, CreatedBy)
  SELECT
    p.JobID,
    CONCAT('QT-', p.JobID, '-1'),
    1,
    p.ContractorID,
    p.ContractorName,
    1450.00,
    'AUD',
    'Parsed from email. Lead time: 2 weeks.',
    e.EmailID,
    DATEADD(DAY, -3, SYSUTCDATETIME()),
    'pending',
    'seed:012'
  FROM po_ranked p
  INNER JOIN dbo.Emails e
    ON e.MessageID = CONCAT('seed-012-', CAST(p.PurchaseOrderID AS NVARCHAR(20)))
  WHERE p.rn <= 5;

  -- Manual quotes (POs 6-10) — no SourceEmailID, no AI tag
  WITH po_ranked AS (
    SELECT po.PurchaseOrderID, po.JobID, po.ContractorID, po.ContractorName,
           ROW_NUMBER() OVER (ORDER BY po.PurchaseOrderID) AS rn
      FROM dbo.PurchaseOrders po
     WHERE po.CreatedBy = 'seed:012'
  )
  INSERT INTO dbo.Quotes
    (JobID, QuoteNumber, Seq, ContractorID, ContractorName, Amount, Currency,
     Notes, Status, CreatedBy)
  SELECT
    p.JobID,
    CONCAT('QT-', p.JobID, '-1'),
    1,
    p.ContractorID,
    p.ContractorName,
    1500.00,
    'AUD',
    'Manually entered by facilities team — matched to the sent PO.',
    'pending',
    'seed:012'
  FROM po_ranked p
  WHERE p.rn > 5;
END
GO
