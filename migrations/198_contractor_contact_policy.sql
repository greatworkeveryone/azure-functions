-- Migration 198: the escalation policy that tells accounts managers when a contractor's email or ABN changes
-- (audit fix AF11; SECA-04). Raised by updateContractorDetails, ended by confirmContractorContact.
--
--   contractor.contact_changed   authority  accounts manager (16 business hours), then the CFO (16), then a director.
--                                           The person who made the change is never the target. Ended only by a
--                                           second person confirming the change.
--
-- Unlike the chase policies of migration 199 this one is seeded ACTIVE (Active = 1): it is a security notice about
-- a change that can redirect money, so it should work from the first deploy. It sends nothing from staging, because
-- every sender goes through config/stagingGuard.ts. Switch it off the same way as any policy (Admin > System, or
-- UPDATE dbo.EscalationPolicies SET Active = 0, UpdatedBy = N'<who>' WHERE PolicyKey = N'contractor.contact_changed').
--
-- Additive and re-runnable: MERGE ... WHEN NOT MATCHED BY TARGET THEN INSERT only, so an admin's edit is never
-- overwritten and nothing existing is touched. Depends on 098's table; waits for it.

IF OBJECT_ID(N'dbo.EscalationPolicies', N'U') IS NOT NULL
BEGIN
  ;WITH Seed (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active) AS (
    SELECT * FROM (VALUES
      (N'contractor.contact_changed', N'authority', 0, N'business', N'yes',
        N'[{"role":"accounts_manager","slaHours":16},{"role":"cfo","slaHours":16},{"role":"director"}]', 1)
    ) AS v (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active)
  )
  MERGE dbo.EscalationPolicies AS target
  USING Seed AS source
    ON target.PolicyKey = source.PolicyKey
  WHEN NOT MATCHED BY TARGET THEN
    INSERT (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active, UpdatedBy)
    VALUES (source.PolicyKey, source.Kind, source.Urgent, source.Clock, source.AutoReescalate, source.Ladder, source.Active, N'migration:198_contractor_contact_policy');
END
GO
