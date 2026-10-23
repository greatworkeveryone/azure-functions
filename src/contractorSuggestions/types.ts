// Contractor suggestions (SC-AI3): the shapes every part of the module shares.
// Pure types, no imports, so a ranker, the loaders, the log and the offline
// evaluation can all depend on them without depending on each other.

/** Where in the job flow the person is choosing a contractor. */
export const SUGGESTION_CONTEXTS = ["quote_request", "assign"] as const;
export type SuggestionContextKind = (typeof SUGGESTION_CONTEXTS)[number];

export const CERTIFICATE_STATUSES = ["valid", "expiring", "expired", "missing", "unknown"] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

/**
 * Everything a ranker may look at for one contractor, as it stood when the
 * suggestion was made. The shape is versioned by FEATURE_SCHEMA_VERSION: it is
 * logged verbatim with every suggestion, so changing a field's meaning needs a
 * new version, never an edit in place.
 *
 * `null` always means "not known", never "no": a contractor with no recorded
 * trades has tradeCovered null, not false.
 */
export interface FeatureVector {
  /** The building's trade assignment (migration 155) names this contractor for the job's trade. */
  assignedToBuilding: boolean;
  /** Days from today to the earliest recorded expiry (negative once expired); null when missing or undated. */
  certificateDaysToExpiry: number | null;
  certificateStatus: CertificateStatus;
  /** Whole days since the last job this contractor was engaged on at this building (any year); null when never. */
  daysSinceLastJobHere: number | null;
  jobsHere12m: number;
  jobsTrade12m: number;
  /** Median days from a job being raised to it being done, over jobs done in the last 12 months; null when none. */
  medianDaysToComplete12m: number | null;
  /** Accepted / (accepted + rejected) over quotes raised in the last 12 months; null while none are decided. */
  quoteAcceptanceRate12m: number | null;
  quotesAccepted12m: number;
  quotesDecided12m: number;
  /** The building's recorded service region is one this contractor has confirmed; null when either side is unrecorded. */
  regionMatch: boolean | null;
  /** The contractor's confirmed trades (migration 156) include the job's trade; null when the trade or their trades are unrecorded. */
  tradeCovered: boolean | null;
}

/** A contractor who may be suggested: active and not suspended, with the features computed for this request. */
export interface Candidate {
  contractorId: number;
  features: FeatureVector;
  name: string;
}

/** What the person is choosing for. */
export interface SuggestionContext {
  buildingId: number;
  /** The building's recorded region when it is one of the three service regions; null otherwise. */
  buildingRegion: string | null;
  context: SuggestionContextKind;
  jobId: number | null;
  /** Today in Darwin, YYYY-MM-DD: the date every "days" feature was measured from. */
  today: string;
  /** The job's trade in canonical spelling; null when the job's category is not a trade. */
  trade: string | null;
}

/** One plain sentence beside a suggested name. A caution is something to look at before choosing, not a reason to choose. */
export interface Reason {
  caution: boolean;
  text: string;
}

export interface ScoredCandidate {
  contractorId: number;
  features: FeatureVector;
  name: string;
  /** Most telling first; shown as they are. */
  reasons: Reason[];
  /** Comparable within one set only; the unit belongs to the ranker. */
  score: number;
}

/**
 * Anything that can order candidates. A ranker may leave a candidate out (the
 * rules ranker does when nothing speaks for them); it must return the rest best
 * first. It may be asynchronous so a learned or LLM ranker can call a model.
 */
export interface Ranker {
  rank(candidates: readonly Candidate[], context: SuggestionContext): Promise<ScoredCandidate[]> | ScoredCandidate[];
  /** Logged with every set, e.g. "rules@1": bump it whenever the ranker's behaviour changes. */
  readonly version: string;
}

/** One suggested contractor as the route returns and the log stores it. */
export interface SuggestionItem {
  certificate: { daysToExpiry: number | null; status: CertificateStatus };
  contractorId: number;
  name: string;
  rank: number;
  reasons: Reason[];
  score: number;
}
