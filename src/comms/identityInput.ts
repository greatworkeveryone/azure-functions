// What an admin may type for a reply-to identity. The address must be a company mailbox; the
// allowed roles come from a short list; the team signature is plain lines, a phone and an email.

import { AppRole } from "../auth";
import { isOrgAddress, IDENTITY_ROLES } from "./identity";
import { mailbox, optionalLine, plainLine } from "./fields";
import type { IdentityInput } from "./identityStore";
import { parseRoleSignature } from "./signature";
import { unexpectedKey, type Parsed } from "./request";

export const IDENTITY_KEYS = ["address", "displayName", "teamLabel", "allowedRoles", "signature", "isActive"] as const;

export function parseIdentityInput(body: Record<string, unknown>, extraKeys: readonly string[]): Parsed<IdentityInput> {
  const extra = unexpectedKey(body, [...IDENTITY_KEYS, ...extraKeys]);
  if (extra) return { error: extra, ok: false };
  const address = mailbox(body.address, "Address");
  if (!address.ok) return address;
  if (!isOrgAddress(address.value)) return { error: "The address must be a Randazzo Properties mailbox", ok: false };
  const displayName = plainLine(body.displayName, "Name", 120);
  if (!displayName.ok) return displayName;
  const teamLabel = optionalLine(body.teamLabel, "Team", 80);
  if (!teamLabel.ok) return teamLabel;
  const roles = body.allowedRoles;
  if (!Array.isArray(roles) || roles.length === 0) return { error: "Choose at least one role that may send as this address", ok: false };
  const unknown = roles.find((role) => !(IDENTITY_ROLES as readonly unknown[]).includes(role));
  if (unknown !== undefined) return { error: `"${String(unknown).slice(0, 30)}" can't be given this address`, ok: false };
  const sig = body.signature;
  if (sig === null || typeof sig !== "object" || Array.isArray(sig)) return { error: "The team signature is required", ok: false };
  const sigExtra = unexpectedKey(sig as Record<string, unknown>, ["lines", "phone", "email"]);
  if (sigExtra) return { error: "The team signature is plain lines, a phone and an email", ok: false };
  const signature = parseRoleSignature(sig as { email: unknown; lines: unknown; phone: unknown });
  if (!signature.ok) return signature;
  if (body.isActive !== undefined && typeof body.isActive !== "boolean") return { error: "isActive must be true or false", ok: false };
  return {
    ok: true,
    value: {
      address: address.value,
      allowedRoles: [...new Set(roles)] as AppRole[],
      displayName: displayName.value,
      isActive: body.isActive !== false,
      signature: signature.value,
      teamLabel: teamLabel.value,
    },
  };
}
