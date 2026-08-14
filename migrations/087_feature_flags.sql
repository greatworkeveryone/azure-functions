-- Migration 087: FeatureFlags — staged-rollout gates, one row per (feature, role).
--
-- Read by getFeatureFlags (any signed-in user), written by upsertFeatureFlag
-- (admin only). A missing row is NOT an error: the frontend falls back to the
-- code default in command-centre src/constants/features.ts, which describes
-- the app as it behaves today. The table only needs rows for roles being
-- actively staged — never the full matrix.
--
-- The seed below encodes wave 1 of BOTH rollout tracks (Facilities and
-- Accounts run concurrently). admin and director are deliberately unseeded:
-- no row means code default, so they keep full visibility and cannot lock
-- themselves out of the Admin → Features console that edits this table.
-- Re-runnable: MERGE, not INSERT.

IF OBJECT_ID('dbo.FeatureFlags', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.FeatureFlags (
        FeatureKey  NVARCHAR(64)  NOT NULL,
        RoleName    NVARCHAR(64)  NOT NULL,
        Visibility  NVARCHAR(16)  NOT NULL,
        UpdatedAt   DATETIME2(0)  NOT NULL CONSTRAINT DF_FeatureFlags_UpdatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedBy   NVARCHAR(256) NULL,
        CONSTRAINT PK_FeatureFlags PRIMARY KEY (FeatureKey, RoleName),
        CONSTRAINT CK_FeatureFlags_Visibility
            CHECK (Visibility IN ('enabled', 'preview', 'hidden'))
    );
END
GO


-- Seed: wave 1 of BOTH tracks, which run concurrently — Facilities and
-- Accounts share no people and no wave-1 modules, so neither waits on the other.
--
--   Track A, Facilities:  Inspections + Keys live; Jobs + Maintenance as "Soon"
--   Track B, Accounts:    Tenancy Schedule live;   Jobs + Vacancies as "Soon"
--   Everything else       → off for the operational roles until its turn
--
-- "Soon" is deliberate: the tab is visible with a chip and opens a skeleton of
-- the real layout, so by the time a module switches on nobody has to find it.
--
-- admin and director are deliberately absent: no rows means the code defaults
-- apply, so Connor and Virgil keep full visibility and can never lock
-- themselves out of the console that controls this table.
--
-- Re-runnable: MERGE, not INSERT.


;WITH Seed(FeatureKey, RoleName, Visibility) AS (
    SELECT * FROM (VALUES
        -- Facilities: field work first.
        ('inspections',      'facilities',           'enabled'),
        ('inspections',      'facilities_manager',   'enabled'),
        ('keys',             'facilities',           'enabled'),
        ('keys',             'facilities_manager',   'enabled'),
        ('jobs',             'facilities',           'preview'),
        ('jobs',             'facilities_manager',   'preview'),
        ('maintenance',      'facilities',           'preview'),
        ('maintenance',      'facilities_manager',   'preview'),
        ('incoming',         'facilities',           'hidden'),
        ('incoming',         'facilities_manager',   'hidden'),
        ('quotes',           'facilities',           'hidden'),
        ('quotes',           'facilities_manager',   'hidden'),
        ('activity',         'facilities',           'hidden'),
        ('activity',         'facilities_manager',   'hidden'),
        ('timesheets',       'facilities',           'hidden'),
        ('timesheets',       'facilities_manager',   'hidden'),
        ('payroll',          'facilities_manager',   'hidden'),

        -- Accounts: tenancy schedule, data entry only.
        -- ⚠ Confirm /getRegisterTenants returns rows in production BEFORE
        --   running this. The register v2 handlers are marked "not yet
        --   implemented" client-side; if they 404, drop this to 'preview' and
        --   let Track A proceed without Track B.
        ('tenancySchedule',  'accounts',             'enabled'),
        ('tenancySchedule',  'accounts_manager',     'enabled'),
        ('tenancyVacancies', 'accounts',             'preview'),
        ('tenancyVacancies', 'accounts_manager',     'preview'),
        ('jobs',             'accounts',             'preview'),
        ('jobs',             'accounts_manager',     'preview'),
        ('maintenance',      'accounts',             'hidden'),
        ('maintenance',      'accounts_manager',     'hidden'),
        ('incoming',         'accounts',             'hidden'),
        ('incoming',         'accounts_manager',     'hidden'),
        ('quotes',           'accounts',             'hidden'),
        ('quotes',           'accounts_manager',     'hidden'),
        ('activity',         'accounts',             'hidden'),
        ('activity',         'accounts_manager',     'hidden'),
        ('timesheets',       'accounts',             'hidden'),
        ('timesheets',       'accounts_manager',     'hidden'),
        ('payroll',          'accounts_manager',     'hidden'),

        -- Plain user: signed in, nothing operational yet.
        ('activity',         'user',                 'hidden'),
        ('jobs',             'user',                 'hidden'),
        ('maintenance',      'user',                 'hidden'),
        ('incoming',         'user',                 'hidden'),
        ('quotes',           'user',                 'hidden'),
        ('timesheets',       'user',                 'hidden')
    ) AS v(FeatureKey, RoleName, Visibility)
)
MERGE dbo.FeatureFlags AS target
USING Seed AS source
    ON target.FeatureKey = source.FeatureKey
   AND target.RoleName   = source.RoleName
WHEN NOT MATCHED BY TARGET THEN
    INSERT (FeatureKey, RoleName, Visibility, UpdatedBy)
    VALUES (source.FeatureKey, source.RoleName, source.Visibility, 'migration:001_feature_flags');
GO
