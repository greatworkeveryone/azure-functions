// How many AI calls one person has running at once (SC-AI1). The per-minute limit is counted
// from AiCallLog, and a call's row is written only after the model answers, so a person who
// fires many requests together would pass every one of them before any row exists. This cap
// closes that gap: each person may have MAX_IN_FLIGHT_PER_PERSON calls running, and a further
// one is turned away at once, before the database is touched or a model is reached.
//
// The count is per instance. It lives in this process's memory, so a second instance of the
// Function App keeps its own, and a person can have up to twice as many running across two.
// That is accepted: the per-minute count in the database is shared by every instance, and it
// bounds what they can do together.

import type { AiActor } from "./types";

export const MAX_IN_FLIGHT_PER_PERSON = 2;

const running = new Map<string, number>();

/** A person by their AppUsers id, else their email, else the name of the process that is asking. */
export function personKey(actor: AiActor): string {
  if (actor.userId !== null) return `id:${actor.userId}`;
  if (actor.email) return `email:${actor.email.toLowerCase()}`;
  return `name:${actor.kind}:${actor.name}`;
}

/** How many calls this person has running on this instance. */
export function inFlightFor(actor: AiActor): number {
  return running.get(personKey(actor)) ?? 0;
}

/**
 * Takes one of the person's slots, or returns null when they are using all of them. The
 * caller gives the slot back with the function returned, in a finally; giving it back more
 * than once does nothing.
 */
export function takeSlot(actor: AiActor): (() => void) | null {
  const key = personKey(actor);
  const current = running.get(key) ?? 0;
  if (current >= MAX_IN_FLIGHT_PER_PERSON) return null;
  running.set(key, current + 1);
  let given = false;
  return () => {
    if (given) return;
    given = true;
    const left = (running.get(key) ?? 1) - 1;
    if (left <= 0) running.delete(key);
    else running.set(key, left);
  };
}
