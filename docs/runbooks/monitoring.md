# Monitoring: access patterns and the money-action gate

Contents: 1 what the app records · 2 settings (access log) · 3 confirm the
client address · 4 App Insights alert rules · 5 the money-action gate ·
6 Conditional Access (O7)

Owner: Will (Azure). Sprint packages S10 (access monitoring, decision 15) and
S11 (money-action gate, decision 16); the Azure side is O4/O7. Every change in
Azure below needs Connor's yes first.

## 1. What the app records

Every sign-in (`registerSelf`), every money action (S11's gate), the first
request per person per 15 minutes, and bursts (more than 300 requests in 5
minutes from one person on one instance) go to `dbo.AccessEvents` (migration
131). Each row is checked against the person's expected-use profile
(`AppUsers.AccessProfile`; NULL = role default: Darwin, 06:00–20:00, Mon–Sat,
AU, call-outs for facilities roles) and gets one of:

| Anomaly          | Rule                                                                                         |
|------------------|----------------------------------------------------------------------------------------------|
| `new_country`    | the browser's country hint (`x-fp-country`) is not in the profile's countries                 |
| `outside_window` | a money action, or any request by a non-director/non-admin without call-outs, outside the window |
| `new_device`     | user-agent hash not seen for that person in 90 days (the first device ever is a baseline)     |
| `burst`          | more than 300 requests in 5 minutes from one person (per instance)                            |

An anomaly also writes an `access.anomaly` exception to the decision ledger
(at most once per person and rule every 6 hours per instance) and one trace
line starting `[access] anomaly {json}` (no names, no addresses). Nothing is
blocked by S10.

The in-app country is the browser's claim. **App Insights' own geolocation of
the request is the source of truth for alerts** (rule A below). Neither is
trusted alone.

Admin → Users → Access profile edits a person's profile (admin only, ledgered
as `access.profile_change`). Admin → Recent sign-ins and anomalies shows the last
7 days, filterable by person (CFO, directors, admin).

**First thing after deploy:** set Connor's profile — time zone
`Europe/Copenhagen`, countries `DK, AU`, all days, hours to suit. Until then
every request he makes from Denmark is a `new_country` anomaly.

## 2. Settings

| Setting                 | Default            | Meaning                                                                                       |
|-------------------------|--------------------|-----------------------------------------------------------------------------------------------|
| `ACCESS_REPORT_ENABLED` | unset (off)        | `"true"` registers `accessReportTimer`: 07:00 Darwin daily, emails active `admin` and `cfo` users the last 24 h of anomalies, only when there were any. Needs Graph mail (`GRAPH_SENDER_EMAIL`). Honours `DEV_EMAIL_OVERRIDE`. |
| `ACCESS_LOG_ENABLED`    | on                 | `"false"` stops all access logging (the off switch if it ever misbehaves).                    |
| `ACCESS_HASH_KEY`       | built-in constant  | Key for the address and user-agent hashes. Set a random 32+ character secret (Key Vault reference). Without it an IPv4 hash can be reversed by brute force. Rotating it resets device history (90 days of `new_device` noise), so rotate only on a leak. |

## 3. Confirm the platform passes the client address (do this first, from the office)

The access log and the money gate read the client address from
`X-Forwarded-For`: the rightmost public address, skipping well-formed private
hops, so a caller cannot spoof it by sending their own header. It fails closed:
the first entry from the right that is not a readable address (`unknown`, an
IPv6 with an unbracketed port, an empty slot, a zone id) means "no address",
and the gate refuses. Flex Consumption should set the header; confirm:

1. From an office desktop, signed in as an admin, open
   `https://<api>/api/health?deep=true` (any admin token; the frontend's System
   panel or a REST client).
2. In App Insights → Logs:

   ```kusto
   traces
   | where timestamp > ago(30m)
   | where message startswith "health: client address headers"
   | project timestamp, message
   ```

3. Expect `{"clientIpHeader":…,"entries":1,"forwardedFor":true,"unreadable":0,"moneyNetwork":"unconfigured"}`.
   `forwardedFor:false` means the platform does not pass it: stop and tell the
   S11 owner (the money gate would refuse every money action once
   `MONEY_ALLOWED_CIDRS` is set). `entries` of 2 or more is fine; note it.
   `unreadable` above 0 means the platform writes an entry the gate cannot
   parse: stop and send the S11 owner the raw shape (not the address).
4. After setting `MONEY_ALLOWED_CIDRS` (section 5), repeat and record all four:

   | From                    | Extra header sent                          | `moneyNetwork` must read |
   |-------------------------|--------------------------------------------|--------------------------|
   | office desktop          | none                                       | `allowed`                |
   | phone on 5G             | none                                       | `refused`                |
   | phone on 5G             | `X-Forwarded-For: <office IP>` (forged)    | `refused`                |
   | office desktop          | `X-Forwarded-For: 192.0.2.1` (forged)      | `allowed`                |

   e.g. `curl -s -H "Authorization: Bearer <admin token>" -H "X-Forwarded-For: <office IP>" "https://<api>/api/health?deep=true"`.
   The two forged rows prove the platform puts its own entry to the right of
   anything the caller sends. If the forged 5G row reads `allowed`, the
   platform is passing the caller's header through: do **not** enable the
   gate; tell the S11 owner.
