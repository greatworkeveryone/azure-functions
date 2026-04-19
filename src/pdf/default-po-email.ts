// Default subject + body for a Purchase Order email, generated on first
// preview if the PO has no saved EmailSubject/EmailBody yet. Plain text —
// Microsoft Graph sendMail will render it as `Text` bodyType. Once the user
// edits either field in the preview modal the persisted values win, so this
// only ever runs once per PO.

export interface DefaultPOEmailInput {
  po: {
    poNumber: string | null;
    contractorName: string | null;
    scope: string | null;
    estimatedCost: number | null;
    costNotToExceed: number | null;
    costJustification: string | null;
    createdBy: string | null;
  };
  job: {
    jobCode: string | null;
    title: string | null;
    buildingName: string | null;
    levelName: string | null;
    exactLocation: string | null;
    category: string | null;
    type: string | null;
    subType: string | null;
    contactName: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
  };
}

function formatAUD(amount: number | null): string {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
  }).format(amount);
}

function joinPath(parts: (string | null | undefined)[], sep: string): string {
  return parts.filter((p): p is string => !!p && p.trim().length > 0).join(sep);
}

export function defaultPOEmail(input: DefaultPOEmailInput): {
  subject: string;
  body: string;
} {
  const { po, job } = input;

  const jobHeading = joinPath([job.jobCode, job.title], " — ") || "this job";
  const subject = `Purchase Order ${po.poNumber ?? ""} — ${jobHeading}`.trim();

  const greetingName = po.contractorName?.trim() || "team";
  const location = joinPath([job.levelName, job.exactLocation], " · ") || "—";
  const category = joinPath([job.category, job.type, job.subType], " › ") || "—";
  const contact =
    joinPath([job.contactName, job.contactPhone, job.contactEmail], " · ") || "—";

  const costLines: string[] = [];
  if (po.estimatedCost != null) {
    costLines.push(`  Estimated: ${formatAUD(po.estimatedCost)}`);
  }
  if (po.costNotToExceed != null) {
    costLines.push(`  Not to exceed: ${formatAUD(po.costNotToExceed)}`);
  }
  if (po.costJustification?.trim()) {
    costLines.push(`  Justification: ${po.costJustification.trim()}`);
  }
  if (costLines.length === 0) {
    costLines.push("  (no cost figures supplied)");
  }

  const body = [
    `Hi ${greetingName},`,
    ``,
    `Please find attached purchase order ${po.poNumber ?? ""} for:`,
    ``,
    `  ${jobHeading}`,
    `  Building: ${job.buildingName ?? "—"}`,
    `  Location: ${location}`,
    `  Category: ${category}`,
    ``,
    `Scope of work:`,
    po.scope?.trim() ? po.scope.trim() : "  —",
    ``,
    `Cost:`,
    ...costLines,
    ``,
    `On-site contact:`,
    `  ${contact}`,
    ``,
    `Regards,`,
    po.createdBy ?? "",
  ].join("\n");

  return { subject, body };
}
