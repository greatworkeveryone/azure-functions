// Inbound email triage (EB3): the one door to EB1's stored sends.
//
// EB1 (send core, migration 108) stores the internet message id of every message it sends on the
// recipient's row. This module is the whole of what EB3 asks of it: given the ids an incoming email
// names in In-Reply-To and References, which send, if any, did it answer? Until EB1 lands this
// answers "none", so replies are stored and shown but linked to nothing.
//
// To connect it, replace the body of `findSendByInternetMessageId` with EB1's lookup (a join from its
// recipient rows to its correspondence and recipient tables) and map the row to LinkedSend. Nothing
// else in EB3 changes: linking, the ranker and the routes only read what this returns.
//
// `ids` are normalised: no angle brackets, lower case, nearest ancestor last (the order of the
// References header). Compare the stored id the same way, and return the match nearest the reply.

import type { Connection } from "tedious";
import type { LinkedSend } from "./types";

export type FindSendByInternetMessageId = (connection: Connection, ids: readonly string[]) => Promise<LinkedSend | null>;

/** Stub: returns nothing until EB1's recipient rows exist (PLAN §13, EB1). */
export const findSendByInternetMessageId: FindSendByInternetMessageId = async () => null;
