-- Migration 180: two more access-pattern rules (decision 15, audit of 7 Nov 2026).
--
--   new_network  the address hash has not been seen for that person in 90 days
--                (the first network ever is a baseline). Server-side, so a
--                phished account or a replayed token used from somewhere new
--                shows up even when the browser's country claim is missing or
--                set to match.
--   no_country   a sign-in that carried no country claim at all, from someone
--                the log already knows. The app always sends one ("XX" when it
--                cannot tell); a client that sends none is not the app.
--
-- The CHECK on AccessEvents.Anomaly must allow the new values. A CHECK cannot
-- be widened in place and this repository's migrations never DROP, so the
-- original constraint is switched off (NOCHECK: it stays in the catalogue, not
-- enforced) and a wider one is added beside it. Re-runnable: each step is
-- guarded. No rows change.

IF EXISTS (SELECT 1 FROM sys.check_constraints
            WHERE name = 'CK_AccessEvents_Anomaly'
              AND parent_object_id = OBJECT_ID('dbo.AccessEvents')
              AND is_disabled = 0)
  ALTER TABLE dbo.AccessEvents NOCHECK CONSTRAINT CK_AccessEvents_Anomaly;
GO

IF OBJECT_ID('dbo.AccessEvents', 'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.check_constraints
                    WHERE name = 'CK_AccessEvents_Anomaly_v2'
                      AND parent_object_id = OBJECT_ID('dbo.AccessEvents'))
  ALTER TABLE dbo.AccessEvents WITH CHECK ADD CONSTRAINT CK_AccessEvents_Anomaly_v2
    CHECK (Anomaly IN (N'none', N'new_country', N'no_country', N'new_network', N'outside_window', N'new_device', N'burst'));
GO

-- new_network: "has this person used this address in the last 90 days?" (pairs with IX_AccessEvents_Oid_Device)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_AccessEvents_Oid_Network' AND object_id = OBJECT_ID('dbo.AccessEvents'))
  CREATE INDEX IX_AccessEvents_Oid_Network ON dbo.AccessEvents (Oid, IpHash, At);
GO
