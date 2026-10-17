// Which inbox the Graph sync reads. GRAPH_MAILBOX_ACTIVE picks the setting:
// unset/"dev" → GRAPH_MAILBOX_DEV, "prod" → GRAPH_MAILBOX_PROD. Anything else
// resolves to no mailbox so a typo fails loudly instead of syncing the wrong inbox.
//
// Switching: the renew timer creates a subscription for the new mailbox on its
// next run (the old one lapses within 3 days), and the sync watermark is global,
// so mail older than the newest synced email isn't back-filled.

export type MailboxSetting = "GRAPH_MAILBOX_DEV" | "GRAPH_MAILBOX_PROD";

export function activeMailboxSetting(): MailboxSetting | null {
  const mode = (process.env.GRAPH_MAILBOX_ACTIVE ?? "").trim().toLowerCase();
  if (mode === "" || mode === "dev") return "GRAPH_MAILBOX_DEV";
  if (mode === "prod") return "GRAPH_MAILBOX_PROD";
  return null;
}

export function incomingMailbox(): string | null {
  const setting = activeMailboxSetting();
  if (!setting) return null;
  return process.env[setting]?.trim() || null;
}

// Names what's missing, for error logs and 500 bodies.
export function mailboxConfigError(): string {
  const setting = activeMailboxSetting();
  if (!setting) {
    return `GRAPH_MAILBOX_ACTIVE must be "dev" or "prod" (got "${process.env.GRAPH_MAILBOX_ACTIVE}")`;
  }
  return `${setting} not configured`;
}
