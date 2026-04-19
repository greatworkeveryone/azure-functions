-- Migration 013: Seed AI-extracted quotes with the "AI Generated" tag on.
--
-- Creates Email rows + Quote rows where SourceEmailID is set and
-- AIValidatedAt is NULL — exactly the conditions the UI keys off to show the
-- orange "AI Generated — must be validated" tag + the Validate action.
-- Hand-varied amounts, scope text and lead-times so the list feels like real
-- parsed mail, not five identical copies.
--
-- Picks any sent PO that doesn't already have a quote from the same
-- contractor, so the Quotes-step eligibility rule (only contractors we
-- sent a PO to) is satisfied and the tag + controls actually render.
--
-- Idempotent — POs/Quotes tagged CreatedBy='seed:013', Emails tagged with a
-- 'seed-013-' MessageID prefix. To reseed:
--
--   DELETE FROM dbo.JobEvents WHERE CreatedBy = 'seed:013';
--   DELETE FROM dbo.Quotes    WHERE CreatedBy = 'seed:013';
--   DELETE FROM dbo.Emails    WHERE MessageID LIKE 'seed-013-%';

-- ── Emails: one per eligible sent PO ────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM dbo.Emails WHERE MessageID LIKE 'seed-013-%')
BEGIN
  WITH eligible AS (
    SELECT TOP (5)
           po.PurchaseOrderID,
           po.JobID,
           po.ContractorID,
           po.ContractorName,
           c.EmailAddress
      FROM dbo.PurchaseOrders po
      LEFT JOIN dbo.Contractors c ON c.ContractorID = po.ContractorID
     WHERE po.SentAt IS NOT NULL
       AND po.ContractorID IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM dbo.Quotes q
          WHERE q.JobID = po.JobID
            AND q.ContractorID = po.ContractorID
            AND q.SourceEmailID IS NOT NULL
       )
     ORDER BY po.PurchaseOrderID DESC
  )
  INSERT INTO dbo.Emails
    (MessageID, FromAddress, Subject, Body, ReceivedAt,
     MatchedJobID, Status, ProcessedAt)
  SELECT
    CONCAT('seed-013-', CAST(PurchaseOrderID AS NVARCHAR(20))),
    COALESCE(EmailAddress, 'quote-bot@contractor.test'),
    CONCAT('Quote — Job #', JobID),
    CONCAT(
      'Hi,' + CHAR(10) + CHAR(10) +
      'Please find attached our quote for Job #', JobID, '.' + CHAR(10) +
      'Lead time: 10 business days from approval.' + CHAR(10) +
      'Quote valid for 30 days.' + CHAR(10) + CHAR(10) +
      'Regards,' + CHAR(10),
      ContractorName
    ),
    DATEADD(HOUR, -18, SYSUTCDATETIME()),
    JobID,
    'promoted',
    DATEADD(HOUR, -18, SYSUTCDATETIME())
  FROM eligible;
END
GO

-- ── Quotes: AI-sourced, AIValidatedAt NULL so the tag shows ────────────────

IF NOT EXISTS (SELECT 1 FROM dbo.Quotes WHERE CreatedBy = 'seed:013')
BEGIN
  ;WITH eligible AS (
    SELECT po.PurchaseOrderID,
           po.JobID,
           po.ContractorID,
           po.ContractorName,
           e.EmailID,
           ROW_NUMBER() OVER (ORDER BY po.PurchaseOrderID DESC) AS rn
      FROM dbo.PurchaseOrders po
      INNER JOIN dbo.Emails e
        ON e.MessageID = CONCAT('seed-013-', CAST(po.PurchaseOrderID AS NVARCHAR(20)))
     WHERE po.SentAt IS NOT NULL
  ),
  variety (rn, amt, notes) AS (
    SELECT 1, CAST(2875.00 AS DECIMAL(18, 2)),
           CAST('Supply and install as per scope. Lead time 10 business days. Ex-GST $2,613.64.' AS NVARCHAR(MAX))
    UNION ALL SELECT 2, 4199.50,
           'Includes call-out + minor parts. Valid 30 days. Ex-GST $3,817.73.'
    UNION ALL SELECT 3,  890.00,
           'Parts only — client to arrange labour. Ex-GST $809.09.'
    UNION ALL SELECT 4, 6450.00,
           'Two-stage works: assessment $1,200, remediation $5,250 (both inc. GST).'
    UNION ALL SELECT 5, 1325.00,
           'Same-day response available if approved before 2 pm. Ex-GST $1,204.55.'
  ),
  existing_seq AS (
    SELECT JobID, ISNULL(MAX(Seq), 0) AS MaxSeq
      FROM dbo.Quotes
     GROUP BY JobID
  )
  INSERT INTO dbo.Quotes
    (JobID, QuoteNumber, Seq, ContractorID, ContractorName,
     Amount, Currency, Notes, SourceEmailID, ReceivedAt,
     Status, AIValidatedAt, AIValidatedBy, CreatedBy)
  SELECT
    eligible.JobID,
    -- YYMMDD-Q-{JobID}-AI-{rn} — matches the regex that auto-links quote
    -- numbers mentioned in event history text.
    CONCAT(
      FORMAT(SYSUTCDATETIME(), 'yyMMdd'),
      '-Q-', eligible.JobID,
      '-AI-', eligible.rn
    ),
    COALESCE(existing_seq.MaxSeq, 0) + eligible.rn,
    eligible.ContractorID,
    eligible.ContractorName,
    variety.amt,
    'AUD',
    variety.notes,
    eligible.EmailID,
    DATEADD(HOUR, -18, SYSUTCDATETIME()),
    'pending',
    NULL,  -- AIValidatedAt NULL → UI shows the orange AI tag
    NULL,  -- AIValidatedBy — stamped when a human hits Validate
    'seed:013'
  FROM eligible
  INNER JOIN variety ON variety.rn = eligible.rn
  LEFT JOIN existing_seq ON existing_seq.JobID = eligible.JobID;

  -- Mirror onto the activity feed so the job history shows the auto-add
  -- alongside its "AI Generated" context.
  INSERT INTO dbo.JobEvents
    (JobID, CreatedBy, [Text], EventType, QuoteID)
  SELECT
    q.JobID,
    'ai@command-centre',
    CONCAT(
      'Added quote ', q.QuoteNumber,
      ISNULL(CONCAT(' · ', q.ContractorName), ''),
      ' · $', FORMAT(q.Amount, 'N0'),
      ' (AI-extracted, pending validation)'
    ),
    'quote_added',
    q.QuoteID
  FROM dbo.Quotes q
  WHERE q.CreatedBy = 'seed:013';

  -- Bump LastModifiedDate on the parent jobs so list views reorder the way
  -- the runtime flow would (most-recently-touched first).
  UPDATE j
     SET j.LastModifiedDate = SYSUTCDATETIME()
    FROM dbo.Jobs j
    INNER JOIN dbo.Quotes q ON q.JobID = j.JobID
   WHERE q.CreatedBy = 'seed:013';
END
GO
