# Azure Functions — Backend Rules

> Shared project context (tech stack, TypeScript rules, testing, security, Azure notes) is in the parent CLAUDE.md at `/Users/willmcdonald/Documents/CLAUDE.md`.

---

## Folder Structure

```
src/
  functions/        # One file per endpoint — HTTP triggers go here
  __tests__/        # Test files (colocated pattern also acceptable)
  shared/           # Shared utilities, DB helpers, auth
  *.ts              # Top-level shared modules (db.ts, auth.ts, cors.ts, etc.)
migrations/         # SQL migration scripts
```

---

## Function Rules

- **One function per file** in `src/functions/` — no combining multiple endpoints
- Register functions using the Azure Functions v4 Node.js programming model (`app.http(...)`)
- Keep functions lean — avoid heavy imports at module level (cold start impact)
- Always export the handler function for testability

## Input Validation

- Validate all request body fields before touching the DB
- Return `400` with a descriptive message for missing/invalid fields
- Never trust client-supplied IDs without verifying ownership via auth claims

## Database

- All queries go through `db.ts` — never open raw DB connections in function files
- Always use parameterised queries — never string concatenation in SQL
- Keep queries simple — Basic tier DB has limited DTUs; avoid heavy joins or full scans
- Wrap multi-step writes in a transaction

## Data Safety and Migrations

No data loss once Floorplan is live. The full rules are in Connor's `~/.claude/rules/database-safety.md`; the ones that bite here:

- Migrations run automatically at production startup (`functions/startup.ts` → `migrate.ts`, tracked in `dbo.schema_migrations`, filename order) and a failing one stops the API. Every migration is additive and idempotent; dry-run it on a restored copy of production before it merges to the deploy branch.
- Destructive SQL (DROP TABLE/COLUMN, TRUNCATE, DELETE, ALTER COLUMN, sp_rename) goes in its own migration with a `-- DESTRUCTIVE: <reason> · approved by <person> <YYYY-MM-DD>` header, after copying the affected rows to a backup table. Never edit or renumber an applied migration.
- Archive, don't delete: business records get `ArchivedAt`/`ArchivedBy`. Hard deletes and `deleteBlob` calls live only at the reviewed call sites in `src/__tests__/db-safety-guards.test.ts`; adding one means reviewing it and editing that allowlist.
- Timers that delete or rewrite are off unless their flag equals `"true"`, select positively (exactly what may go), and log counts.
- Writes to shared records carry a version and return 409 when stale.

## Auth

- Import auth helpers from `auth.ts`
- Always check role claims before returning sensitive data or allowing mutations
- 401 for unauthenticated, 403 for authenticated but unauthorised

## Error Handling

- Return structured JSON errors: `{ error: string }`
- Log unexpected errors before returning 500 — don't swallow them
- Never expose stack traces or internal SQL errors to the client

## External Clients

- MYOB: use `myob-client.ts` — never call MYOB APIs directly from a function
- Microsoft Graph: use `graph.ts`
- Blob storage: use `blob-storage.ts`
- All client modules handle their own auth token refresh

## Testing

- Tests live in `src/__tests__/`
- Mock DB and external clients — never hit real APIs or DB in unit tests
- Cover: happy path, missing auth, invalid input, external client failure
