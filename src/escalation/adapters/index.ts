// Registers the adapters this package ships. Importing this module is what makes
// jobs, tenancies, rent reviews (WP26) and system health escalatable; other
// packages register their own from their own modules with registerAdapter.

import { defectsPeriodAdapter } from "./defectsPeriod";
import { jobAdapter } from "./job";
import { registerAdapter } from "./registry";
import { rentReviewAdapter } from "./rentReview";
import { serviceScheduleAdapter } from "./serviceSchedule";
import { systemAdapter } from "./system";
import { tenancyAdapter } from "./tenancy";

registerAdapter(defectsPeriodAdapter);
registerAdapter(jobAdapter);
registerAdapter(rentReviewAdapter);
registerAdapter(serviceScheduleAdapter);
registerAdapter(systemAdapter);
registerAdapter(tenancyAdapter);

export { getAdapter, registerAdapter, registeredSubjectTypes, requireAdapter, unregisterAdapter } from "./registry";
export type { ConditionRef, EscalationAdapter, SubjectSummary } from "./registry";
