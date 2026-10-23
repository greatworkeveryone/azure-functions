// Recurring-fault signals (SC-AI5): the two numbers that decide what counts as
// "the same thing breaking again and again". Kept in one file so the rule is
// changed in one place; the frontend reads the window from the response and
// never repeats either number.

/**
 * Three jobs, not two. A second job on the same asset or place is often a
 * callback or one bad day, and flagging every pair would bury the real
 * patterns. By the third, someone should ask whether to repair or replace it.
 */
export const RECURRING_FAULT_MIN_JOBS = 3;

/**
 * A year of jobs, counted in Darwin days. Long enough that a fault which
 * returns each wet season stays in view; short enough that one fixed long ago
 * drops out instead of flagging an asset for ever.
 */
export const RECURRING_FAULT_WINDOW_DAYS = 365;
