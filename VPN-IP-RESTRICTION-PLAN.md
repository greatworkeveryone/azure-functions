# Persistent Network Gating (Office / VPN IP Restriction) — Implementation Plan

> **For agentic workers:** This is an **infrastructure / Azure-config plan**, not a
> TDD code plan. Steps use checkbox (`- [ ]`) syntax for tracking. "Verification"
> steps replace unit tests because there is little-to-no application code to change —
> the control is enforced at the Azure platform edge. Most steps are `az` CLI
> commands the operator runs; a few are Azure Portal equivalents.

**Goal:** Make the VPN/office-network requirement persistent — block all access to
property data the moment a user leaves the trusted network, instead of only gating
sign-in.

**Architecture:** Today, the VPN is enforced only by an **Entra Conditional Access
named location** (sign-in only). Once Entra issues a JWT, the Azure Functions
validate it *offline* via `requireRole` and never check the caller's IP — so a token
keeps working off-network until it expires. This plan adds an **IP allow-list at the
Function App's inbound network layer**, so every request (not just sign-in) is
checked against the trusted public IP. Off-network requests are rejected by the
platform before they reach any handler.

**Tech Stack:** Azure Functions (Flex Consumption, `rp-floorplan-rg`), Azure access
restrictions (`ipSecurityRestrictions`), Entra ID JWT auth (unchanged), Next.js
browser-side API client (unchanged).

**Trigger condition (do not start until this is true):** The office (and/or VPN
egress) has a **static public IP / CIDR**. Confirm the exact value before Task 2.

---

## Why this is safe to do (pre-verified findings)

These were checked against the code on the planning date — re-confirm if the code has
moved on:

1. **The frontend calls the API from the browser, not server-side.**
   `command-centre/src/lib/api/azureFunctionsClient.ts` uses
   `NEXT_PUBLIC_AZURE_FUNCTIONS_URL`. Requests originate from the **user's browser**
   (on the office/VPN network). If it fetched server-side, the Next.js host's IP —
   not the user's — would hit the API, and IP-restriction would break the whole app.
   It does not, so this approach is viable. *(The only server-side proxy,
   `src/app/api/mybuildings/[...path]/route.ts`, targets the MyBuildings API, not our
   Functions — irrelevant here.)*

2. **Scheduled work is on timer triggers, not inbound HTTP.**
   `tenancyCpiSyncTimer`, `timesheetSyncTimer`, `tenancyReviewScheduleTimer`,
   `sqlKeepWarmTimer`, `plannerSyncTimer`, `cleanupAttachments`, `parseEmails` run
   *inside* the Functions runtime on a schedule. Access restrictions only affect
   inbound HTTP, so these are unaffected.

3. **`myobAuthCallback` is a browser redirect, not a server callback.**
   MYOB redirects the *user's browser* back to it during OAuth, so it arrives from
   the office/VPN network and needs no exemption.

4. **The two true external callers are already crypto-authenticated** (see the
   Decision below).

---

## THE KEY DECISION — how to keep the 2 external webhooks working

Azure Functions access restrictions are **app-wide** — there is no native per-route IP
rule. But two endpoints are legitimately called from *outside* the office network:

| Endpoint | Caller | In-app protection | If blocked |
|---|---|---|---|
| `POST /api/graphNotification` (`graphWebhook.ts`) | Microsoft Graph (server-to-server) | timing-safe `clientState` compare | **new email stops syncing** |
| `POST /api/myobWebhook` (`payments.ts`) | MYOB (server-to-server) | HMAC signature (`validateMyobWebhookSignature`) | payment "paid" status not auto-updated (manual "Mark as paid" still works) |

Both are **write-only triggers protected by a shared secret / HMAC** — so they are
safe to leave publicly reachable. Neither returns property data. The problem is purely
that an app-wide IP rule would also block *them*.

Microsoft Graph and MYOB do **not** publish a small, stable IP list, so allow-listing
their source IPs is not viable. Choose one architecture:

