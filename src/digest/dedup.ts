// One digest per person per Darwin day. A restart inside the morning window can
// fire the timer again, and a run that died part-way is replayed; the date stamped
// on each person (AppUsers.DigestLastSentOn, migration 143) is how the second run
// knows who it already told. Pure.

/**
 * Whether this person's last digest went today (both are Darwin days, YYYY-MM-DD).
 * Only a stamp for exactly today suppresses anything: an earlier day means it is
 * time again, and a later or malformed one is ignored rather than allowed to
 * silence a morning that has not happened. A wrong record can cost a duplicate,
 * never a missing email.
 */
export function alreadySentToday(lastSentOn: string | null, today: string): boolean {
  return lastSentOn === today;
}

/** Staging and local runs set DEV_EMAIL_OVERRIDE so every address is one inbox. There the
 *  same morning must be sendable again (and a database restored from production may
 *  already carry today's stamps), so the guard stands aside and nothing is stamped. */
export function dedupApplies(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.DEV_EMAIL_OVERRIDE ?? "").trim() === "";
}
