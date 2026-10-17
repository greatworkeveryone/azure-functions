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
| `EMAIL_REPLY_DECISIONS_ENABLED` | off | Lets a director approve or decline by replying to an email | Leave off: decisions happen in the app |
| `ESCALATION_SWEEP_ENABLED` · `_DRY_RUN` | off | The 30-minute sweep raises, moves up and ends escalations, and emails them. It also sends a decision request's scheduled reminders and moves an unanswered one up to the raiser's manager at its deadline (an Urgent one only if the raiser ticked "move up if no answer"; it is reminded at 24 hours either way, and an Emergency is never chased). Nothing is reminded or escalated while it is off (the first email, at ask time, does not need it) It also asks a deferred decision again on its day (once); in dry run it logs 'would ask job #N again' | After a dry run |
| `ESCALATION_HOLIDAYS` | unset: no holidays | Darwin public holidays, `YYYY-MM-DD`, comma-separated. The SLA clocks and the decision-request tiers skip them (weekends are always skipped). A bad entry is ignored and logged | Keep the list current for the year |
| `DEV_EMAIL_OVERRIDE` | unset | Every outgoing escalation and decision-request email goes to this one address instead of the people asked | Dev and staging only; never in production |
| `DIGEST_ENABLED` · `_DRY_RUN` | off | The morning digest email | After a dry run |
| `RENT_REVIEW_GENERATOR_ENABLED` · `_DRY_RUN` | off | Creates and moves rent reviews (WP25). Each live run also raises E1/E2, re-raises a lost E3 at the rung it reached, and writes the RentPerAnnum cache of a review applied ahead of its date once the date comes (WP26); at most `ESCALATION_SWEEP_MAX_ACTIONS` escalations a run. Pair with the Rent reviews flag | After a dry run |
| `REVIEW_WINDOW_DAYS` | 60 | Days before its date a scheduled rent review becomes due | Leave at 60 |
| `REVIEW_SANITY_MIN_PERCENT` · `_MAX_PERCENT` | −5 · 15 | A review whose % falls outside the band needs a second person (C5); a director can override with a reason. A value that isn't a % from −100 to 100, or a min above the max, falls back to the default | Leave as is |
| `REVIEW_WORKFLOW_LIVE_FROM` | unset | `YYYY-MM-DD` the workflow went live: reviews dated on or after it are settled only by the workflow, earlier ones by their keyed schedule row From WP26c, an unresolved review row dated on or after it shows as pending (awaiting review) on the schedule until a review applies it | The day WP25/WP26 go live (gate B) |
| `CPI_SYNC_ENABLED` · `_DRY_RUN` | off | Daily ABS CPI sync into `CpiIndex`; then CPI reviews waiting for their index come back in progress, calculated, even when the ABS fetch fails (WP26) | After a dry run |
| `PLANNER_SYNC_ENABLED` | off | Microsoft Planner sync, being retired. The only Planner switch: every path that creates, updates or completes a Planner task checks it first, whatever else is set. Until 17 Oct `APP_BASE_URL` doubled as the switch (setting it turned task creation back on through every job save), which is why production kept `APP_BASE_URL` unset and the director approval email went out with no link (jobs-flow N14). That coupling is gone | Leave off |
| `APP_BASE_URL` | unset: emails have no links | Links only: the director approval email, escalation and decision-request emails and the morning digest link to the record and step they are about (`/jobs?jobId=12&step=quotes`). It switches nothing on, Planner included | Set it with this release, on Connor's yes: `https://floorplan.randazzo.properties` |
| `PLANNER_UNSIGNED_HOLDBACK_ENABLED` | off | Only matters if Planner sync is on. The nightly timer never raises lease tasks (expiry, option, review) for a tenancy whose schedule is not signed off. This switch also lets it take down the ones already open; off, it leaves them and logs each tenancy with its open task count | Only if Planner sync is turned on, after reading the "not removed" line in the log |
| `ACCESS_LOG_ENABLED` | **on** | Access-event log; `"false"` turns it off | Keep on |
| `ACCESS_REPORT_ENABLED` | off | Access report email | Once Graph mail is confirmed |
| `MONEY_ALLOWED_CIDRS` | unset: gate off, health warns | Networks allowed to take money actions | Office and remote-access egress; see `monitoring.md` §5 |
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
Rent reviews (`rentReviews`) shows the review screens; the generator and the CPI
timer behind it need their settings above, and migration 101.
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

Migration 138 (`138_job_decisions.sql`, jobs A2) is hand-applied after 137, before
the build that serves respondToJobDecision. Don't renumber it. getJobDecisionRequest
tolerates a database without it.

## Escalations

`job.next_step` (seeded active): a decision's next step goes to its owner, then the owner's manager (16 business hours), then a director. Kill switch: set its Active to 0. Answers still work and the step is recorded and handed on, but it isn't chased or emailed.

`schedule.change_ratification` (seeded active): a requested rent relief goes to the directors; 16h per rung.
