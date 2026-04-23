-- Migration 020: Seed inbound email parse queue for AI testing
--
-- Inserts emails that simulate the floorplan@randazzo.properties inbox so
-- parseEmailsTimer (or POST /adminTriggerEmailParse) can exercise the full
-- classify → extract → writeback pipeline end-to-end without a live mailbox.
--
-- Batch breakdown:
--   · 10 job emails    — tenant / owner maintenance reports, no prices
--   · 10 quote emails  — contractor replies referencing existing sent POs,
--                        each with a price and a quote number
--   · 5  invoice emails — contractor billing for 5 approved quotes
--                        (3 seed:012 + 2 seed:013 quotes are promoted to
--                        'approved' first so the emails have real targets)
--
-- All rows land with AIParsedAt = NULL and AIParseAttempts = 0 so the
-- timer picks them up on the next tick (or immediately via the trigger).
--
-- Idempotent: guarded by MessageID LIKE 'seed-020-%'.
-- To reseed:
--   DELETE FROM dbo.Emails WHERE MessageID LIKE 'seed-020-%';
--   UPDATE dbo.Quotes SET Status = 'pending'
--     WHERE CreatedBy IN ('seed:012','seed:013') AND Status = 'approved';
--   then re-run this file.

-- ── 1. Promote a handful of existing seeded quotes to 'approved' ────────────
-- Needed so we have real approved quotes to write invoice emails against.
-- Idempotent: only promotes if still pending.

UPDATE TOP (3) dbo.Quotes
   SET Status     = 'approved',
       ApprovedAt = DATEADD(DAY, -2, SYSUTCDATETIME()),
       ApprovedBy = 'seed:020'
 WHERE CreatedBy = 'seed:012'
   AND Status    = 'pending';
GO

UPDATE TOP (2) dbo.Quotes
   SET Status     = 'approved',
       ApprovedAt = DATEADD(DAY, -1, SYSUTCDATETIME()),
       ApprovedBy = 'seed:020'
 WHERE CreatedBy = 'seed:013'
   AND Status    = 'pending';
GO

-- ── 2. Job emails ────────────────────────────────────────────────────────────
-- Plain maintenance reports — no price, no quote reference.
-- The AI should classify these as "job" with high confidence.

