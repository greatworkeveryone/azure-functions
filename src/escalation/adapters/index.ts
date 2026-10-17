// Registers the adapters this package ships. Importing this module is what makes
// jobs, tenancies, rent reviews (WP26), pending schedule changes (WP26c) and
// system health escalatable; other packages register their own from their own
// modules with registerAdapter.

import { jobAdapter } from "./job";
import { registerAdapter } from "./registry";
import { rentReviewAdapter } from "./rentReview";
import { scheduleChangeAdapter } from "./scheduleChange";
import { systemAdapter } from "./system";
import { tenancyAdapter } from "./tenancy";

registerAdapter(jobAdapter);
registerAdapter(rentReviewAdapter);
registerAdapter(scheduleChangeAdapter);
registerAdapter(systemAdapter);
registerAdapter(tenancyAdapter);

export { getAdapter, registerAdapter, registeredSubjectTypes, requireAdapter, unregisterAdapter } from "./registry";
export type { ConditionRef, EscalationAdapter, SubjectSummary } from "./registry";