- **Option 1 — Split the 2 webhooks into a separate, public Function app *(RECOMMENDED)***
  - New tiny Flex Consumption app (e.g. `rpcc-webhooks`) in `rp-floorplan-rg`,
    deploying **only** `graphNotification` + `myobWebhook` (+ `setupGraphSubscription`
    if you want sub-renewal reachable; it's admin-triggered so it can stay on the main
    app instead).
  - Main app (`rpcc-functions` / `rpcc-api2`) gets the office-IP allow-list.
  - Re-point the Graph subscription `notificationUrl` and the MYOB webhook URL at the
    new app.
  - **Cost:** ~$0 idle on Flex Consumption. **Effort:** a trimmed build + one extra
    app + subscription URL update. No gateway, no monthly fee. Best fit for the
    project's cost ethos.

- **Option 2 — Put Azure Front Door or APIM in front, with path-based IP rules**
  - One Function app, locked to accept traffic only from the gateway. Gateway WAF/policy
    allows the office IP to **all** paths but allows anyone to `/api/graphNotification`
    and `/api/myobWebhook`.
  - **Cost:** Front Door Standard ≈ $35/mo (or APIM Consumption, pay-per-call + cold
    start). **Effort:** no code/deploy split, but a new always-on service + config.
  - Pick this only if you'd rather not run a second Functions deployment.

- **Option 3 — Single app, best-effort allow-list of Graph/MYOB IP ranges *(NOT recommended)***
  - Fragile: those ranges change without notice; email/payment sync will silently break
    when they do. Documented only so it's explicitly rejected.

> **Decision owner action:** pick Option 1 or 2 before executing. The tasks below are
> written for **Option 1** (recommended). If Option 2 is chosen, replace Task 4 with the
> gateway-specific steps (a separate addendum will be needed).

---

## File / resource map

This plan changes **infrastructure**, not source files, with one optional code touch:

- **Modify (Azure):** main Function App inbound access restrictions (add office allow rule).
- **Create (Azure, Option 1):** `rpcc-webhooks` Flex Consumption app + its app settings
  (`GRAPH_SUBSCRIPTION_CLIENT_STATE`, `MYOB_WEBHOOK_KEY`, DB connection settings, etc.).
- **Modify (Azure, Option 1):** Graph subscription `notificationUrl` + MYOB webhook URL.
- **Optional code (only if Option 1 needs a trimmed deploy):** a build/deploy config that
  publishes just the webhook functions to `rpcc-webhooks`. No business logic changes.
- **Modify (Azure, optional):** restrict the frontend host too (defence in depth).

No `requireRole` / handler logic changes — the JWT auth path is untouched.

---

## Task 1: Confirm the trusted IP and inventory current state

**Files/resources:** none changed — read-only discovery.

- [ ] **Step 1: Capture the static public IP/CIDR**

Get it from the office network provider, or from the existing Entra named location
(Entra admin center → Protection → Conditional Access → Named locations → your VPN/office
location → copy the IP range). Record the exact value, e.g. `203.0.113.42/32` or a CIDR.

- [ ] **Step 2: Identify which Function App is live**

Per `PRIVATE-SQL-MIGRATION-PLAN.md`: live backend is `rpcc-functions` (RG
`rp-floorplan-rg`); the migration target is a fresh Flex app (`rpcc-api2`). Apply this
plan to **whichever app the frontend's `NEXT_PUBLIC_AZURE_FUNCTIONS_URL` currently points
at.** Confirm:

Run:
```bash
az functionapp list -g rp-floorplan-rg --query "[].{name:name, sku:sku, state:state}" -o table
```
Expected: the live app listed; note its name + plan (Flex Consumption supports access restrictions).

- [ ] **Step 3: Record any existing access restrictions (so rollback is exact)**

Run:
```bash
az functionapp config access-restriction show -g rp-floorplan-rg -n <APP_NAME> -o json > /tmp/access-restrictions.before.json
```
Expected: current rules (likely "Allow all"). Keep this file for rollback (Task 7).