IF NOT EXISTS (SELECT 1 FROM dbo.Emails WHERE MessageID LIKE 'seed-020-job-%')
BEGIN
  INSERT INTO dbo.Emails
    (MessageID, FromAddress, Subject, Body, ReceivedAt, Status)
  VALUES
  (
    'seed-020-job-01',
    'tenant.suite4b@example.com',
    'Hot water not working — Unit 4B',
    N'Hi,' + CHAR(10) + CHAR(10) +
    'We have had no hot water in Unit 4B since yesterday morning. ' +
    'Two adults and a child in the property — this is urgent. ' +
    'Please arrange a plumber as soon as possible.' + CHAR(10) + CHAR(10) +
    'Thanks,' + CHAR(10) + 'Sarah Mitchell',
    DATEADD(HOUR, -6, SYSUTCDATETIME()), 'unread'
  ),
  (
    'seed-020-job-02',
    'owner.building2@example.com',
    'Water leak — ceiling in level 2 corridor',
    N'Hi team,' + CHAR(10) + CHAR(10) +
    'There is a visible water stain spreading across the ceiling of the level 2 ' +
    'common corridor, near the lift lobby. Started after the weekend rain. ' +
    'Could someone inspect and arrange repair before it gets worse?' + CHAR(10) + CHAR(10) +
    'Regards,' + CHAR(10) + 'James Okafor (Owner)',
    DATEADD(HOUR, -9, SYSUTCDATETIME()), 'unread'
  ),
  (
    'seed-020-job-03',
    'manager.property7@example.com',
    'HVAC system fault — level 5 not cooling',
    N'Hello,' + CHAR(10) + CHAR(10) +
    'The air conditioning on level 5 has not been cooling properly for the past three days. ' +
    'The thermostat is set to 22°C but the office is sitting at 28°C. ' +
    'Tenants are complaining — please send an HVAC technician urgently.' + CHAR(10) + CHAR(10) +
    'Best,' + CHAR(10) + 'Priya Sharma',
    DATEADD(HOUR, -12, SYSUTCDATETIME()), 'unread'
  ),
  (
    'seed-020-job-04',
    'tenant.unit12@example.com',
    'Pest issue — cockroaches in kitchen',
    N'Hi,' + CHAR(10) + CHAR(10) +
    'I have noticed cockroaches in my kitchen over the past week. ' +
    'I keep the unit very clean so I believe they may be entering from the walls or drains. ' +
    'Please can you arrange a pest inspector.' + CHAR(10) + CHAR(10) +
    'Thanks,' + CHAR(10) + 'Daniel Torres',
    DATEADD(HOUR, -18, SYSUTCDATETIME()), 'unread'
  ),
  (
    'seed-020-job-05',
    'building.manager@example.com',
    'Lift making grinding noise — Building A',
    N'Team,' + CHAR(10) + CHAR(10) +
    'The main lift in Building A has been making a loud grinding noise when travelling ' +
    'between floors 3 and 6. It has happened consistently over the last two days. ' +
    'I would suggest taking it out of service for inspection before it fails completely.' + CHAR(10) + CHAR(10) +
    'Regards,' + CHAR(10) + 'Chris Nguyen (Building Manager)',
    DATEADD(HOUR, -24, SYSUTCDATETIME()), 'unread'
  ),
  (
    'seed-020-job-06',
    'tenant.lobby@example.com',
    'Broken glass — lobby entrance',
    N'Hi,' + CHAR(10) + CHAR(10) +
    'One of the glass panels in the lobby entrance door is cracked — looks like ' +
    'impact damage. It is still holding for now but there are sharp edges exposed. ' +
    'Please organise replacement glass urgently for safety.' + CHAR(10) + CHAR(10) +
    'Thanks,' + CHAR(10) + 'Amanda Lee',
    DATEADD(HOUR, -30, SYSUTCDATETIME()), 'unread'
  ),
  (
    'seed-020-job-07',
    'strata@example.com',
    'Graffiti on south external wall — needs removal',
    N'Hello,' + CHAR(10) + CHAR(10) +
    'There is a large graffiti tag on the south-facing external wall, visible from the ' +
    'street. This is affecting the appearance of the property and should be removed as ' +
    'soon as possible. A specialist graffiti removal service will likely be needed.' + CHAR(10) + CHAR(10) +
    'Kind regards,' + CHAR(10) + 'Strata Committee',
    DATEADD(HOUR, -36, SYSUTCDATETIME()), 'unread'
  ),
  (
    'seed-020-job-08',
    'security.gates@example.com',
    'Car park boom gate motor fault',
    N'Hi,' + CHAR(10) + CHAR(10) +
    'The boom gate motor on the entry to the basement car park has stopped working. ' +
    'The gate is stuck in the open position which is a security issue. ' +
    'Please arrange urgent repair — residents are concerned about unauthorized access.' + CHAR(10) + CHAR(10) +
    'Regards,' + CHAR(10) + 'Tom Brennan',
    DATEADD(HOUR, -48, SYSUTCDATETIME()), 'unread'
  ),
  (
    'seed-020-job-09',
    'compliance@example.com',
    'Exit light not working — fire compliance issue',
    N'Team,' + CHAR(10) + CHAR(10) +
    'The emergency exit light above the stairwell door on level 4 is not illuminated. ' +
    'This is a fire compliance issue and needs to be rectified before our upcoming ' +
    'annual fire safety audit next week.' + CHAR(10) + CHAR(10) +
    'Please treat as urgent.' + CHAR(10) + CHAR(10) +
    'Regards,' + CHAR(10) + 'Compliance Team',
    DATEADD(HOUR, -60, SYSUTCDATETIME()), 'unread'
  ),
  (
    'seed-020-job-10',
    'tenant.unit7a@example.com',
    'Mould in bathroom — Unit 7A',
    N'Hi,' + CHAR(10) + CHAR(10) +
    'I have noticed significant black mould growing on the bathroom ceiling and around ' +
    'the shower grout in my unit. I have tried cleaning it myself but it keeps coming ' +
    'back, which suggests a ventilation or moisture problem. ' +
    'Please can someone inspect and remediate.' + CHAR(10) + CHAR(10) +
    'Kind regards,' + CHAR(10) + 'Nina Patel',
    DATEADD(HOUR, -72, SYSUTCDATETIME()), 'unread'
  );
