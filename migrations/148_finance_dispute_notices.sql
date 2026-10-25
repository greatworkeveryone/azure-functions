-- WP55: finance inbox notices accompany the operational attribution dispute.
IF OBJECT_ID('dbo.EscalationPolicies', 'U') IS NOT NULL
BEGIN
  MERGE dbo.EscalationPolicies AS target
  USING (VALUES (N'finance.attribution_disputed'), (N'finance.variance_disputed')) AS source (PolicyKey)
  ON target.PolicyKey=source.PolicyKey
  WHEN NOT MATCHED THEN INSERT (PolicyKey,Kind,Urgent,Clock,AutoReescalate,Ladder,Active,UpdatedBy)
    VALUES (source.PolicyKey,N'attention',0,N'business',N'no',N'[{"role":"cfo"},{"role":"director"}]',1,N'migration:148');
END;
