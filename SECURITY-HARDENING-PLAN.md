# Application-Layer Security Hardening — Plan

**Companion to [`PRIVATE-SQL-MIGRATION-PLAN.md`](./PRIVATE-SQL-MIGRATION-PLAN.md).**
That plan addresses *infrastructure* security (network isolation of SQL). This plan
addresses *application* security — closing the realistic abuse vectors that VNet
/ private endpoints **don't** touch: token theft, over-broad authorization, SQL
injection, request abuse / cost spikes, secret exposure, webhook spoofing.

These items reduce the real risk of "the functions being abused" more directly
than locking SQL inside a VNet does. Most are cheap or free.

---

## Items, ordered by impact-per-effort

### 1. Verify (and tighten if needed) Entra Conditional Access policies *— biggest preventative control*
**Why:** Your app is gated by Entra-issued JWTs. If an attacker phishes/steals a
user's credentials, they get tokens. Conditional Access is the single strongest
control against that.

**Action:**
- Microsoft Entra admin center → Conditional Access → Policies.
- Confirm a policy **requires MFA** for all sign-ins (or at least for users of
  this app).
- Ideally also: require **compliant/managed device**; **block legacy auth**;
  **geo-restrict** (e.g. Australia + travel exceptions).
- Review who's exempt (break-glass accounts only).

**Cost:** free with your existing Entra ID licence (M365 Business Premium / P1 / P2).

### 2. Add per-user rate limiting in code
**Why:** Nothing currently caps how fast a single token can hit endpoints. A
simple per-user limit stops abuse, accidental loops, and runaway-cost incidents.

**Action:**
- Small middleware that caps requests/minute per token `sub` claim.
- In-memory map + TTL is sufficient at current scale (move to a shared store
  later if you scale to many instances).
- Apply it alongside `requireRole`. ~10–30 lines of code.

### 3. Audit authorization *scoping* (not just authentication)
**Why:** Every endpoint has `requireRole` (authN ✓). But does each *read*
endpoint scope data to what the user is allowed to see (their buildings/teams),
or does any authenticated role get *all* data? The latter is fine if
intentional — worth knowing for sure.

**Action:**
- Read a sample of read-heavy endpoints: `getRegisterTenants`, `getJobs`,
  `getBuildings`, `searchEverything`.
- For each: does the SQL filter by user/building scope, or return everything?
- Decide policy (all-staff-see-all vs scoped); fix any gaps.

### 4. Confirm SQL queries are 100% parameterised
**Why:** One concatenated SQL string anywhere = an injection bug.

**Action:**
- Grep `azure-functions/src` for any SQL built via `+` / template literal with
  user values / dynamic clauses without parameter binding.
- Confirm everything uses tedious/mssql parameters (CLAUDE.md mandates this —
  worth verifying coverage).

### 5. App Insights alerts on auth failures and anomalies
**Why:** You'll only notice abuse if you're watching for it. App Insights
captures every request; alerts surface unusual patterns.

**Action — create alert rules in Azure Monitor:**
- 401-response burst (e.g. > 50 in 5 min from one user/IP).
- Unusual request volume per token `sub`.
- Failed SQL dependency calls (could signal injection / probing).
- Email / Teams notification on trigger.

**Cost:** alerts are ~free at this volume.

### 6. Move secrets to Key Vault; rotate annually
**Why:** Secrets currently sit in app settings (`GRAPH_CLIENT_SECRET`,
`MYBUILDINGS_BEARER_TOKEN`, `WORDPRESS_APP_PASSWORD`). Anyone with management-
plane access to the function app can read them. Key Vault references hide them
and centralise rotation.

**Action:**
- Create a Key Vault in `rp-floorplan-rg`.
- Give the new Flex app's managed identity *Key Vault Secrets User* on it.
- Move each secret into Key Vault.
- In app settings, replace the raw value with
  `@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<name>)`.
- Schedule annual rotation of `GRAPH_CLIENT_SECRET` (and any others with rotation).

**Cost:** Key Vault Standard ~$0; ~$0.03 per 10k operations (negligible).

### 7. Verify the Graph webhook validation is strict
**Why:** `/api/graphNotification` is anonymous-callable (Microsoft Graph posts
to it). Its validation must be strict, or an attacker could spam it with fake
notifications.

**Action — read the `graphNotification` function and confirm it:**
- Validates `clientState` exactly equals `GRAPH_SUBSCRIPTION_CLIENT_STATE`.
- Validates the payload's `subscriptionId` is one *you* created.
- Handles the Graph validation handshake (echo `validationToken`) **only** for
  validation requests, not as a free way for anyone to get a 200.
- Ideally: HMAC / signed JWT-style validation for resource-data notifications
  if applicable.

---

## Suggested order

1. **Now, no code:** verify Conditional Access (item 1) + create App Insights
   alerts (item 5). Highest-ROI, nothing-changes-in-code wins.
2. **Soon, ~1 day of code:** items 2, 3, 4, 7 — rate limit, authorization audit,
   parameterised-query audit, webhook validation review.
3. **Later, small infra:** item 6 — Key Vault + secret rotation.

## How this relates to the SQL VNet work
- The SQL migration closes the **leaked-database-secret** hole.
- These items close the **stolen-token / over-broad-access / abuse-of-API**
  holes.
- They're complementary; neither replaces the other.