5. **Never put an Azure address in `MONEY_ALLOWED_CIDRS`** (Function App
   outbound IPs, `168.63.129.16`, Front Door or any Azure service range). An
   Azure hop that appears to the right of the client would then pass every
   request. Only the office egress and the approved remote-access egress go in.
6. Rule A below trusts `client_CountryOrRegion` on the `requests` table. Before
   relying on it, check one office request and one 5G request in App Insights:
   the country must be the browser's (Australia), not the Azure region of the
   Function App. If it shows the Azure region for every request, App Insights
   is geolocating the platform's address: rule A is then meaningless and only
   the in-app `new_country` rule (browser time-zone claim) applies until fixed.

## 4. App Insights alert rules

Create each as a log search alert on the Function App's Application Insights
resource, action group = email Will + Connor (O4). Evaluate every 15 minutes
over the last 15 minutes unless stated; alert when the result has any rows.

Darwin is UTC+09:30 all year; the rules shift `timestamp` by that.

### A. New country (severity 1) — source of truth

Requests from outside the countries anyone is expected in. App Insights
geolocates the request's client address at ingestion.

```kusto
requests
| where timestamp > ago(15m)
| where isnotempty(client_CountryOrRegion)
| where client_CountryOrRegion !in ("Australia", "Denmark")
| summarize requests = count(), functions = make_set(name, 10) by client_CountryOrRegion, client_City
```

Plus the in-app view (the browser's claim against each person's profile):

```kusto
traces
| where timestamp > ago(15m)
| where message startswith "[access] anomaly"
| extend a = parse_json(substring(message, strlen("[access] anomaly ")))
| where tostring(a.anomaly) == "new_country"
| project timestamp, userId = toint(a.userId), role = tostring(a.role), country = tostring(a.country)
```

### B. Money action outside the window (severity 1)

Any request to a gated money endpoint outside 06:00–20:00 Mon–Sat Darwin.
Keep the name list in step with `src/money-gated-routes.ts`.

```kusto
let gated = dynamic(["setApprovalLimit", "upsertPayment", "markPaymentPaid", "directorApproveJobInvoice",
  "markJobInvoiceMyobCreated", "unmarkJobInvoiceMyobCreated", "markPurchaseOrderMyobCreated", "unmarkPurchaseOrderMyobCreated",
  "submitRentReview", "approveRentReview", "waiveRentReview", "revertRentReview"]);
requests
| where timestamp > ago(15m)
| where name in (gated)
| extend darwin = timestamp + 9h + 30m
| where hourofday(darwin) < 6 or hourofday(darwin) >= 20 or dayofweek(darwin) == 0d
| project timestamp, darwin, name, resultCode, client_CountryOrRegion
```

### C. Burst (severity 2)

Per person, from the app (counted per instance):

```kusto
traces
| where timestamp > ago(15m)
| where message startswith "[access] anomaly"
| extend a = parse_json(substring(message, strlen("[access] anomaly ")))
| where tostring(a.anomaly) == "burst" or set_has_element(todynamic(a.alsoFlagged), "burst")
| project timestamp, userId = toint(a.userId), role = tostring(a.role)
```

Across all instances (the app cannot see this): more than 3,000 requests in any
5 minutes is far above pilot use.

```kusto
requests
| where timestamp > ago(15m)
| summarize n = count() by bin(timestamp, 5m)
| where n > 3000
```

### D. New device (severity 3, no page)

Daily digest material, not an alert; create it with a 24-hour window and a
once-a-day evaluation, or rely on the daily email (`ACCESS_REPORT_ENABLED`).

```kusto
traces
| where timestamp > ago(24h)
| where message startswith "[access] anomaly"
| extend a = parse_json(substring(message, strlen("[access] anomaly ")))
| where tostring(a.anomaly) == "new_device" or set_has_element(todynamic(a.alsoFlagged), "new_device")
| summarize events = count() by userId = toint(a.userId), role = tostring(a.role)
```

## 5. The money-action gate (S11, decision 16)

Money endpoints (today: `setApprovalLimit`, `upsertPayment`, `markPaymentPaid`,
`directorApproveJobInvoice`, `markJobInvoiceMyobCreated`,
`unmarkJobInvoiceMyobCreated`, `markPurchaseOrderMyobCreated`,
`unmarkPurchaseOrderMyobCreated`, and WP26's rent review decisions
`submitRentReview`, `approveRentReview`, `waiveRentReview`,
`revertRentReview`; lane M adds the
MYOB proposal, push, update and control routes — the list is
`src/money-gated-routes.ts`) require all of:

1. the request comes from an address in `MONEY_ALLOWED_CIDRS` → else **403
   `money_network_required`**; the frontend shows "Sending to MYOB is allowed
   only from the office network or the approved remote connection";
