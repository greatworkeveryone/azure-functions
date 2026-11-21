import type { SourceAdapter } from "../types";
import { approvalsSource } from "./approvals";
import { decisionsSource } from "./decisions";
import { escalationsSource } from "./escalations";
import { intakeSource } from "./intake";
import { invoicesSource } from "./invoices";
import { jobsSource } from "./jobs";
import { leaveSource } from "./leave";
import { quotesSource } from "./quotes";
import { tenancySource } from "./tenancy";
import { timesheetsSource } from "./timesheets";

/** One adapter per source. Adding a source is adding it here. Each is small and tested on its own. */
/** Each adapter's facts are its own type; the loader only carries them from `load` to `derive`. */
export const SOURCES = [
  jobsSource,
  quotesSource,
  invoicesSource,
  decisionsSource,
  escalationsSource,
  leaveSource,
  timesheetsSource,
  tenancySource,
  approvalsSource,
  intakeSource,
] as unknown as readonly SourceAdapter<unknown>[];
