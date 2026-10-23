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
| `REVIEW_WINDOW_DAYS` | 60 | Days before its date a scheduled rent review becomes due | Leave at 60 |
| `REVIEW_SANITY_MIN_PERCENT` · `_MAX_PERCENT` | −5 · 15 | A review whose % falls outside the band needs a second person (C5); a director can override with a reason. A value that isn't a % from −100 to 100, or a min above the max, falls back to the default | Leave as is |
| `REVIEW_WORKFLOW_LIVE_FROM` | unset | `YYYY-MM-DD` the workflow went live: reviews dated on or after it are settled only by the workflow, earlier ones by their keyed schedule row From WP26c, an unresolved review row dated on or after it shows as pending (awaiting review) on the schedule until a review applies it | The day WP25/WP26 go live (gate B) |
| `CPI_SYNC_ENABLED` · `_DRY_RUN` | off | Daily ABS CPI sync into `CpiIndex`; then CPI reviews waiting for their index come back in progress, calculated, even when the ABS fetch fails (WP26) | After a dry run |
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
Procedures, Decision jobs. A flag only shows the module. The timers behind
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
Asking for a decision (`requestJobDecision`, `getJobDecisionRequest`,
`withdrawJobDecisionRequest`, slice A1) needs migration 137 and no app setting.
The endpoints do not read the flag (it only shows the module). Reminders and the
move-up to the manager need the sweep switch above. Whether a request moves up is
stored on it (`JobDecisionRequests.AutoEscalate`): always for Soon, Routine and
Fixed; the raiser's tick for Urgent, off unless ticked; never for an Emergency.
An Urgent request that was not ticked has no due moment, so the sweep reminds it
and then leaves it where it is until someone answers or withdraws it.

## Migrations

Applied by hand. There is no default database:

```
npm run migrate -- --target <server>/<database>            # list pending
npm run migrate -- --target <server>/<database> --apply    # apply as your az login
```

Dry-run on a restored copy first by targeting it. Migration 101 applies out of
order, with a warning only.

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
