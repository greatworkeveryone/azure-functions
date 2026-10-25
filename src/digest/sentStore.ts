// The one write the morning digest makes: once a person's email has gone, stamp
// their row with the Darwin day it went on, so a second run the same day skips them
// (dedup.ts). One statement, one column, one row, all parameters. It runs only in
// a live run, never in a dry run, and never where DEV_EMAIL_OVERRIDE redirects the mail.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { parseDarwinDate } from "../ledger/darwinTime";

/** `darwinDay` is a Darwin calendar day, YYYY-MM-DD. */
export async function recordDigestSent(connection: Connection, userId: number, darwinDay: string): Promise<void> {
  if (parseDarwinDate(darwinDay) === null) throw new RangeError(`Not a date: ${JSON.stringify(darwinDay)}`);
  await executeQuery(
    connection,
    "UPDATE dbo.AppUsers SET DigestLastSentOn = CONVERT(DATE, @SentOn, 23) WHERE UserID = @UserID",
    [
      { name: "SentOn", type: TYPES.NVarChar, value: darwinDay },
      { name: "UserID", type: TYPES.Int, value: userId },
    ],
  );
}
