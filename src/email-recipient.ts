// Resolves the recipient address for outbound email (PO send, quote send,
// etc.). When DEV_EMAIL_OVERRIDE is set in local.settings.json / app config,
// every outbound email is rewritten to the override address so local dev and
// staging never hit real contractors. In prod, leave the variable unset and
// the real address passes through unchanged.
//
// Call this at the SEND seam only — not at read/list time. The UI should keep
// showing the real contractor email; only the outbound "To:" gets rewritten.

export interface ResolvedRecipient {
  address: string | null;
  overridden: boolean;
  original: string | null;
}

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolveRecipient(
  realAddress: string | null | undefined,
): ResolvedRecipient {
  const original = normalize(realAddress);
  const override = normalize(process.env.DEV_EMAIL_OVERRIDE);
  if (override) {
    return { address: override, overridden: original !== override, original };
  }
  return { address: original, overridden: false, original };
}
