/** Validate additive declaration metadata without changing payroll/approval authority. */
const DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
const TYPES = ['work','overtime','annual_leave','personal_leave','public_holiday','unpaid_leave','toil','not_worked'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export function validateTimesheetData(data: unknown, complete = false): string | null {
 if (!data || typeof data !== 'object' || Array.isArray(data)) return 'Timesheet data must be a day-by-day object';
 for (const [day, entries] of Object.entries(data)) {
  if (!DAYS.includes(day) || !Array.isArray(entries) || entries.length > 24) return 'Use known days with at most 24 entries per day';
  for (const entry of entries) {
   if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'Invalid timesheet entry';
   const type = entry.type ?? 'work';
   if (!TYPES.includes(type)) return 'Choose a known work or leave type';
   if (typeof entry.startTime !== 'string' || typeof entry.endTime !== 'string' || !/^[0-9:]{0,5}$/.test(entry.startTime) || !/^[0-9:]{0,5}$/.test(entry.endTime)) return 'Use clock times up to five characters';
   if (!Number.isInteger(entry.breakMinutes) || entry.breakMinutes < 0 || entry.breakMinutes > 1440) return 'Invalid break minutes';
   if (typeof entry.comment !== 'string' || entry.comment.length > 2000) return 'Notes must be at most 2,000 characters';
   if (entry.declaredMinutes !== undefined && (!Number.isInteger(entry.declaredMinutes) || entry.declaredMinutes < 0 || entry.declaredMinutes > 1440)) return 'Declared hours must be between zero and 24';
   if (type === 'not_worked') {if(entry.startTime || entry.endTime || entry.declaredMinutes || entry.breakMinutes) return 'Not-worked entries cannot contain hours';continue;}
   const leave = !['work','overtime'].includes(type);
   if (leave) {
    if (entry.startTime || entry.endTime || entry.breakMinutes) return 'Record leave as hours, without clock times or breaks';
    if (complete && !(entry.declaredMinutes > 0)) return 'Enter the leave hours before submitting';
   } else if (complete) {
    if (!TIME.test(entry.startTime) || !(TIME.test(entry.endTime) || entry.endTime === "24:00")) return 'Complete the start and finish times before submitting';
    const minutes = (value:string) => Number(value.slice(0,2))*60+Number(value.slice(3));
    if (minutes(entry.endTime) - minutes(entry.startTime) <= entry.breakMinutes) return 'Finish must follow start and cover the unpaid break';
   }
  }
 }
 return null;
}
