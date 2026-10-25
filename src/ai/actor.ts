// The signed-in caller as an AI actor (SC-AI1): the same id, name and role the
// decision ledger records (resolveLedgerActor), plus their email from the token.
// Null when the token doesn't verify; the handler answers 401.

import { userInfoFromToken } from "../auth";
import { resolveLedgerActor } from "../ledger/actor";
import type { HttpRequest } from "@azure/functions";
import type { Connection } from "tedious";
import type { AiActor } from "./types";

/**
 * `token` is the bearer token requireRole has just verified, so decoding its email
 * claim here is the same trust step every other handler takes (see auth.ts).
 */
export async function resolveAiActor(request: HttpRequest, token: string, connection: Connection): Promise<AiActor | null> {
  const actor = await resolveLedgerActor(request, connection);
  if (!actor || actor.kind !== "user") return null;
  return {
    email: userInfoFromToken(token)?.email ?? null,
    kind: "user",
    name: actor.name,
    role: actor.role || null,
    userId: actor.userId,
  };
}
