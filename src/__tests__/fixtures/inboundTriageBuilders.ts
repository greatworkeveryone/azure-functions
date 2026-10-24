// Shared builders for this module's tests: one place for what a FeatureVector and a context look like.
import type { Candidate, FeatureVector, TriageContext } from "../../inboundTriage/types";

export const NO_FEATURES: FeatureVector = {
  daysSinceActive: null,
  jobsHere90d: 0,
  jobsHereCategory90d: 0,
  openJobs: 0,
  ownsNamedJob: false,
  ownsOpenJobForTenancy: false,
  ownsOpenJobHere: false,
  roleFit: "lane_staff",
  sentLinkedSend: false,
};

export const features = (over: Partial<FeatureVector> = {}): FeatureVector => ({ ...NO_FEATURES, ...over });

export const context = (over: Partial<TriageContext> = {}): TriageContext => ({
  buildingId: 10,
  buildingName: "Frogmore House",
  category: "Electrical",
  contractorId: null,
  emailId: 5,
  intent: "maintenance_request",
  lane: "facilities",
  linkedSend: null,
  mailbox: "notices@randazzo.properties",
  matchedJobId: null,
  senderKind: "unknown",
  tenancyId: null,
  tenancyName: null,
  today: "2026-10-24",
  urgency: null,
  ...over,
});

export const candidate = (userId: number, name: string, over: Partial<FeatureVector> = {}, role = "facilities"): Candidate => ({
  features: features(over),
  name,
  role,
  userId,
});
