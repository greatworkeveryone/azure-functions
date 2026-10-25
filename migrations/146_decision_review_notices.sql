-- Decisions 7/23: durable in-app notices, without external email sends.
IF OBJECT_ID('dbo.EscalationPolicies', 'U') IS NOT NULL
BEGIN
  MERGE dbo.EscalationPolicies AS target
  USING (VALUES
    (N'job.director_proxy_decline', N'[{"role":"director"}]'),
    (N'tenancy.manual_rent_reduction', N'[{"role":"accounts_manager"},{"role":"cfo"},{"role":"director"}]')
  ) AS source (PolicyKey, Ladder) ON target.PolicyKey=source.PolicyKey
  WHEN NOT MATCHED THEN INSERT (PolicyKey, Kind, Urgent, Clock, AutoReescalate, Ladder, Active, UpdatedBy)
    VALUES (source.PolicyKey, N'attention', 0, N'business', N'no', source.Ladder, 1, N'migration:146');
END;
