# security-guidance review rules — azure-functions (rpcc-functions backend)

Context: Azure Functions (Node) talking to Azure SQL as the signed-in user. Every handler must call `requireRole` (admin > director > operational roles; `[USER]` = any authenticated caller) before touching data, including GET reads. Roles come from the `AppUsers` table via `/registerSelf`; `X-App-Token` is ignored.

Ignore:
- `*.test.ts`, `__tests__/**`, `migrations/*.sql` numbering/style
- Parameterised `mssql` queries (`request.input(...)` + `@param`) — these are the accepted pattern

Do flag (high priority):
- A handler in `src/functions/**` with no `requireRole` call, or one whose allowlist is wider than the frontend `CAPABILITY_ROLES` map implies
- SQL built by string concatenation or template literals with user input
- `oidFromToken` / `userInfoFromToken` used for authorisation or in a service-connection write — only `verifiedIdentityFromRequest` is acceptable there
- Any new use of `ExcelJS.stream` / `WorkbookWriter` in `src/functions/keys.ts` (loads the `archiver` subtree, see SECURITY-NOTES.md)
- Secrets or connection strings in source; anything logged that includes a bearer token or email body
- Blob URLs returned without an expiry / SAS scope, or attachment hosts outside `ATTACHMENT_ALLOWED_HOSTS`
- New npm dependency that is not exact-pinned, or `npm audit fix` suggested as a remedy (forbidden here)