END
GO

-- ── 3. Quote emails ──────────────────────────────────────────────────────────
-- Contractor replies referencing existing sent POs. Each has a dollar amount
-- and a quote number so the AI can extract contractorName, amount, quoteNumber.
-- Picks up to 10 sent POs that don't already have a seed-020 quote email.

IF NOT EXISTS (SELECT 1 FROM dbo.Emails WHERE MessageID LIKE 'seed-020-quote-%')
BEGIN
  ;WITH eligible AS (
    SELECT TOP (10)
           po.PurchaseOrderID,
           po.PONumber,
           po.JobID,
           po.ContractorName,
           COALESCE(c.EmailAddress, 'contractor@example.com') AS FromAddress,
           ROW_NUMBER() OVER (ORDER BY po.PurchaseOrderID) AS rn
      FROM dbo.PurchaseOrders po
      LEFT JOIN dbo.Contractors c ON c.ContractorID = po.ContractorID
     WHERE po.SentAt IS NOT NULL
     ORDER BY po.PurchaseOrderID
  ),
  amounts (rn, amount, quote_suffix, lead_days, note) AS (
    SELECT 1,  1450.00, 'QA',  10, N'Supply and install as per scope. All materials included. Quote valid 30 days.'
    UNION ALL SELECT 2,  2875.00, 'QB',  14, N'Includes call-out fee, parts, and labour. Ex-GST $2,613.64. Lead time 2 weeks.'
    UNION ALL SELECT 3,   890.00, 'QC',   7, N'Parts and labour. Same-day availability subject to parts stock. Ex-GST $809.09.'
    UNION ALL SELECT 4,  6450.00, 'QD',  21, N'Two-stage works: stage 1 assessment $1,200, stage 2 remediation $5,250 (both inc. GST).'
    UNION ALL SELECT 5,  1325.00, 'QE',   5, N'Same-day response available if approved before 2 pm. GST inclusive.'
    UNION ALL SELECT 6,  3200.00, 'QF',  10, N'Full replacement unit supplied and installed. 12-month warranty on parts.'
    UNION ALL SELECT 7,   540.00, 'QG',   3, N'Minor repair works. Fixed-price — no call-out surprises. Ex-GST $490.91.'
    UNION ALL SELECT 8,  4800.00, 'QH',  14, N'Structural assessment plus remediation. Council notification included in scope.'
    UNION ALL SELECT 9,  1100.00, 'QI',   7, N'Service and calibration. Annual service plan available at $950/year.'
    UNION ALL SELECT 10, 7200.00, 'QJ',  28, N'Major works — staging plan attached. Scaffolding and traffic control included.'
  )
  INSERT INTO dbo.Emails
    (MessageID, FromAddress, Subject, Body, ReceivedAt, Status)
  SELECT
    CONCAT('seed-020-quote-', e.rn),
    e.FromAddress,
    CONCAT('Quote — Re: ', e.PONumber),
    N'Hi,' + CHAR(10) + CHAR(10) +
    'Thank you for the purchase order. Please find our formal quote below.' + CHAR(10) + CHAR(10) +
    'Quote Number: ' + CONCAT('QT-', e.JobID, '-', a.quote_suffix) + CHAR(10) +
    'Reference PO: ' + e.PONumber + CHAR(10) +
    'Total (inc. GST): $' + FORMAT(a.amount, 'N2') + CHAR(10) +
    'Lead Time: ' + CAST(a.lead_days AS NVARCHAR(5)) + ' business days from approval' + CHAR(10) + CHAR(10) +
    a.note + CHAR(10) + CHAR(10) +
    'Please do not hesitate to contact us if you have any questions.' + CHAR(10) + CHAR(10) +
    'Kind regards,' + CHAR(10) +
    e.ContractorName,
    DATEADD(HOUR, -(a.rn * 4), SYSUTCDATETIME()),
    'unread'
  FROM eligible e
  INNER JOIN amounts a ON a.rn = e.rn;
