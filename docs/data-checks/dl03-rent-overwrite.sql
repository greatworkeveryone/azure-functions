-- DL-03 damage check: has the rent schedule panel overwritten stored rent?
--
-- READ-ONLY. Every statement is a SELECT against dbo tables; the only writes
-- are to this session's table variables. db_datareader is enough. Run once on
-- production (Will), save both result sets, and send them to Connor before
-- anyone edits a schedule again. Source: data-loss audit 2026-10-13 §9 item 1.
--
-- What happened: until WP23, every rent-step save, delete or undo in the
-- frontend wrote Tenants.RentPerAnnum = the LAST schedule row's annual rent
-- ($0 when that row was a pending review). Where a schedule has no
-- commencement row, RentPerAnnum is also the schedule's starting rent, so the
-- next save compounded the error.
--
-- Result 1 replays the schedule engine (BE src/scheduledRateStepLogic.ts:
-- computeScheduleRows + resolveCurrentRent, the head/WP23 engine, Darwin
-- "today") and lists every scheduled tenancy whose stored RentPerAnnum differs
-- from the engine's current row by a cent or more, with a Signal column:
--   'stored rent is 0'        - written from a pending last row. Damage.
--   'stored rent = last row'  - written from the last row, which is not the
--                               current one. Damage.
--   'no commencement row'     - RentPerAnnum is this schedule's base, so it
--                               differs from today's row by design. Compare it
--                               with the lease / Excel and with result 2.
--   'differs'                 - anything else. Check by hand.
-- Production's frontend computed "last row" with the pre-WP23 engine, so a
-- damaged row can land in 'differs' rather than 'stored rent = last row'.
-- Result 2 (the field notes) is the evidence either way: each overwrite left a
-- note recording the value it wrote, and the value before it is the one to
-- restore. Restoring is a separate, approved UPDATE; this script changes nothing.

SET NOCOUNT ON;

DECLARE @today nvarchar(10) =
  CONVERT(nvarchar(10), CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'AUS Central Standard Time' AS date), 23);

-- Schedule terms. ReviewRatchet arrives with migration 096, which production
-- may not have, so it is read through FOR JSON instead of by name.
DECLARE @state TABLE (
  TenantId int PRIMARY KEY,
  Annual float NOT NULL,
  Area float NULL,
  Rate float NULL,
  PrevCpi float NULL,
  InCascade bit NOT NULL,
  CapPct float NULL,
  FloorPct float NULL,
  Ratchet bit NOT NULL
);

INSERT @state (TenantId, Annual, Area, Rate, PrevCpi, InCascade, CapPct, FloorPct, Ratchet)
SELECT t.TenantId, ISNULL(CAST(t.RentPerAnnum AS float), 0), NULL, NULL, NULL, 0,
       CAST(t.CpiCapPercent AS float), CAST(t.CpiFloorPercent AS float),
       CASE WHEN JSON_VALUE(j.Doc, '$.ReviewRatchet') IN ('true', '1') THEN 1 ELSE 0 END
