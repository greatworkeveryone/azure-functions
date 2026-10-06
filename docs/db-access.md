# Database access model

Handlers connect to Azure SQL as the app's service principal
(`RP Command Centre`), via `createRequestConnection()` in `src/db.ts` —
never as the signed-in user.

**Authorisation is `requireRole` against `dbo.AppUsers`.** It is not the SQL
grant. SQL grants are uniform for every caller: there is no row-level security,
no `SESSION_CONTEXT`, no `SUSER_NAME()` filtering, and server auditing is off.
A per-caller connection therefore enforced nothing, while requiring a contained
database user per person — a manual step that, when missed, made every screen
return 500 while login still worked (login uses the service connection).

That is exactly what happened in September 2026: two directors could sign in
but every data screen 500'd, because `sys.database_principals` contained one
human and two service principals, and neither director was among them.

## Onboarding a new user

1. Admin invites them in Floorplan (Admin → Users), or they sign in once and
   `registerSelf` creates a Pending row with `Role = NULL`.
2. Admin assigns a role. That is the whole process.

**No SQL step. Do not create database users for people.**

## The three connection helpers

| Helper | Identity | Shape | Use for |
|---|---|---|---|
| `createRequestConnection(token)` | service principal | fresh per call | all HTTP handler data access |
| `createServiceRequestConnection()` | service principal | fresh per call | handlers with no caller identity — webhooks |
| `createServiceConnection()` | service principal | **singleton** | timers and role lookups only |
| `createConnection(token)` | whatever token you pass | fresh per call | low-level primitive — `db.ts` internal only |

Use `createServiceRequestConnection()` rather than `createServiceConnection()`
for anything internet-reachable: it takes no user token, so the rollback lever
below cannot redirect it to a caller identity that does not exist.

`createServiceConnection()` returns a singleton, and a tedious `Connection`
cannot serve concurrent `Request`s. Do not route handler traffic onto it —
`auth.ts` already carries in-flight de-duplication written after that exact
collision surfaced as spurious 403s. `createRequestConnection()` deliberately
returns a fresh connection so handler concurrency is unchanged.

`src/__tests__/no-user-connection.test.ts` fails the build if a handler calls
`createConnection()` directly again.

## Authorisation is now the ONLY gate

Before this change, passing the caller's token to Azure SQL meant SQL validated
it end to end — signature, expiry, issuer. A forged bearer token failed at the
connect handshake. **That safety net is gone.** Every handler must therefore
reach `requireRole` (or `rolesForRequest`, which runs `verifyEntraToken`) before
it touches data. A bare `if (!token) return unauthorizedResponse()` is a
presence check, not authentication, and is no longer sufficient on its own.

`getFeatureFlags` and `getProcedures` were relying on exactly that and were
gated with `requireRole(request, [AppRole.USER])` as part of this migration.

## Rollback

`SQL_USER_CONNECTION=true` restores per-caller connections. Every user then
needs `CREATE USER [x] FROM EXTERNAL PROVIDER` plus `db_datareader` and
`db_datawriter`. Kept as a lever only — no redeploy needed to flip it.

Two things the lever does **not** cover:

- `myobWebhook` in `payments.ts` is deliberately outside it. It previously read
  a long-lived `SYSTEM_DB_TOKEN` app setting and silently returned
  `{ processed: 0 }` whenever that was unset, so there is no old behaviour worth
  restoring.
- Three jobs pass `MYBUILDINGS_BEARER_TOKEN` — a static myBuildings API key, not
  an Entra SQL token — where a SQL token is expected:
  `syncAllWorkRequests.ts`, `parseEmails.ts` and `graphWebhook.ts`. Under the
  service identity the argument is ignored and they work. Flipping the lever
  re-breaks them at the connect handshake. See the note below.

## Open item: three jobs that never actually ran

`syncAllWorkRequestsTimer`, `parseEmailsDailyRetry` and `graphNotification`
hand `MYBUILDINGS_BEARER_TOKEN` to a parameter expecting an Entra SQL token.
`cleanupAttachments.ts` carries a comment from a previous fix of this same bug
class. Because that key was never a valid SQL token, all three failed at the
connect handshake inside a try/catch that logs and moves on — they have been
silently no-ops.

After this migration the token argument is discarded, so **they will begin
running for real on the next tick.** That is probably desirable, but it is a
behaviour change, not a refactor, and `syncAllWorkRequests` falls through to a
two-year backfill window on its first successful run because
`MIN(WRsLastSyncedAt)` is NULL everywhere. Decide deliberately before the first
02:00 UTC tick after deploy.

## If auditing is ever turned on

Server auditing is currently `Disabled`. If it is enabled and per-user
attribution is wanted, do NOT go back to per-caller connections — stamp the
caller's OID on writes at the application layer instead, as the
`CreatedById` / `LastModifiedBy` columns already do.