---

## Task 2: Stage the office allow-rule in a NON-production / test window

**Files/resources:** main Function App access restrictions (reversible).

> Do this when you can tolerate a brief access blip and you are physically on the office
> network, so you don't lock yourself out.

- [ ] **Step 1: Decide Option 1 vs Option 2 (see Decision section). Proceed assuming Option 1.**

- [ ] **Step 2: Add the office allow rule (this implicitly creates a "Deny all" default)**

Run (replace `<APP_NAME>` and `<OFFICE_CIDR>`):
```bash
az functionapp config access-restriction add \
  -g rp-floorplan-rg -n <APP_NAME> \
  --rule-name "office-static" --action Allow \
  --ip-address <OFFICE_CIDR> --priority 100
```
Expected: command returns the updated rule set including your Allow rule **and** an
auto-added implicit `Deny all` at priority 2147483647. Adding the first Allow rule is what
flips the app from "allow everything" to "deny everything except listed."

- [ ] **Step 3 (Verification): From ON the office network, confirm the API still answers**

Run (from an office-network machine):
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<APP_NAME>.azurewebsites.net/api/health
```
Expected: `200`.

- [ ] **Step 4 (Verification): From OFF the network, confirm it is now blocked**

Run (from a phone hotspot / non-office connection, or ask a remote colleague):
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<APP_NAME>.azurewebsites.net/api/health
```
Expected: `403` (Azure "Ip Forbidden"). **This is the whole point** — off-network = no
access, even with a valid token.

- [ ] **Step 5 (Verification): Confirm a real authenticated call is also gated**

From off-network, with a still-valid bearer token in hand, call a data endpoint:
```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer <VALID_TOKEN>" \
  https://<APP_NAME>.azurewebsites.net/api/getBuildings
```
Expected: `403` from the platform (the request never reaches `requireRole`). Previously
this returned `200` — that gap is now closed.

---

## Task 3: Confirm deployment (CI/CD) still works under the restriction

**Files/resources:** the app's SCM/deployment path + your GitHub Actions workflow.

> Access restrictions can also gate the SCM (Kudu) site, which CI uses to deploy. Verify
> deploys still succeed, or you'll be unable to ship.

- [ ] **Step 1: Check whether SCM inherits the main-site restriction**

Run:
```bash
az functionapp config access-restriction show -g rp-floorplan-rg -n <APP_NAME> \
  --query "scmIpSecurityRestrictionsUseMain" -o tsv
```
Expected: `true` or `false`. If `true`, SCM now denies non-office IPs too — GitHub-hosted
runners will be blocked.

- [ ] **Step 2: Keep deploys working — choose the lowest-risk path for your setup**

  - **Preferred (Flex Consumption):** Flex deploys go through the **control plane /
    deployment storage**, not the Kudu SCM site, so site IP rules typically don't block
    them. Verify by running a deploy (Step 3) before changing anything.
  - **If deploys are blocked:** either (a) decouple SCM from the main rule and leave SCM
    open *only* to your CI by allowlisting the GitHub Actions IP ranges (large, changes —
    least ideal), or (b) deploy from a self-hosted runner on the office network, or (c)
    use OIDC + `az functionapp deployment` from a job whose egress IP you allowlist.

To decouple SCM from the main-site rule (only if needed):
```bash
az functionapp config access-restriction set -g rp-floorplan-rg -n <APP_NAME> \
  --use-same-restrictions-for-scm-site false
```

- [ ] **Step 3 (Verification): Trigger a no-op deploy and confirm success**

Push a trivial commit (or re-run the deploy workflow) and confirm the GitHub Actions
deploy job succeeds and `/api/health?deep=true` (admin token, on-network) reflects the new
`BUILD_SHA`.

Run (on-network, admin token):
```bash
curl -s -H "Authorization: Bearer <ADMIN_TOKEN>" \
  "https://<APP_NAME>.azurewebsites.net/api/health?deep=true"
```
Expected: JSON with the new `commit` value.