FROM dbo.Tenants t
CROSS APPLY (
  SELECT (SELECT t2.* FROM dbo.Tenants t2 WHERE t2.TenantId = t.TenantId
          FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS Doc
) j
WHERE ISJSON(t.ScheduledRateSteps) = 1 AND t.ScheduledRateSteps <> '[]';

-- Steps the engine accepts (parseSteps: object with string id, string
-- effectiveFrom, numeric ratePercent), in sortSteps order (effectiveFrom, then
-- stored order).
DECLARE @steps TABLE (
  TenantId int NOT NULL,
  Rn int NOT NULL,
  EffectiveFrom nvarchar(30) NOT NULL,
  MethodKind nvarchar(30) NULL,
  Resolution nvarchar(30) NULL,
  RatePercent float NOT NULL,
  Sqm float NULL,
  BaseRent float NULL,
  CpiValue float NULL,
  CpiValuePrev float NULL,
  Pending bit NULL,
  RowAnnual float NULL,
  PRIMARY KEY (TenantId, Rn)
);

INSERT @steps (TenantId, Rn, EffectiveFrom, MethodKind, Resolution, RatePercent, Sqm, BaseRent, CpiValue, CpiValuePrev)
SELECT t.TenantId,
       ROW_NUMBER() OVER (PARTITION BY t.TenantId ORDER BY w.effectiveFrom, CAST(e.[key] AS int)),
       w.effectiveFrom, w.methodKind, NULLIF(w.resolution, ''), w.ratePercent,
       w.sqm, w.baseRentPerAnnum, w.cpiValue, w.cpiValuePrev
FROM dbo.Tenants t
JOIN @state s ON s.TenantId = t.TenantId
CROSS APPLY OPENJSON(t.ScheduledRateSteps) e
CROSS APPLY OPENJSON(CASE WHEN e.[type] = 5 THEN e.value ELSE N'{}' END) WITH (
  effectiveFrom nvarchar(30) '$.effectiveFrom',
  methodKind nvarchar(30) '$.methodKind',
  resolution nvarchar(30) '$.resolution',
  ratePercent float '$.ratePercent',
  sqm float '$.sqm',
  baseRentPerAnnum float '$.baseRentPerAnnum',
  cpiValue float '$.cpiValue',
  cpiValuePrev float '$.cpiValuePrev'
) w
WHERE e.[type] = 5
  AND (SELECT COUNT(*) FROM OPENJSON(CASE WHEN e.[type] = 5 THEN e.value ELSE N'{}' END) k
       WHERE (k.[key] IN ('id', 'effectiveFrom') AND k.[type] = 1)
          OR (k.[key] = 'ratePercent' AND k.[type] = 2)) = 3;

-- Walk each schedule one row at a time, exactly as computeScheduleRows does.
DECLARE @rn int = 1, @maxRn int = (SELECT ISNULL(MAX(Rn), 0) FROM @steps);
DECLARE @work TABLE (
  TenantId int PRIMARY KEY, Pending bit, Annual float, Area float NULL,
  Rate float NULL, PrevCpi float NULL, InCascade bit
);

WHILE @rn <= @maxRn
BEGIN
  DELETE FROM @work;

  INSERT @work (TenantId, Pending, Annual, Area, Rate, PrevCpi, InCascade)
  SELECT s.TenantId,
         nx.Pending,
         nx.Annual,
         nx.Area,
         nx.Rate,
         CASE WHEN nx.Pending = 1 THEN st.PrevCpi ELSE COALESCE(s.CpiValue, st.PrevCpi) END,
         nx.InCascade
  FROM @steps s
  JOIN @state st ON st.TenantId = s.TenantId
  CROSS APPLY (SELECT
    CASE WHEN s.Sqm > 0 THEN s.Sqm END AS ExplicitArea,
    COALESCE(s.CpiValuePrev, st.PrevCpi) AS Baseline,
    CASE WHEN s.MethodKind = 'commencement' THEN 1 ELSE 0 END AS IsComm,
    CASE WHEN s.Resolution IS NULL
              AND ((s.MethodKind = 'cpi' AND s.CpiValue IS NULL)
                OR (s.MethodKind IN ('market', 'other') AND s.RatePercent = 0))
         THEN 1 ELSE 0 END AS OwnMissing
  ) a
  CROSS APPLY (SELECT
    CASE WHEN s.MethodKind = 'cpi' AND s.CpiValue IS NOT NULL AND NULLIF(a.Baseline, 0) IS NOT NULL
         THEN s.CpiValue / a.Baseline ELSE 1 + s.RatePercent / 100 END AS RawFactor
  ) r
  CROSS APPLY (SELECT
    CASE WHEN s.MethodKind = 'cpi' AND st.FloorPct IS NOT NULL AND r.RawFactor < 1 + st.FloorPct / 100
         THEN 1 + st.FloorPct / 100 ELSE r.RawFactor END AS Floored
  ) f1
  CROSS APPLY (SELECT
    CASE WHEN s.MethodKind = 'cpi' AND st.CapPct IS NOT NULL AND f1.Floored > 1 + st.CapPct / 100
         THEN 1 + st.CapPct / 100 ELSE f1.Floored END AS Capped
  ) f2
  CROSS APPLY (SELECT
    CASE WHEN s.Resolution = 'waived' THEN 1
         WHEN st.Ratchet = 1 AND f2.Capped < 1 THEN 1
         ELSE f2.Capped END AS Factor
  ) f
  CROSS APPLY (SELECT
    CASE WHEN a.IsComm = 1 THEN 0 ELSE CASE WHEN st.InCascade = 1 OR a.OwnMissing = 1 THEN 1 ELSE 0 END END AS InCascade
  ) c
  CROSS APPLY (SELECT
    -- commencement: base rent and area reset the schedule
    CASE WHEN a.IsComm = 1 THEN COALESCE(s.BaseRent, st.Annual) END AS CommAnnual,
    CASE WHEN a.IsComm = 1 THEN COALESCE(a.ExplicitArea, st.Area) END AS CommArea
  ) cm
  CROSS APPLY (SELECT
    CASE WHEN a.IsComm = 0 AND c.InCascade = 0 AND st.Area IS NOT NULL AND st.Rate IS NOT NULL
         THEN st.Rate * f.Factor END AS RateByArea
  ) ra
  CROSS APPLY (SELECT
    CAST(CASE WHEN a.IsComm = 0 AND c.InCascade = 1 THEN 1 ELSE 0 END AS bit) AS Pending,
    CAST(c.InCascade AS bit) AS InCascade,
    CASE
      WHEN a.IsComm = 1 THEN cm.CommAnnual
      WHEN c.InCascade = 1 THEN st.Annual
      WHEN ra.RateByArea IS NOT NULL THEN ra.RateByArea * COALESCE(a.ExplicitArea, st.Area)
      ELSE st.Annual * f.Factor
    END AS Annual,
    CASE
      WHEN a.IsComm = 1 THEN cm.CommArea
      WHEN c.InCascade = 1 THEN st.Area
      ELSE COALESCE(a.ExplicitArea, st.Area)
    END AS Area,
    CASE
      WHEN a.IsComm = 1 THEN CASE WHEN cm.CommArea IS NOT NULL THEN cm.CommAnnual / cm.CommArea END
      WHEN c.InCascade = 1 THEN st.Rate
      WHEN ra.RateByArea IS NOT NULL THEN ra.RateByArea
      WHEN a.ExplicitArea IS NOT NULL THEN (st.Annual * f.Factor) / a.ExplicitArea
      ELSE st.Rate
    END AS Rate
  ) nx
  WHERE s.Rn = @rn;

  UPDATE s SET Pending = w.Pending,
               RowAnnual = CASE WHEN w.Pending = 1 THEN 0 ELSE ROUND(w.Annual, 2) END
  FROM @steps s JOIN @work w ON w.TenantId = s.TenantId
  WHERE s.Rn = @rn;

  UPDATE st SET Annual = w.Annual, Area = w.Area, Rate = w.Rate, PrevCpi = w.PrevCpi, InCascade = w.InCascade
  FROM @state st JOIN @work w ON w.TenantId = st.TenantId;

  SET @rn += 1;
END;

-- Result 1: stored rent vs the engine's current row.
WITH resolved AS (
  SELECT t.TenantId, t.LegalName, CAST(t.RentPerAnnum AS float) AS StoredRent,
         t.UpdatedAt, t.UpdatedByName,
         cur.EffectiveFrom AS CurrentRowFrom, cur.RowAnnual AS CurrentRowAnnual,
         firstRow.MethodKind AS FirstMethod, firstRow.EffectiveFrom AS FirstFrom,
         lastRow.EffectiveFrom AS LastRowFrom, lastRow.RowAnnual AS LastRowAnnual,
         CASE WHEN EXISTS (SELECT 1 FROM @steps x WHERE x.TenantId = t.TenantId AND x.MethodKind = 'commencement')
              THEN 1 ELSE 0 END AS HasCommencementRow
  FROM dbo.Tenants t
  CROSS APPLY (SELECT TOP 1 x.MethodKind, x.EffectiveFrom FROM @steps x WHERE x.TenantId = t.TenantId ORDER BY x.Rn) firstRow
  CROSS APPLY (SELECT TOP 1 x.EffectiveFrom, x.RowAnnual FROM @steps x WHERE x.TenantId = t.TenantId ORDER BY x.Rn DESC) lastRow
  OUTER APPLY (SELECT TOP 1 x.EffectiveFrom, x.RowAnnual FROM @steps x
               WHERE x.TenantId = t.TenantId AND x.EffectiveFrom <= @today AND x.Pending = 0
               ORDER BY x.Rn DESC) cur
),
engine AS (
  SELECT r.*,
         CASE
           WHEN r.CurrentRowFrom IS NOT NULL THEN 'row'
           WHEN r.FirstMethod <> 'commencement' AND ISNULL(r.StoredRent, 0) > 0 THEN 'base'
           WHEN r.FirstFrom > @today THEN 'not started'
           ELSE 'pending'
         END AS EngineBasis,
         CASE
           WHEN r.CurrentRowFrom IS NOT NULL THEN r.CurrentRowAnnual
           WHEN r.FirstMethod <> 'commencement' AND ISNULL(r.StoredRent, 0) > 0 THEN ROUND(r.StoredRent, 2)
           ELSE 0
         END AS EngineCurrentAnnual
  FROM resolved r
)
SELECT TenantId, LegalName, StoredRent, EngineCurrentAnnual, EngineBasis, CurrentRowFrom,
       LastRowFrom, LastRowAnnual, HasCommencementRow,
       CASE
         WHEN ISNULL(StoredRent, 0) = 0 THEN 'stored rent is 0'
         WHEN ABS(StoredRent - LastRowAnnual) < 0.01
              AND (CurrentRowFrom IS NULL OR LastRowFrom <> CurrentRowFrom) THEN 'stored rent = last row'
         WHEN HasCommencementRow = 0 THEN 'no commencement row'
         ELSE 'differs'
       END AS Signal,
       UpdatedAt, UpdatedByName
FROM engine
WHERE ABS(ISNULL(StoredRent, 0) - EngineCurrentAnnual) >= 0.01
ORDER BY Signal, LegalName;

-- Result 2: every value written to RentPerAnnum through a field edit, oldest
-- first (the panel's overwrites arrive here). The note before a bad one holds
-- the value to restore. Query as in audit §9.
SELECT n.TenantId, t.LegalName, n.CreatedAt, n.CreatedByName, n.Body
FROM dbo.TenantNotes n
JOIN dbo.Tenants t ON t.TenantId = n.TenantId
WHERE n.AnchorKind = 'field' AND n.FieldKey = 'rentPerAnnum'
ORDER BY n.TenantId, n.CreatedAt;
