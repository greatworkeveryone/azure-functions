# Production switches

Every opt-in behaviour Will controls in production. Read from the code on
`sprint/integration` on 17 Oct 2026. A switch is on only when its value is
exactly `"true"`, unless the table says otherwise. Every change in Azure needs
Connor's yes first. `/api/health?deep=true` lists missing settings.

Turn on anything with a dry-run partner the same way: dry run, read the log,
then the real switch.

## App settings (rpcc-api2)

| Setting | Default | What it does | Turn on when |
| --- | --- | --- | --- |
| `MYOB_WRITES_ENABLED` | off | Master switch for MYOB writes. Johanne's `MyobControls` row must also allow the operation, and the record must not be test data | Johanne signs off |
| `ATTRIBUTED_APPROVAL_ENABLED` | off | When `"true"`, a plain facilities officer may approve a quote within their own approval limit by declaring they discussed it with a manager and naming one (facilities manager, accounts manager, CFO or director; never admin or whoever added the quote). The manager is told and can say "I didn't agree to this". Off: facilities can't approve quotes at all, and an attribution sent is ignored | Only after Connor lifts beta-sprint decisions 1 and 9, and after review 117's R3/D1 fixes ship |
| `EMAIL_REPLY_DECISIONS_ENABLED` | off | Lets a director approve or decline by replying to an email | Leave off: decisions happen in the app |
| `ESCALATION_SWEEP_ENABLED` · `_DRY_RUN` | off | The 30-minute sweep raises, moves up and ends escalations, and emails them. It also sends a decision request's scheduled reminders and moves an unanswered one up to the raiser's manager at its deadline (an Urgent one only if the raiser ticked "move up if no answer"; it is reminded at 24 hours either way, and an Emergency is never chased). Nothing is reminded or escalated while it is off (the first email, at ask time, does not need it) It also asks a deferred decision again on its day (once); in dry run it logs 'would ask job #N again' | After a dry run |
| `ESCALATION_HOLIDAYS` | unset: no holidays | Darwin public holidays, `YYYY-MM-DD`, comma-separated. The SLA clocks and the decision-request tiers skip them (weekends are always skipped). A bad entry is ignored and logged | Keep the list current for the year |
| `DEV_EMAIL_OVERRIDE` | unset | Every outgoing escalation and decision-request email goes to this one address instead of the people asked | Dev and staging only; never in production |
| `DIGEST_ENABLED` · `_DRY_RUN` | off | The morning digest email, 07:30 Darwin on business days, to a person only when something needs them. Needs migrations 132 (opt-out) and 143 (`AppUsers.DigestLastSentOn`). Once per person per Darwin day: each person is stamped the moment their email has gone and a run skips anyone stamped today, so a restart inside the morning or a run that died part-way tells nobody twice (the log line counts them as `alreadySent`). A dry run reads the stamps and writes none. With `DEV_EMAIL_OVERRIDE` set the stamp is neither read nor written, so staging can send the same morning again. To resend one person today, set their `DigestLastSentOn` to NULL by hand | After a dry run, with 143 applied first |
| `RENT_REVIEW_GENERATOR_ENABLED` · `_DRY_RUN` | off | Creates and moves rent reviews (WP25). Each live run also raises E1/E2, re-raises a lost E3 at the rung it reached, and writes the RentPerAnnum cache of a review applied ahead of its date once the date comes (WP26); at most `ESCALATION_SWEEP_MAX_ACTIONS` escalations a run. Pair with the Rent reviews flag | After a dry run |
| `LEASE_EVENTS_GENERATOR_ENABLED` · `_DRY_RUN` | off | The daily `leaseEventsGeneratorTimer` (02:30 UTC, 12:00 in Darwin; WP32, WP33) opens a lease's option event 90 days before its notice window, opens the window on its day, warns the accounts manager 30 days before the deadline (`lease.option_deadline`), lapses an option whose deadline passed with no notice (`lease.option_lapsed` to the directors), and refers a lease with no option left to the directors at 180 days to expiry (`lease.renewal`, holdovers included). Positive selection: current or holdover tenancies, not archived, not test data, with an expiry; a window that closed before the timer ever saw it raises no lapse (its expiry goes to the directors as a renewal). Needs migration 106. The dry run (wins over ENABLED) logs and counts what it would do and writes nothing; off, it writes only its `TimerRuns` row. Recording, approving and rejecting notices work without it (recording opens the option event), and a director can decide a renewal from the tenancy without a referral (the decision opens it). Pair with the `leaseEvents` flag | After a dry run: the first live run refers every lease already inside 180 days of expiry |
| `LEASE_EVENTS_GENERATOR_MAX_ACTIONS` | 50 | Most writes one generator run makes, soonest date first; the rest wait for the next day's run (the log and `TimerRuns.Counts.deferred` say how many) | Leave at 50 |
| `REVIEW_WINDOW_DAYS` | 60 | Days before its date a scheduled rent review becomes due | Leave at 60 |
| `REVIEW_SANITY_MIN_PERCENT` · `_MAX_PERCENT` | −5 · 15 | A review whose % falls outside the band needs a second person (C5); a director can override with a reason. A value that isn't a % from −100 to 100, or a min above the max, falls back to the default | Leave as is |
| `REVIEW_WORKFLOW_LIVE_FROM` | unset | `YYYY-MM-DD` the workflow went live: reviews dated on or after it are settled only by the workflow, earlier ones by their keyed schedule row From WP26c, an unresolved review row dated on or after it shows as pending (awaiting review) on the schedule until a review applies it | The day WP25/WP26 go live (gate B) |
| `CPI_SYNC_ENABLED` · `_DRY_RUN` | off | Daily ABS CPI sync into `CpiIndex`; then CPI reviews waiting for their index come back in progress, calculated, even when the ABS fetch fails (WP26) | After a dry run |
| `CONTRACTOR_RANKER` | `rules` | Which ranker orders the contractor suggestions (the Suggested group when someone picks a contractor to ask for a quote or to assign). Only `rules` is registered: a transparent points ranker (`src/contractorSuggestions/rulesRanker.ts`) whose weights and reasons are in that file. A value that names nothing registered falls back to `rules` and logs a warning, so a typo cannot switch suggestions off or change who is suggested. This is not an on/off switch: the module is the `contractorSuggestions` flag below, and the setting only chooses between rankers. Every set is logged with its ranker version, so a new ranker is judged against `rules@1` from the log (`scripts/eval-contractor-ranker.cjs`) | Leave unset. Set it to a learned or LLM ranker only after that ranker has beaten `rules@1` offline |
| `PLANNER_SYNC_ENABLED` | off | Microsoft Planner sync, being retired. The only Planner switch: every path that creates, updates or completes a Planner task checks it first, whatever else is set. Until 17 Oct `APP_BASE_URL` doubled as the switch (setting it turned task creation back on through every job save), which is why production kept `APP_BASE_URL` unset and the director approval email went out with no link (jobs-flow N14). That coupling is gone | Leave off |
| `APP_BASE_URL` | unset: emails have no links | Links only: the director approval email, escalation and decision-request emails and the morning digest link to the record and step they are about (`/jobs?jobId=12&step=quotes`). It switches nothing on, Planner included | Set it with this release, on Connor's yes: `https://floorplan.randazzo.properties` Deployment order: set it in the same release as the J6 backend (18 Oct 2026) — until it is set every escalation email stays pending, no new job gets EscalatedAt and the director packet carries no link; it no longer turns Planner on (that is PLANNER_SYNC_ENABLED). |
| `PLANNER_UNSIGNED_HOLDBACK_ENABLED` | off | Only matters if Planner sync is on. The nightly timer never raises lease tasks (expiry, option, review) for a tenancy whose schedule is not signed off. This switch also lets it take down the ones already open; off, it leaves them and logs each tenancy with its open task count | Only if Planner sync is turned on, after reading the "not removed" line in the log |
| `SCHEDULER_ENABLED` | off | The daily timer `schedulerTimer` (22:00 UTC, 07:30 in Darwin) raises defects-period reminders (60 and 30 days before the end), makes each service schedule's maintenance job `lead days` before it is due (one job per due date), skips a due date inside a blocking defects period, and raises overdue-servicing escalations (urgent for Fire & life safety and Lifts, digest for the rest). Needs migrations 119 and 120. Off, it logs "off" and writes nothing but its own `TimerRuns` row. A run that finishes with any problem is recorded as an error in `TimerRuns` and shows on `/api/health?deep=true`. The Maintenance page tells staff "Floorplan isn't making these jobs yet" until this is live | After a dry run, in the same change that turns Maintenance on for directors and facilities managers (Feature flags below) |
| `SCHEDULER_DRY_RUN` | off | Wins over `SCHEDULER_ENABLED`. The timer reads and logs, with counts, what it would do, and writes nothing | First, and read the counts in the log. By hand: an admin posts `{}` (or `{"dryRun": true}`) to `/api/runSchedulerNow` and gets `{ report, log }` back; `{"dryRun": false}` is refused with a 409 unless the timer itself is live |
| `SCHEDULER_MAX_ACTIONS` | 100 | Most writes (reminders, jobs, escalations) in one run, so a backlog is paced over several days. A run that stops at the limit says so in the log and in Sentry | Leave at 100 |
| `ACCESS_LOG_ENABLED` | **on** | Access-event log; `"false"` turns it off | Keep on |
| `ACCESS_REPORT_ENABLED` | off | Access report email | Once Graph mail is confirmed |
| `MONEY_ALLOWED_CIDRS` | unset: gate off, health warns | Networks allowed to take money actions | Office and remote-access egress; see `monitoring.md` §5 |
| `MONEY_STEP_UP_ENFORCED` | off: only the exact string `true` turns it on (`TRUE`, `1` do not) | With `MONEY_ALLOWED_CIDRS` unset, money actions are refused (428 `step_up_required`) when MFA did not run or the sign-in is older than `MONEY_STEP_UP_MINUTES`; the network is still not checked and health still says so. With the list set it changes nothing | Staging first: confirm a fresh MFA sign-in passes (the token's `amr` carries `mfa`) and a stale one gets the confirm prompt, then production, until the list is set |
| `MONEY_STEP_UP_MINUTES` | 10 | How recent the sign-in must be for a money action | Leave at 10 |
| `DIRECTOR_APPROVAL_THRESHOLD` | unset: highest other limit | Amount above which only a director approves | `50000` with WP43a-2 |
| `AI_ENABLED` | off | Master switch for the AI gateway (`runAi`, SC-AI1). Only the exact string `"true"` turns it on. Off: every AI endpoint answers that AI is switched off and nothing is sent to any model (the attempt is still logged). Pair with the `aiAssist` flag | Only once a self-hosted model runs on RP's own Azure tenant and Connor says yes; run Admin → AI activity → Run a test call first |
| `AI_PROVIDER` | `mock` | `mock`: a built-in stand-in that answers at once and sends nothing anywhere. `openai_compatible`: a self-hosted OpenAI-compatible endpoint (vLLM or Ollama). Anything else is refused as a provider error | `openai_compatible`, once the endpoint exists |
| `AI_BASE_URL` | unset | The endpoint's address with no path (`http://10.4.0.7:8000`): Floorplan posts to `<AI_BASE_URL>/v1/chat/completions`. http or https only. Needed with `openai_compatible` | With the endpoint |
| `AI_MODEL` | unset | The model name sent with every call, and shown in Admin → AI activity. Needed with `openai_compatible` | With the endpoint |
| `AI_API_KEY` | unset | Bearer token for the endpoint, as a Key Vault reference (`@Microsoft.KeyVault(SecretUri=...)`), never the key itself. Optional: a self-hosted endpoint that needs none is called without one | If the endpoint wants one |
| `AI_LOG_CONTENT` | off | Only `"true"` stores each call's redacted input and output text in `AiCallLog`. The log is append-only: stored text can never be removed. Off, a row keeps who asked, the purpose, sizes, a hash of the redacted input, the outcome and timing, and no text | Only while diagnosing a fault, then off again; what it stored stays |
| `AI_TIMEOUT_MS` | 20000 | How long one call may take before it is cut off and refused as a timeout. A whole number from 1 to 120000; anything else uses 20000 | Leave at 20000 |
| `AI_RATE_PER_MINUTE` | 20 | Most calls to the model one person may make in a minute, counted from `AiCallLog`. A whole number from 1 to 1000; anything else uses 20 | Leave at 20 |
| `GRAPH_MAILBOX_ACTIVE` | required: `dev` or `prod` | Which inbox Incoming reads | `prod` in production, `dev` on staging |
| `RUN_MIGRATIONS_ON_STARTUP` | off: startup only checks | Applies migrations at startup | Never in production |
| `DEV_ROLE_OVERRIDE_ENABLED` | ignored on Azure | Local role switcher; startup refuses to boot if set on Azure | Never in production |

Decision-request emails need the escalation mail settings (`APP_BASE_URL`, `GRAPH_SENDER_EMAIL`, `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`). Without them the request is still created and shows `notificationState: "pending"`.

Not a setting: `BILLS_ENABLED = false` in `src/myob/payloads.ts` refuses MYOB
bills whatever the controls say, until it is changed in code.

Coming, not on `sprint/integration` yet: `REVIEW_SANITY_MIN_PERCENT` (−5) and
`REVIEW_SANITY_MAX_PERCENT` (15) with WP26, which applies rent reviews.

## Feature flags (Admin → Features)

Hidden by default: Assets, Escalations, Rent reviews (`rentReviews`), Finance (CFO workspace),
Procedures, Decision jobs, Contractor suggestions. A flag only shows the module. The timers behind
Escalations and Rent reviews still need their app settings above. Decision jobs
(`decisionJobs`, Admin / Accounts jobs) need no setting and no migration: set it
to preview for the director role first, then for everyone. The backend accepts
the `admin` job kind whatever the flag says, and the sweep, Planner sync and
digest skip those jobs.
Maintenance (`maintenance`) is enabled in the code defaults, but the 13 Oct audit
found it set to Off for directors in Admin → Features (check the current state). The overdue-servicing escalation and the
defects-period reminders email a link into `/maintenance` to the facilities
manager and later a director; a role that has the module hidden lands on the
dashboard with no word of why. So switch Maintenance on for directors and
facilities managers in the same change that sets `SCHEDULER_ENABLED=true`, and
not before: until then no jobs are made, so a schedule that comes due just
turns overdue. The page says so while the timer is off or in dry run.

Defects periods (Simone's request) can be added, edited, archived and restored by
`admin`, `director` and `facilities_manager`; nobody else sees "Add defects
period", and with none in force they see "No defects periods in force. A
facilities manager sets them." Simone's app role is not yet confirmed: Connor to
check it in Admin → Users, and give her one of those three before asking her to
enter the current periods. Service schedules (add, edit, import, mark serviced
or skip) are managed by the same three roles.
Rent reviews (`rentReviews`) shows the review screens; the generator and the CPI
timer behind it need their settings above, and migration 101.
Switch the generator on (`RENT_REVIEW_GENERATOR_ENABLED`) before or with the
`rentReviews` flag, so reviews get their rows: until it has run, a tenancy with an
overdue review date appears in Next 90 days only as "Review not started".
Lease events (`leaseEvents`, WP32/WP33) ships hidden. On, the tenancy page shows
the Lease events section (option exercises and renewals), the option exercise
stepper (notice, checks, term and method preview, approve) instead of the old
Accept options dialog, the confirmation letter, and the directors' renewal
decision. Apply migration 106 first, and run the option backfill
(`npm run backfill:lease-options -- --target <server>/<db>`: a dry run by
default that lists the tenancies whose option text it can't read, for accounts
to fix; `--apply` writes the structured counts). Turn on
`LEASE_EVENTS_GENERATOR_ENABLED` (after its dry run) so windows, lapses and
renewal referrals happen without anyone recording a notice first.
Tenancy Schedule report (`tenancyScheduleReport`, Tools → Reports) ships in
preview: set it to enabled for director, cfo and admin once migration 159
(`159_tenancy_lease_type.sql`, additive: `Tenants.LeaseType`) is applied and the
backend with `getTenancySchedule` is deployed. No app setting. It reads
commercial buildings only (residences never appear) and writes nothing. Before
enabling it, check every family residence is marked `residence` in Buildings:
migration 150 marks only 25 and 23 Temira Crescent and 13 Seale St, so 24 Gunbar
St, 2 Godfrey Ct and 27 Lambell Tce would otherwise report as commercial. Before
the CFO's first run, set each tenancy's lease type and each fee's category in the
register, or the summary groups those charges as "Rent" and "Other charges"; the
report's Data gaps panel lists what is missing.
Contractor suggestions (`contractorSuggestions`, the Suggested group on a job's quote request
step and on its new purchase order form) ships hidden. It needs migration 171
(`171_contractor_suggestion_events.sql`, additive: three append-only log tables) applied first;
no timer, no email, no MYOB. Whoever may request quotes may ask, which includes everyone who may
raise a purchase order. With nothing recorded yet it says "No suggestions yet for this trade":
it only suggests a contractor with something recorded for the job (a building assignment, a
confirmed trade, or recent work at the building or in the trade), and it names a missing or
expired certificate of currency without hiding or blocking anyone. Production buildings carry the
source region "NT", which is not Darwin, Palmerston or Katherine, so region matching stays
unknown until a building's service region is recorded. `CONTRACTOR_RANKER` (above) chooses the
ranker. Each person may ask 30 times and record 60 times a minute (per instance); beyond that the
route answers 429 and the app simply shows no suggestions. Read the log with
`node scripts/eval-contractor-ranker.cjs` (it reads the local review database by default and
refuses any other server without `--allow-remote`).
AI assistance (`aiAssist`, Settings → AI activity) ships hidden. It shows the AI gateway's page: whether AI is on, which provider and model it points at, a Run a test call button (admin only) and the log of every AI call (admin and directors). Migration 170 (`170_ai_call_log.sql`, additive: `dbo.AiCallLog`) must be applied before the log or the test call is used; `getAiStatus` needs no table. The flag only shows the page: `AI_ENABLED` (above) is what lets a call through, and with it unset nothing is sent anywhere. Redaction replaces emails, Australian phone numbers, BSB and account numbers, TFNs and card numbers before any call; names and street addresses are not removed, which is why the model runs on RP's own tenant. Later AI packages add their own flags under the same "AI assistance" area.
Maintenance spend report (`maintenanceSpendReport`, Tools → Reports) ships hidden. Set
it to enabled for director, cfo, admin and facilities_manager once the backend with
`getMaintenanceSpendReport` is deployed. No app setting and no migration: it reads
`Jobs` and `JobInvoices` and writes nothing. It counts approved invoices (`approved`
and `director_approved`) on commercial buildings by invoice date in Darwin time, or by
approval date when an invoice has none (the page says how many), ex GST: Floorplan
keeps each invoice as one total including GST, so GST is taken out at an eleventh.
Test jobs and invoices stay out unless an admin has Show test data on, so on the local
review database, whose demo invoices are all test records, it shows figures only with
that on. As for the Tenancy Schedule report, check every family residence is marked
`residence` in Buildings before showing it to anyone.
Asking for a decision (`requestJobDecision`, `getJobDecisionRequest`,
`withdrawJobDecisionRequest`, slice A1) needs migration 137 and no app setting.
The endpoints do not read the flag (it only shows the module). Reminders and the
move-up to the manager need the sweep switch above. Whether a request moves up is
stored on it (`JobDecisionRequests.AutoEscalate`): always for Soon, Routine and
Fixed; the raiser's tick for Urgent, off unless ticked; never for an Emergency.
An Urgent request that was not ticked has no due moment, so the sweep reminds it
and then leaves it where it is until someone answers or withdraws it.
Recurring faults (`recurringFaults`, SC-AI5) ships hidden and needs no app setting and no
migration: `getRecurringFaults` only reads jobs, asset links and invoices and writes nothing,
so it has no switch. Set it to preview or enabled per role in Admin → Features; it shows on
Maintenance, on an asset's detail and in a building's overview for whoever can see
Maintenance (admin, director and the facilities and accounts roles). A signal is three or more jobs on
one asset, or on one trade on one level of a building, made in the last 365 Darwin days
(`RECURRING_FAULT_MIN_JOBS` and `RECURRING_FAULT_WINDOW_DAYS`, `src/recurringFaultConstants.ts`).
Archived jobs, Admin / Accounts jobs, jobs the scheduler made and test records (unless an admin has
Show test data on) are not counted. Spend is approved incoming invoices excluding GST: Floorplan
holds amounts GST inclusive, so it is 10/11 of them, and a stage-1 approval still waiting on a
director is not spend yet.

## Migrations

Applied by hand. There is no default database:

```
npm run migrate -- --target <server>/<database>            # list pending
npm run migrate -- --target <server>/<database> --apply    # apply as your az login
```

Dry-run on a restored copy first by targeting it. Migration 101 applies out of
order, with a warning only.

Migration 170 (`170_ai_call_log.sql`, SC-AI1) is applied before the build that serves `listAiCalls` and
`runAiHealthCheck`. It adds `dbo.AiCallLog`, an append-only ledger table (or, if the database refuses
those, an ordinary table with a trigger that refuses UPDATE and DELETE: the same two-path mechanism as
094 and 115, see `docs/decision-ledger-fallback.md`; `SELECT name, ledger_type_desc FROM sys.tables WHERE
name = 'AiCallLog'` says which). It changes nothing that exists, and a second run is a no-op. Dry-run it on a
restored copy first, as for any migration.

Migrations 119 (`119_defects_periods.sql`, sprint F1) and 120
(`120_service_schedules.sql`, sprint F2) are applied before the build that serves
the Maintenance page, the defects and schedule endpoints, and `schedulerTimer`.
Both are additive and re-runnable, and 120 seeds the overdue-servicing escalation
policies (insert-only, so an admin's edit survives a re-run). Creating a job and
completing one tolerate a missing table (no periods, no schedule; Sentry says
which migration to apply), so a build that runs ahead of them looks healthy on
the Jobs pages while the Maintenance page, the defects strip and the scheduler
fail. Dry-run both on a restored copy first, as for any migration. Don't renumber either.

Migration 137 (`job_decision_requests`, A1) is applied before the build that serves
`requestJobDecision`. It adds `JobDecisionRequests` (including `AutoEscalate BIT NOT
NULL`, with a CHECK tying it to the tier) and seeds the `job.decision_pending` policy
(insert-only, so an edit survives a re-run). To switch asking off without a deploy,
set `Active = 0` on that row of `EscalationPolicies`: asking then answers 422
`policy_inactive`. A build that is ahead of 137 still deletes files as before; once
137 is applied, a file a decision request is about cannot be deleted (422).

Migration 101 (`101_rent_review_workflow.sql`, WP25) is hand-applied like the rest.
It is numbered below migrations already applied, so the runner applies it out of
order with a warning only. Apply it before turning on the Rent reviews flag or the
generator. WP26 adds no migration.

Migration 099 (`099_schedule_change_requests.sql`, WP26c) is hand-applied like the
rest. It is numbered below applied migrations, so the runner applies it out of order
with a warning only. Apply it before deploying WP26c's backend: the register reads
select its new columns.

WP26c fixes (18 Oct 2026, both repos): deploy the backend before or with the
frontend, never the pre-fix WP26c frontend (d088691) with the fixed backend,
because Approve now sends the tenancy's schedule version (an older frontend gets
400). Before go-live run this read-only check and fix any row it returns; such a
tenancy cannot be approved until its reliefs are a JSON array or null:
`SELECT TenantId FROM dbo.Tenants WHERE RentReliefs IS NOT NULL AND (ISJSON(RentReliefs) = 0 OR LEFT(LTRIM(RentReliefs),1) <> '[')`.
A pending relief that runs past its lease's expiry is refused at approval
(`outside_lease`); the director rejects it. Turn the `rentReviews` flag on last.

Migration 117 (`117_quote_approval_attribution.sql`, attributed approval + R13
variance facts) is hand-applied like the rest; it is numbered below applied
migrations, so the runner applies it out of order with a warning only. Apply it
before deploying the backend that carries it: without it, PO rises, PO sends and
invoice approvals above the approved quote, setApprovalFact and the escalation
sweep's attribution step all fail; plain quote approval keeps working through a
column probe. `ATTRIBUTED_APPROVAL_ENABLED` stays off until Connor lifts
decisions 1 and 9 (sprint board, decision 15).

Migration 138 (`138_job_decisions.sql`, jobs A2) is hand-applied after 137, before
the build that serves respondToJobDecision. Don't renumber it. getJobDecisionRequest
tolerates a database without it.

Migration 171 (`171_contractor_suggestion_events.sql`, SC-AI3) is applied before the build that
serves `suggestContractors` and `recordContractorSuggestionOutcome`; without it both answer 500 (the
app shows a plain "couldn't load suggestions" line and the normal picker still works). It only
creates `ContractorSuggestionSets`, `ContractorSuggestionItems` and `ContractorSuggestionOutcomes`
and changes no existing table. The tables are append-only: triggers refuse UPDATE and DELETE, and
a guard test fails if any code issues one, so removing rows later (a retention rule, an erasure
request) needs its own migration with a DESTRUCTIVE header. Dry-run it on a restored copy first,
as for any migration. Don't renumber it.

Procedures (U4): apply migration 142 (`142_procedure_approval_request.sql`) before
the build that serves `getProcedures` and `requestProcedureApproval`; it adds four
nullable columns to `ProcedureVersions` and `getProcedures`, `saveProcedureDraft`
and the request endpoint read or write them, so without it all three fail. Then
load the library's six starting documents once, so Procedures is not empty on the
day it is switched on:

```
npm run seed:procedures -- --target <server>/<database>            # dry run: says what it would add
npm run seed:procedures -- --target <server>/<database> --apply
```

It only adds, and it is safe to run again: a procedure that already has any version
is left alone, so it never overwrites a document edited in the app and a published
version stays immutable. Documents whose markdown names no approver are stored as
published with the approver "Connor (from content/procedures)", because the table
refuses a published version without one; a director re-approving them in the app
replaces that with a real approval. Changed wording in `content/procedures` after
the first load is not picked up: edit the document in the app (a new draft). Who
sees what: a manager sees what is written for their officers, the CFO what is
written for accounts, admin and director see all. That holds for editors too
(managers, the CFO): they read, edit and ask about only the procedures written for
their own team, and a draft or a save outside it is refused (403). Only a director
publishes: admin alone is refused, as for schedule sign-off. The starting documents
stay out of the deployed package (`.funcignore`); they are loaded from a checkout.
A manager asks a director to approve a draft from the
editor (the same director again only after ten minutes); the director gets an email (a link to the editor, nothing about the
procedure in the subject) and the library reads "Awaiting approval by {name}".

## Escalations

`job.next_step` (seeded active): a decision's next step goes to its owner, then the owner's manager (16 business hours), then a director. Kill switch: set its Active to 0. Answers still work and the step is recorded and handed on, but it isn't chased or emailed.

`schedule.change_ratification` (seeded active): a requested rent relief goes to the directors; 16h per rung.