END
GO

-- ── 4. Invoice emails ────────────────────────────────────────────────────────
-- Billing emails for approved quotes. Amount = quote amount + 2–8% variation
-- (call-out fees, minor extras) — realistic rounding up on completion.

IF NOT EXISTS (SELECT 1 FROM dbo.Emails WHERE MessageID LIKE 'seed-020-inv-%')
BEGIN
  ;WITH approved AS (
    SELECT TOP (5)
           q.QuoteID,
           q.JobID,
           q.QuoteNumber,
           q.ContractorName,
           q.Amount       AS QuoteAmount,
           COALESCE(c.EmailAddress, 'accounts@contractor.example.com') AS FromAddress,
           ROW_NUMBER() OVER (ORDER BY q.QuoteID) AS rn
      FROM dbo.Quotes q
      LEFT JOIN dbo.Contractors c ON c.ContractorName = q.ContractorName
     WHERE q.Status = 'approved'
     ORDER BY q.QuoteID
  ),
  -- Small realistic uplifts on each invoice vs the quote
  uplifts (rn, pct) AS (
    SELECT 1, 1.03 UNION ALL
    SELECT 2, 1.05 UNION ALL
    SELECT 3, 1.02 UNION ALL
    SELECT 4, 1.08 UNION ALL
    SELECT 5, 1.04
  )
  INSERT INTO dbo.Emails
    (MessageID, FromAddress, Subject, Body, ReceivedAt, Status)
  SELECT
    CONCAT('seed-020-inv-', a.rn),
    a.FromAddress,
    CONCAT('Tax Invoice #INV-', a.JobID, '-', a.rn, ' — Job #', a.JobID),
    N'Hi,' + CHAR(10) + CHAR(10) +
    'Please find our tax invoice for works completed on Job #' + CAST(a.JobID AS NVARCHAR(20)) + '.' + CHAR(10) + CHAR(10) +
    'Invoice Number : INV-' + CAST(a.JobID AS NVARCHAR(20)) + '-' + CAST(a.rn AS NVARCHAR(5)) + CHAR(10) +
    'Quote Reference: ' + a.QuoteNumber + CHAR(10) +
    'Amount Due     : $' + FORMAT(ROUND(a.QuoteAmount * u.pct, 2), 'N2') + ' (inc. GST)' + CHAR(10) + CHAR(10) +
    'Payment is due within 14 days. Please remit to:' + CHAR(10) +
    '  BSB: 062-000  Account: 12345678  Ref: INV-' + CAST(a.JobID AS NVARCHAR(20)) + '-' + CAST(a.rn AS NVARCHAR(5)) + CHAR(10) + CHAR(10) +
    'Thank you for your business.' + CHAR(10) + CHAR(10) +
    'Regards,' + CHAR(10) +
    a.ContractorName,
    DATEADD(HOUR, -(a.rn * 3), SYSUTCDATETIME()),
    'unread'
  FROM approved a
  INNER JOIN uplifts u ON u.rn = a.rn;
END
GO