---

## Task 4: Keep the external webhooks alive (Option 1 — separate public app)

**Files/resources:** new `rpcc-webhooks` Flex app + Graph/MYOB subscription URLs.

> Skip this entire task and its sub-steps if you chose Option 2 (gateway). Without this,
> email + MYOB payment sync break the moment Task 2's rule is live.

- [ ] **Step 1: Create the public webhooks app**

Run:
```bash
az functionapp create -g rp-floorplan-rg -n rpcc-webhooks \
  --flexconsumption-location <REGION> --runtime node --runtime-version 22 \
  --storage-account <STORAGE_ACCT> --os-type Linux
```
Expected: app created. Leave it **without** access restrictions (public).

- [ ] **Step 2: Copy the secrets the webhooks need into the new app**

The two handlers read: `GRAPH_SUBSCRIPTION_CLIENT_STATE`, `GRAPH_MAILBOX_DEV`,
`MYBUILDINGS_BEARER_TOKEN` (graphNotification's downstream parse), `MYOB_WEBHOOK_KEY`,
plus DB connection settings used by `createServiceConnection` / `SYSTEM_DB_TOKEN`.
Mirror them from the main app:
```bash
az functionapp config appsettings list -g rp-floorplan-rg -n <APP_NAME> -o json \
  > /tmp/main-appsettings.json
# Set the needed subset on rpcc-webhooks:
az functionapp config appsettings set -g rp-floorplan-rg -n rpcc-webhooks --settings \
  GRAPH_SUBSCRIPTION_CLIENT_STATE="..." MYOB_WEBHOOK_KEY="..." GRAPH_MAILBOX_DEV="..." \
  MYBUILDINGS_BEARER_TOKEN="..." <DB_SETTINGS...>
```
Expected: settings applied. (Prefer Key Vault references per hardening-plan item 6.)

- [ ] **Step 3: Deploy only the webhook functions to `rpcc-webhooks`**

Produce a build that registers **only** `graphNotification` and `myobWebhook`
(`app.http(...)` for those two). Simplest reliable approach: a dedicated entry point /
`functionAppScriptFile` or a separate `funcignore`/build target that excludes all other
`app.http`/`app.timer` registrations. Deploy it to `rpcc-webhooks`. The rest of the
codebase (db, `myob-client`, `graph`) ships as supporting modules but no other routes are
registered.

- [ ] **Step 4 (Verification): Confirm the webhook app answers publicly**

From OFF the office network:
```bash
# Graph validation handshake echoes the token back as plain text:
curl -s "https://rpcc-webhooks.azurewebsites.net/api/graphNotification?validationToken=ping"
```
Expected: body `ping`, HTTP 200 — proves Graph can still reach validation off-network.

```bash
# A data route must NOT exist on this app:
curl -s -o /dev/null -w "%{http_code}\n" https://rpcc-webhooks.azurewebsites.net/api/getBuildings
```
Expected: `404` (route not registered) — confirms no data is exposed publicly.

- [ ] **Step 5: Re-point Microsoft Graph subscription at the new app**

Update the subscription's `notificationUrl` to
`https://rpcc-webhooks.azurewebsites.net/api/graphNotification`. Use your existing
`setupGraphSubscription` / renewal path (point its configured base URL at the webhooks
app), or patch the live subscription via Graph. Confirm Graph sends and accepts the
validation POST (Step 4 proves the endpoint behaves).

- [ ] **Step 6: Re-point the MYOB webhook URL**

In the MYOB webhook configuration, set the target to
`https://rpcc-webhooks.azurewebsites.net/api/myobWebhook`. Confirm the HMAC secret
(`MYOB_WEBHOOK_KEY`) matches the value set in Step 2.

- [ ] **Step 7 (Verification): End-to-end webhook smoke test**

  - Send a test email to the monitored mailbox → confirm it appears (Graph notification →
    webhooks app → sync). 
  - Trigger / simulate a MYOB payment event → confirm the payment flips to "paid".

---

## Task 5 (Optional, recommended): Restrict the frontend host too

**Files/resources:** the Next.js hosting app's access restrictions.

> The API restriction already blocks all *data*. Restricting the frontend adds defence in
> depth (off-network users can't even load the app shell) and a clearer UX (they see
> "can't reach site" rather than a logged-in app that 403s every call).

- [ ] **Step 1: Identify the frontend host** (Azure Static Web Apps / App Service / other)

Run:
```bash
az staticwebapp list -o table; az webapp list -o table
```
Expected: locate the command-centre frontend resource.

- [ ] **Step 2: Apply the same office allow rule to the frontend**

For App Service: same `az ... access-restriction add` command as Task 2, targeting the web
app. For Static Web Apps: configure IP restrictions via the SWA config
(`staticwebapp.config.json` `networking.allowedIpRanges`) or front it with the same policy.

- [ ] **Step 3 (Verification):** On-network → site loads (`200`); off-network → blocked.

---

## Task 6 (Verification): Full off-network lockout drill

**Files/resources:** none — acceptance test of the whole change.

- [ ] **Step 1:** On the office network, sign in normally and use the app end-to-end. Expected: works.
- [ ] **Step 2:** Stay signed in, **disconnect from the office network/VPN**, keep the same browser session/token.
- [ ] **Step 3:** Reload / navigate. Expected: API calls now return `403`; the app cannot load data. **This is the bug fixed** — previously this kept working.
- [ ] **Step 4:** Confirm email sync + MYOB payment sync still function (they route through the public webhooks app). Expected: unaffected.
- [ ] **Step 5:** Reconnect to the office network. Expected: full access restored within one token refresh.

---

## Task 7: Rollback plan (keep ready throughout)

**Files/resources:** main Function App access restrictions.

- [ ] **Step 1: If users are wrongly locked out, remove the office rule (reverts to allow-all)**

Run:
```bash
az functionapp config access-restriction remove -g rp-floorplan-rg -n <APP_NAME> \
  --rule-name "office-static"
```
Expected: rule removed; with no Allow rules left, the app returns to accepting all IPs.

- [ ] **Step 2: Or restore the exact prior state captured in Task 1**

Re-apply rules from `/tmp/access-restrictions.before.json` (recreate each rule with
`az functionapp config access-restriction add`), or in the Portal: Networking → Access
restriction → delete the office rule.

- [ ] **Step 3:** If Option 1 webhooks misbehave, temporarily re-point Graph/MYOB back at
the main app **and** remove the main-app restriction (Step 1) until resolved — never leave
the restriction on with webhooks pointing at the restricted app.

---

## Open decisions / risks to resolve before execution

1. **Option 1 vs Option 2** for the webhooks (cost vs deploy complexity) — owner decision.
2. **Exact static IP/CIDR** — must be confirmed stable; a dynamic "static-ish" IP will
   cause intermittent lockouts (this is why we wait for a genuinely static office IP).
3. **VPN egress vs office IP** — if remote staff use the VPN and on-site staff use the
   office line, **both** public IPs must be in the allow-list. Add a second Allow rule
   (priority 110) for the VPN egress IP.
4. **CI/CD deploy path** (Task 3) — verify before relying on it.
5. **Token lifetime** — even after lockout, an already-loaded SPA tab makes no *new*
   successful calls off-network; there's no extra revocation needed because the platform
   rejects every request. (If you later want sign-in-location revocation too, that's
   Entra Continuous Access Evaluation — out of scope here.)

---

## How this relates to existing plans

- `SECURITY-HARDENING-PLAN.md` item 1 (Conditional Access) gates **sign-in**; this plan
  gates **every request** — complementary, not a replacement.
- `PRIVATE-SQL-MIGRATION-PLAN.md` isolates **SQL**; this isolates the **API surface**.
  If executed around the same time, apply this plan to the new Flex app (`rpcc-api2`) once
  it's live, not the retiring Y1 app.
