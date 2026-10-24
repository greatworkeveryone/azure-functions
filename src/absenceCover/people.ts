import { ROLES, roleLabel } from "../escalation/roles";
import type { DirectoryUser } from "../escalation/types";
import { holdsCapability } from "./eligibility";

export interface CoverPersonDto {
  name: string;
  role: string;
  roleLabel: string;
  userId: number;
}

/** Colleagues who could be nominated as someone's cover: active, not admin, able to work in the inbox. */
export function possibleCovers(directory: readonly DirectoryUser[], subjectUserId: number): CoverPersonDto[] {
  return directory
    .filter((user) => user.userId !== subjectUserId && user.role !== ROLES.admin && holdsCapability(user.role, "viewEscalations"))
    .sort((a, b) => a.name.localeCompare(b.name) || a.userId - b.userId)
    .map((user) => ({ name: user.name, role: user.role, roleLabel: roleLabel(user.role), userId: user.userId }));
}
