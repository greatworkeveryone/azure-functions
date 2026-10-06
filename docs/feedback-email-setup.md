# Feedback Email Setup

The in-app feedback widget (`POST /api/sendFeedback`) emails submissions through
the same Microsoft Graph app registration as everything else — see
`command-centre/docs/microsoft-graph-email-setup.md` for the registration,
secrets and `GRAPH_*` variables. This file covers only what is specific to
feedback.

## `FEEDBACK_EMAIL_RECIPIENTS`

Sets who receives feedback submissions. Same format and spirit as
`DIRECTOR_APPROVAL_EMAILS`:

- Comma-separated. Semicolons are also accepted.
- Entries that aren't email-shaped are discarded rather than rejected outright,
  so a typo can't turn into an opaque Graph send failure at request time.

```
FEEDBACK_EMAIL_RECIPIENTS=connor@example.com,will@example.com
```

Set it in Azure App Settings for the deployed function app, and in
`local.settings.json` for local runs (that file is git-ignored, so each clone
needs its own).

If it's empty — or every entry is malformed — `sendFeedback` returns a 500
explaining it's unconfigured rather than silently discarding the feedback.

## Replies

Mail is sent from the `GRAPH_SENDER_EMAIL` mailbox, so replies land there rather
than with whoever submitted the feedback. The submitter's address is included in
the email footer for copy-paste. This is deliberate — no `Reply-To` header is
set, so the shared Graph helper stays untouched by this feature.
