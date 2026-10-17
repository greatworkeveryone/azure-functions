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
| `ESCALATION_SWEEP_ENABLED` · `_DRY_RUN` | off | The 30-minute sweep raises, moves up and ends escalations, and emails them. Nothing escalates while it is off | After a dry run |
| `DIGEST_ENABLED` · `_DRY_RUN` | off | The morning digest email | After a dry run |
| `RENT_REVIEW_GENERATOR_ENABLED` · `_DRY_RUN` | off | Creates and moves rent reviews (WP25). Pair with the Rent reviews flag below | After a dry run |
| `CPI_SYNC_ENABLED` · `_DRY_RUN` | off | Daily ABS CPI sync into `CpiIndex` | After a dry run |
| `PLANNER_SYNC_ENABLED` | off | Microsoft Planner sync, being retired | Leave off |
| `ACCESS_LOG_ENABLED` | **on** | Access-event log; `"false"` turns it off | Keep on |
| `ACCESS_REPORT_ENABLED` | off | Access report email | Once Graph mail is confirmed |
| `MONEY_ALLOWED_CIDRS` | unset: gate off, health warns | Networks allowed to take money actions | Office and remote-access egress; see `monitoring.md` §5 |
| `MONEY_STEP_UP_MINUTES` | 10 | How recent the sign-in must be for a money action | Leave at 10 |
| `DIRECTOR_APPROVAL_THRESHOLD` | unset: highest other limit | Amount above which only a director approves | `50000` with WP43a-2 |
| `GRAPH_MAILBOX_ACTIVE` | required: `dev` or `prod` | Which inbox Incoming reads | `prod` in production, `dev` on staging |
| `RUN_MIGRATIONS_ON_STARTUP` | off: startup only checks | Applies migrations at startup | Never in production |
| `DEV_ROLE_OVERRIDE_ENABLED` | ignored on Azure | Local role switcher; startup refuses to boot if set on Azure | Never in production |

Not a setting: `BILLS_ENABLED = false` in `src/myob/payloads.ts` refuses MYOB
bills whatever the controls say, until it is changed in code.

Coming, not on `sprint/integration` yet: `REVIEW_SANITY_MIN_PERCENT` (−5) and
`REVIEW_SANITY_MAX_PERCENT` (15) with WP26, which applies rent reviews.

## Feature flags (Admin → Features)

Hidden by default: Assets, Escalations, Rent reviews, Finance (CFO workspace),
Procedures. A flag only shows the module. The timers behind Escalations and Rent
reviews still need their app settings above. Coming: `decisionJobs` (admin
decision jobs, hidden by default; the sweep, Planner sync and digest skip them).

## Migrations

Applied by hand. There is no default database:

```
npm run migrate -- --target <server>/<database>            # list pending
npm run migrate -- --target <server>/<database> --apply    # apply as your az login
```

Dry-run on a restored copy first by targeting it. Migration 101 applies out of
order, with a warning only.
