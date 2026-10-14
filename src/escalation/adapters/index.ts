// Registers the adapters this package ships. Importing this module is what makes
// jobs and system health escalatable; other packages register their own from
// their own modules with registerAdapter.

import { defectsPeriodAdapter } from "./defectsPeriod";
import { jobAdapter } from "./job";
import { registerAdapter } from "./registry";
import { serviceScheduleAdapter } from "./serviceSchedule";
import { systemAdapter } from "./system";

registerAdapter(defectsPeriodAdapter);
registerAdapter(jobAdapter);
registerAdapter(serviceScheduleAdapter);
registerAdapter(systemAdapter);

export { getAdapter, registerAdapter, registeredSubjectTypes, requireAdapter, unregisterAdapter } from "./registry";
export type { ConditionRef, EscalationAdapter, SubjectSummary } from "./registry";
