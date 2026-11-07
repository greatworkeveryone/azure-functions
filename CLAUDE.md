# Azure Functions — Backend Rules

> Shared project context (tech stack, TypeScript rules, testing, security, Azure notes) is in the parent CLAUDE.md at `/Users/willmcdonald/Documents/CLAUDE.md`.

---

## Folder Structure

```
src/
  functions/        # Flat. Each file registers its triggers (app.http / app.timer);
                    # small endpoints get their own file, domain files (tenancy.ts,
                    # invoices.ts, emails.ts) register many. Tests colocate as *.test.ts
  __tests__/        # Cross-cutting, parity and docs tests, fixtures and test utils
  <domain>/         # Shared domain logic (email/, myob/, pdf/, ai/, access/, …)
  *.ts              # Top-level shared modules (db.ts, auth.ts, cors.ts, etc.)
                    # There is no src/shared/ and no src/lib/
migrations/         # SQL migration scripts, NNN_name.sql; runner src/migrate.ts
```

---

## Function Rules

- **Prefer one function per file** in `src/functions/`. About 29 domain files already register several endpoints (`tenancy.ts` 24, `emails.ts` and `invoices.ts` 13 each); add to one only when the endpoint belongs to that domain, never start a new bundle
- Register functions using the Azure Functions v4 Node.js programming model (`app.http(...)`)
- Keep functions lean — avoid heavy imports at module level (cold start impact). `exceljs`, `pdfkit` and `pdf-lib` load on first use through `loadExcelJS()` (`src/xlsx-load.ts`) and `loadPdfKit()` / `loadPdfLib()` (`src/pdf/pdfLibs.ts`); import only their types at module level (`import type`) and call the loader inside the handler
- Always export the handler function for testability (about 16 files, e.g. `attachments.ts` and `keys.ts`, don't; their tests take the handler from the mocked `app.http(...)` registration)

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

No data loss once Floorplan is live. Connor keeps the full rules in his own `~/.claude/rules/database-safety.md` (not in this repo, not on every machine); the ones that bite here are self-contained below:

- Production migrations are applied by hand: the app's SQL identity has no DDL rights, so startup only checks and warns. `npm run migrate` lists pending files; `npm run migrate -- --apply` applies them as the signed-in admin (`az login`); the staging Deploy workflow runs the same runner itself. Every NEW migration must be additive and idempotent (guard with `IF NOT EXISTS` / `COL_LENGTH` / `OBJECT_ID`); older ones are not all re-runnable and a few drop objects, so rely on `dbo.schema_migrations` applying each file once, never on re-running. Dry-run first on a restored copy (`npm run migrate -- --apply --target <server>/<copy>`). There is no default database.
- Destructive SQL (DROP TABLE/COLUMN, TRUNCATE, DELETE, ALTER COLUMN, sp_rename) goes in its own migration with a `-- DESTRUCTIVE: <reason> · approved by <person> <YYYY-MM-DD>` header, after copying the affected rows to a backup table. Never edit or renumber an applied migration.
- Archive, don't delete: business records get `ArchivedAt`/`ArchivedBy`. Hard deletes and `deleteBlob` calls live only at the reviewed call sites in `src/__tests__/db-safety-guards.test.ts`; adding one means reviewing it and editing that allowlist.
- Timers that delete or rewrite are off unless their flag equals `"true"`, select positively (exactly what may go), and log counts. New timers and blob deletes are listed in `src/__tests__/destructive-ops-inventory.test.ts`.
- Writes to workflow records (leases, rent reviews, escalations, schedules, tenancy, keys, MYOB controls, job decisions) carry a `ROWVERSION` (`expectedRowVersion`) and return 409 when stale; a new contended table gets the same column and check. Simple archive/status handlers use state guards (409) instead.

## Auth

- Import auth helpers from `auth.ts`
- Always check role claims before returning sensitive data or allowing mutations
- `requireRole` answers 403 to any caller who fails the gate (including no token or an invalid one) and 503 if the role lookup itself fails (retryable, never 403). 401 (`unauthorizedResponse`) is returned only by handlers that resolve the caller's identity themselves (actor/identity helpers, `moneyGate`)

## Error Handling

- Return structured JSON errors: `{ error: string }`
- Log unexpected errors before returning 500 — don't swallow them
- Never expose stack traces or internal SQL errors to the client

## External Clients

- MYOB: use `myob-client.ts`; every MYOB HTTP call goes through `myobRequest()` in `myob-api-log.ts` (the only place that may call `fetch`: it logs, allowlists and write-gates) — never call MYOB with fetch/axios from a function
- Microsoft Graph: `graph.ts` owns the app-only token (`getGraphToken`) plus the mail, subscription and group helpers; `planner.ts`, `teams/activity.ts` and `comms/graphSend.ts` build their own Graph calls on that token
- Blob storage: use `blob-storage.ts` (storage shared key, short-lived SAS URLs; no token refresh)
- Graph and MYOB refresh their own OAuth tokens; blob storage needs none

## Testing

- Tests are `*.test.ts` anywhere under `src/`: handler tests colocated in `src/functions/`, domain tests in their folder (`src/ai/`, `src/myob/`, …), cross-cutting, parity and docs tests in `src/__tests__/`
- Pure logic needs no mocks; anything touching the DB or an external client mocks it (`tedious`, `global.fetch`) — never hit real APIs or DB in unit tests
- Cover: happy path, missing auth, invalid input, external client failure
