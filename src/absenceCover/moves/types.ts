import type { Connection } from "tedious";

export type MoveActor = { kind: "system" } | { kind: "user"; name: string; userId: number | null };

/** What a domain move needs. `reason` is the sentence the item's own history gets. */
export interface MoveArgs {
  actorName: string;
  detail: Record<string, number | string | null>;
  from: { name: string; userId: number };
  itemId: string;
  reason: string;
  /** Giving the item back: the cover is taken off it instead of the owner staying on it. */
  takeBack?: boolean;
  to: { name: string; userId: number };
}

/**
 * Changes who has an item through the domain's own write, inside the caller's open
 * transaction. True when it moved; false when the item is no longer where the move
 * expects (someone else got there first), in which case nothing was written.
 */
export type Mover = (connection: Connection, args: MoveArgs) => Promise<boolean>;
