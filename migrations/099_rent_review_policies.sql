-- Migration 099: the rent review escalation policies (WP26, PLAN §3.4 E1-E3, §3.7).
--
--   rent_review.not_commenced  E1  attention  accounts_manager (40 business hours) -> director (40)
--                                  raised by the generator from 14 days before the review
--                                  date while the review isn't commenced; ends when it is
--   rent_review.overdue        E2  attention  accounts_manager (16) -> director (40)
--                                  raised by the generator once the review date has passed;
--                                  ends when it is approved, waived or cancelled
--   rent_review.approval       E3  authority  accounts_manager (16) -> cfo (16) -> director
--                                  raised on SUBMIT; never the preparer; ends when it is
--                                  approved or returned (the approver must hold the level
--                                  E3 has reached: check C7)
--
-- Migration 098 already seeds these three rows, with these values, so on any
-- database where 098 ran this file inserts nothing. It is here so WP26's
-- policies are guaranteed by WP26's own migration (slot 099 was freed from
-- WP20 and reserved for it), whatever happened to 098's seed.
--
-- Additive and re-runnable: MERGE ... WHEN NOT MATCHED THEN INSERT only, so a
-- policy that exists (an admin's edit, a switch flipped off) is never changed,
-- and running it twice does nothing the second time. Nothing is updated,
-- deleted or altered. It sits behind an existence check on the table, which
-- 098 creates. Applied after 101 on a database that already has 101, the
-- runner only warns that it is out of order; it depends on nothing after 098.

IF OBJECT_ID(N'dbo.EscalationPolicies', N'U') IS NOT NULL
BEGIN
  ;WITH Seed (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active) AS (
    SELECT * FROM (VALUES
      (N'rent_review.not_commenced', N'attention', 0, N'business', N'yes',
        N'[{"role":"accounts_manager","slaHours":40},{"role":"director","slaHours":40}]', 1),
      (N'rent_review.overdue', N'attention', 0, N'business', N'yes',
        N'[{"role":"accounts_manager","slaHours":16},{"role":"director","slaHours":40}]', 1),
      (N'rent_review.approval', N'authority', 0, N'business', N'yes',
        N'[{"role":"accounts_manager","slaHours":16},{"role":"cfo","slaHours":16},{"role":"director"}]', 1)
    ) AS v (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active)
  )
  MERGE dbo.EscalationPolicies AS target
  USING Seed AS source
    ON target.PolicyKey = source.PolicyKey
  WHEN NOT MATCHED BY TARGET THEN
    INSERT (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active, UpdatedBy)
    VALUES (source.PolicyKey, source.Kind, source.Urgent, source.Clock, source.AutoReescalate, source.Ladder, source.Active, N'migration:099_rent_review_policies');
END
GO
