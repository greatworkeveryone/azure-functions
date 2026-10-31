// The switches for tenant status notices (TR4, PLAN §15). Off by default, as every send is (database-safety rule 2).
//   TENANT_NOTICES_ENABLED=true   a job transition on a tenant-linked job queues a notice, and the sweep sends it
//   TENANT_NOTICES_DRY_RUN=true   the sweep works out who would be told and logs it; nothing is queued (wins over ENABLED)
//   neither                       nothing is recorded or queued, and the sweep does not touch the database
// The comms core has its own COMMS_SEND_ENABLED / COMMS_SEND_DRY_RUN on top: these switches only decide whether a
// notice is made at all.

export type NoticeMode = "dry-run" | "live" | "off";

export function noticesMode(env: NodeJS.ProcessEnv = process.env): NoticeMode {
  if (env.TENANT_NOTICES_DRY_RUN === "true") return "dry-run";
  return env.TENANT_NOTICES_ENABLED === "true" ? "live" : "off";
}

/** Notices are made by the system, not by a person; the comms core records this as the creator. */
export const NOTICE_ACTOR_OID = "system:tenant-notices";
export const NOTICE_ACTOR_NAME = "Floorplan notices";

export const NOTICE_EVENTS = ["attendance", "completed"] as const;
export type NoticeEvent = (typeof NOTICE_EVENTS)[number];

/** The library template (slug) and the id the correspondence row records, per event. */
export const NOTICE_TEMPLATES: Record<NoticeEvent, { id: string; slug: string }> = {
  attendance: { id: "request_attendance", slug: "request-attendance" },
  completed: { id: "request_completed", slug: "request-completed" },
};

/** A block whose id ends in this is the "see your requests" paragraph; an email-only tenancy never gets it. */
export const LINK_BLOCK_SUFFIX = "-link";
