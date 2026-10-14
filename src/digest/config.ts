// What the morning digest reads from the environment (N1).
//
//   DIGEST_ENABLED   "true" lets the timer send; anything else and it does nothing
//   DIGEST_DRY_RUN   "true" reads and logs what it would send, and sends nothing
//                    (wins over DIGEST_ENABLED)
//
// Mail settings are the escalation engine's: APP_BASE_URL, GRAPH_SENDER_EMAIL and
// the three GRAPH_* credentials (missingNotificationConfig). DEV_EMAIL_OVERRIDE
// rewrites every address through resolveRecipient. ESCALATION_HOLIDAYS lists the
// Darwin public holidays the digest skips.

/** Most lines a digest shows; the rest are "and N more". */
export const DIGEST_MAX_LINES = 5;

export type DigestMode = "dry-run" | "live" | "off";

export function digestMode(env: NodeJS.ProcessEnv = process.env): DigestMode {
  if (env.DIGEST_DRY_RUN === "true") return "dry-run";
  return env.DIGEST_ENABLED === "true" ? "live" : "off";
}
