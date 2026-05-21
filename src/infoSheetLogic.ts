// Info sheet section helpers (m069).
//
// Sections are stored as JSON in the InfoSheetSections NVARCHAR(MAX) column on
// dbo.Tenants, following the same pattern as MiscFees / Incentives.

export interface InfoSheetRow {
  id: string;
  subheader: string;
  body: string;
  displayOrder: number;
}

export interface InfoSheetSection {
  id: string;
  title: string;
  displayOrder: number;
  rows: InfoSheetRow[];
  strikethrough?: boolean;
}

export function parseInfoSheetSections(json: string | null | undefined): InfoSheetSection[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as InfoSheetSection[]) : [];
  } catch {
    return [];
  }
}

export function upsertInfoSheetSection(
  sections: InfoSheetSection[],
  section: InfoSheetSection,
): InfoSheetSection[] {
  const idx = sections.findIndex((s) => s.id === section.id);
  if (idx === -1) return [...sections, section];
  const next = [...sections];
  next[idx] = { ...sections[idx], ...section };
  return next;
}

export function deleteInfoSheetSection(
  sections: InfoSheetSection[],
  sectionId: string,
): InfoSheetSection[] {
  return sections.filter((s) => s.id !== sectionId);
}

export function upsertInfoSheetRow(
  sections: InfoSheetSection[],
  sectionId: string,
  row: InfoSheetRow,
): InfoSheetSection[] {
  return sections.map((s) => {
    if (s.id !== sectionId) return s;
    const idx = s.rows.findIndex((r) => r.id === row.id);
    const rows =
      idx === -1
        ? [...s.rows, row]
        : s.rows.map((r, i) => (i === idx ? row : r));
    return { ...s, rows };
  });
}

export function deleteInfoSheetRow(
  sections: InfoSheetSection[],
  sectionId: string,
  rowId: string,
): InfoSheetSection[] {
  return sections.map((s) => {
    if (s.id !== sectionId) return s;
    return { ...s, rows: s.rows.filter((r) => r.id !== rowId) };
  });
}
