// Who may take keys out and put them back: the field officers who carry them
// (plain facilities), their managers, directors and admin. Sprint U3 / decision
// 1. Until then both handlers were manager-only, so an officer filled in the
// whole form, signed, and was refused at the last step. Mirrored by the
// frontend capabilities checkoutKeys / checkinKeys (constants/roles.ts).

import { AppRole } from "./auth";

export const CHECKOUT_KEYS_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
] as const;

export const CHECKIN_KEYS_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
] as const;
