// Inbound email triage (EB3): the shapes every part of the module shares. Pure
// types, no imports, so a ranker, the loaders, the log and the offline
// evaluation can depend on them without depending on each other. The pattern is
// SC-AI3's (src/contractorSuggestions): versioned features, a Ranker interface,
// a registry, an append-only log.

export const INTENTS = ["maintenance_request", "invoice_or_quote", "rent_or_account", "complaint", "other"] as const;
export type Intent = (typeof INTENTS)[number];

export const URGENCIES = ["low", "normal", "high", "urgent"] as const;
export type Urgency = (typeof URGENCIES)[number];

/** Which staff the work belongs to: maintenance to facilities roles, money questions to accounts roles, anything else to both. */
export type Lane = "facilities" | "accounts" | "both";

/** Where the reading of the email came from: keyword rules, Toddler's parse already on the row, or the AI gateway. */
export type WorkSource = "rules" | "toddler" | "ai";

/** What the email is about, as far as it can be told. Every field except intent, lane and source may be unknown. */
export interface Work {
  buildingName: string | null;
  category: string | null;
  intent: Intent;
  /** A job number the email names; checked against the jobs table before it is trusted. */
  jobNumber: number | null;
  lane: Lane;
  source: WorkSource;
  tenancyName: string | null;
  urgency: Urgency | null;
}

/** A stored send (EB1) the email replies to, found through its In-Reply-To or References ids. */
export interface LinkedSend {
  buildingId: number | null;
  jobId: number | null;
  /** "broadcast", "correspondence" or whatever EB1 calls its kinds: shown, never branched on. */
  kind: string;
  recipientEmail: string | null;
  sendId: string;
  /** AppUsers.UserID of the person who sent it; null when it was sent by the system. */
  sentByUserId: number | null;
  subject: string | null;
  tenancyId: number | null;
}

/** Who wrote the email, as far as Floorplan's own records can tell. */
export type SenderKind = "tenancy" | "contractor" | "staff" | "unknown";

export const ROLE_FITS = ["lane_staff", "lane_manager", "either_staff", "either_manager", "none"] as const;
export type RoleFit = (typeof ROLE_FITS)[number];

/**
 * Everything a ranker may look at for one person, as it stood when the email was triaged. It is logged
 * verbatim with every set, so changing a field's meaning needs a new FEATURE_SCHEMA_VERSION, never an
 * edit in place. Zero means "none found", never "unknown"; where unknown is possible the field is null.
 */
export interface FeatureVector {
  /** Days since this person's last recorded sign-in or request; null when access logging has no row for them. */
  daysSinceActive: number | null;
  /** Jobs at the email's building, in its category, assigned to this person and raised in the last 90 days. */
  jobsHereCategory90d: number;
  /** Jobs at the email's building, any category, assigned to this person and raised in the last 90 days. */
  jobsHere90d: number;
  /** Open jobs assigned to this person, anywhere: their current workload. */
  openJobs: number;
  /** An open job at the email's building is assigned to this person. */
  ownsOpenJobHere: boolean;
  /** An open job for the email's tenancy is assigned to this person. */
  ownsOpenJobForTenancy: boolean;
  /** The job the email names is assigned to this person. */
  ownsNamedJob: boolean;
  roleFit: RoleFit;
  /** This person sent the broadcast or correspondence the email replies to. */
  sentLinkedSend: boolean;
}

/** One person who may be given the email: active, not away, and in a role that fits (or the sender of the send it answers). */
export interface Candidate {
  features: FeatureVector;
  name: string;
  role: string;
  userId: number;
}

/** What is being routed. Stored on every set, so a person added later can have their features computed the same way. */
export interface TriageContext {
  buildingId: number | null;
  buildingName: string | null;
  category: string | null;
  contractorId: number | null;
  emailId: number;
  intent: Intent;
  lane: Lane;
  linkedSend: LinkedSend | null;
  mailbox: string | null;
  matchedJobId: number | null;
  senderKind: SenderKind;
  tenancyId: number | null;
  tenancyName: string | null;
  /** Today in Darwin, YYYY-MM-DD: the date every "days" feature was measured from. */
  today: string;
  urgency: Urgency | null;
}

/** One plain sentence beside a suggested name. A caution is something to look at before choosing, not a reason to choose. */
export interface Reason {
  caution: boolean;
  text: string;
}

export interface ScoredCandidate {
  features: FeatureVector;
  name: string;
  /** Most telling first; shown as they are. */
  reasons: Reason[];
  role: string;
  /** Comparable within one set only; the unit belongs to the ranker. */
  score: number;
  userId: number;
}

/**
 * Anything that can order candidates. It must return the candidates best first and may leave some out. It
 * may be asynchronous so a learned or LLM ranker can call a model. Whatever it returns is untrusted: only
 * people it was given can be chosen (see triage.ts).
 */
export interface Ranker {
  rank(candidates: readonly Candidate[], context: TriageContext): Promise<ScoredCandidate[]> | ScoredCandidate[];
  /** Logged with every set, e.g. "rules@1": bump it whenever the ranker's behaviour changes. */
  readonly version: string;
}

export type Decision = "auto" | "queued" | "manual";

export type OutcomeKind = "auto_assigned" | "accepted" | "chose_other" | "reassigned";

/** One suggested person as the routes return and the log stores them. */
export interface Suggestion {
  name: string;
  rank: number;
  reasons: Reason[];
  score: number;
  userId: number;
}
