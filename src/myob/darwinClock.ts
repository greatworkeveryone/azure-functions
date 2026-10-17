// Darwin wall-clock strings for what Floorplan writes into MYOB: every
// created record is dated today in Darwin (decision 11), and attribution
// stamps read "14/10 09:12" in Darwin time (decision 13).

const PARTS = new Intl.DateTimeFormat("en-AU", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  timeZone: "Australia/Darwin",
  year: "numeric",
});

function parts(instant: Date): Record<string, string> {
  return Object.fromEntries(PARTS.formatToParts(instant).map((part) => [part.type, part.value]));
}

/** "2026-10-14" */
export function darwinIsoDate(instant: Date): string {
  const p = parts(instant);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "14/10 09:12" */
export function darwinStamp(instant: Date): string {
  const p = parts(instant);
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
}

/** "14/10/2026" */
export function darwinDisplayDate(instant: Date): string {
  const p = parts(instant);
  return `${p.day}/${p.month}/${p.year}`;
}

/** MYOB's date format for a created record: today in Darwin at midnight. */
export function myobDocumentDate(instant: Date): string {
  return `${darwinIsoDate(instant)}T00:00:00`;
}
