// Registers the adapters this package ships. Importing this module is what makes
// jobs, tenancies, rent reviews (WP26), lease events (WP32, WP33), pending schedule changes (WP26c),
// attributed approvals and variances (WP43a-2) and system health escalatable; other packages register their own from their own
// modules with registerAdapter.

import { approvalAttributionAdapter } from "./approvalAttribution";
import { defectsPeriodAdapter } from "./defectsPeriod";
import { reviewNoticeAdapter } from "./reviewNotice";
import { jobAdapter } from "./job";
import { leaseEventAdapter } from "./leaseEvent";
import { registerAdapter } from "./registry";
import { rentReviewAdapter } from "./rentReview";
import { scheduleChangeAdapter } from "./scheduleChange";
import { serviceScheduleAdapter } from "./serviceSchedule";
import { systemAdapter } from "./system";
import { tenancyAdapter } from "./tenancy";

registerAdapter(approvalAttributionAdapter);
registerAdapter(defectsPeriodAdapter);
registerAdapter(jobAdapter);
registerAdapter(leaseEventAdapter);
registerAdapter(reviewNoticeAdapter);
registerAdapter(rentReviewAdapter);
registerAdapter(scheduleChangeAdapter);
registerAdapter(serviceScheduleAdapter);
registerAdapter(systemAdapter);
registerAdapter(tenancyAdapter);

export { getAdapter, registerAdapter, registeredSubjectTypes, requireAdapter, unregisterAdapter } from "./registry";
export type { ConditionRef, EscalationAdapter, SubjectSummary } from "./registry";