2. the sign-in is fresh: the token's `auth_time` (else `iat`) within
   `MONEY_STEP_UP_MINUTES` → else **428 `step_up_required`** and the frontend
   asks "Confirm it's you to send to MYOB", signs the person in again
   (`prompt=login`) and retries once;
3. MFA ran: the token's `amr` contains `mfa` → else 428 as above;
4. every attempt and its outcome is in the access log (`Kind = money`).

Inspections, keys and jobs are not gated, so phones keep working anywhere.

| Setting                  | Default     | Meaning                                                                                              |
|--------------------------|-------------|------------------------------------------------------------------------------------------------------|
| `MONEY_ALLOWED_CIDRS`    | unset       | Comma- or space-separated addresses/CIDRs, IPv4 or IPv6: the office's static egress from Area9 and the approved remote-access egress, e.g. `203.0.113.10/32, 198.51.100.0/29`. **Unset = warn-only**: nothing is refused, each would-be refusal is logged (`[money-gate] warn-only: …`) and `system.health` (subject `money_gate`) tells admin the gate is open; the sweep closes it once the setting exists. Set but unusable — unreadable, or wider than /8 (IPv4) or /32 (IPv6), e.g. `0.0.0.0/0` — the entry is ignored and `system.health` says so; with no usable entry left, every money action is refused (a typo never opens the gate). Never an Azure address (§3 step 5). |
| `MONEY_STEP_UP_MINUTES`  | `10`        | How recent the sign-in must be, 1–60 minutes.                                                         |

Order of work: Area9 supplies the static egress IP(s) → step 3 above from the
office shows `forwardedFor:true` → set `MONEY_ALLOWED_CIDRS` on staging, test
(office desktop can, 5G phone cannot, a sign-in older than 10 minutes is asked
to confirm) → production.

Freshness caveat: the gate reads the SQL-scoped access token. Azure SQL tokens
carry `iat` and `amr` but not `auth_time`, and MSAL can mint a new token from
its refresh token without the person signing in, so `iat` proves a fresh
*token*, not a fresh *sign-in*. Within the 10 minutes after any silent
refresh the step-up is skipped (network and MFA still apply). The proper fix
is a Conditional Access **authentication context** for money actions with
sign-in frequency "every time" (section 6, step 6), after which the gate can
require the context's `acrs` claim; until then this is the documented gap.

Trace lines for alerts and evidence:

```kusto
traces
| where timestamp > ago(1d)
| where message startswith "[money-gate]"
| project timestamp, message
```

## 6. Conditional Access (O7) — policy spec

Licence check first: Conditional Access needs Entra ID P1 (included in
Microsoft 365 Business Premium). Everything below is created in report-only
mode first, checked in the sign-in logs for a day, then switched on. Each
switch-on needs Connor's yes.

**Named locations**

- `RP office` — the office static egress IP(s) from Area9, marked trusted.
- `RP remote access` — the egress of the approved remote-access service, if
  Area9 provides one. The same addresses go into `MONEY_ALLOWED_CIDRS`.

**Groups**

- `Floorplan-MYOB` — Johanne and whoever may approve or push to MYOB.
- `Floorplan-BreakGlass` — one cloud-only emergency admin account, long random
  password in the safe, FIDO2 key, excluded from every policy below, sign-ins
  alerted to Will and Connor. Never used day to day.

**Policies** (target: the Floorplan app registration(s); exclude
`Floorplan-BreakGlass` from all)

1. `FP-01 Require MFA` — all users → grant: require MFA. No exclusions other
   than break-glass. Connor included.
2. `FP-02 Block legacy authentication` — all users, client apps: Exchange
   ActiveSync and other clients → block.
3. `FP-03 Block risky sign-ins` — all users, sign-in risk medium and high →
   block (or require MFA + password change if P2 is available).
4. `FP-04 Australia only` — all users **except Connor's account**, locations:
   any location except Australia (country named location) and `RP office` →
   block. Connor is exempt from geography only; FP-01 still applies to him.
5. `FP-05 MYOB group: office or compliant device` — group `Floorplan-MYOB`,
   locations: any location except `RP office` and `RP remote access` → grant:
   require device to be marked compliant (Intune). Off-site without a managed
   device, a member can still sign in for field work only if this policy is
   scoped to an authentication context (step 6); otherwise they cannot sign
   in off-site at all. Pick one with Connor before switching on.
6. (Hardening, after the pilot) `FP-06 Money actions need a fresh sign-in` —
   authentication context `c1 Money action`, grant: require MFA, session:
   sign-in frequency every time. The frontend then requests the context on
   step-up and the gate checks `acrs` contains `c1`.

**Evidence** (one page for the audit pack): policy names and states, and the
results of: a phone on 5G cannot send to MYOB (403, banner shown); an office
desktop can; Connor in Denmark can sign in but cannot send (network refused);
a sign-in older than 10 minutes is asked to confirm; the break-glass account
signs in and raises the alert.
