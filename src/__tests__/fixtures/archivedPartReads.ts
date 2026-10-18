// D10: how a read of dbo.TenantOccupancies or dbo.Carparks says it leaves archived
// rows out. The predicate must name the table's own alias in that statement
// (`o.ArchivedAt IS NULL`), or, when the table has no alias, stand unqualified
// (`ArchivedAt IS NULL`). Another table's `t.ArchivedAt IS NULL` (D4's archived
// tenancy) in the same query says nothing about the areas: the review of D10
// found exactly that hiding an unfiltered occupancy read.

export const PART_READ = /\b(?:FROM|JOIN)\s+dbo\.(TenantOccupancies|Carparks)\b(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/g;

const NOT_AN_ALIAS = new Set([
  "CROSS", "FULL", "GROUP", "INNER", "JOIN", "LEFT", "ON", "ORDER", "OUTER", "OUTPUT", "RIGHT", "SET", "UNION", "VALUES", "WHERE", "WITH",
]);

/** The alias the table takes in this read, or null when it has none. */
export function aliasOf(match: RegExpMatchArray): string | null {
  const word = match[2];
  return word && !NOT_AN_ALIAS.has(word.toUpperCase()) ? word : null;
}

/** Whether the statement, from the read on, leaves that table's archived rows out. */
export function filtersArchived(statementFromRead: string, alias: string | null): boolean {
  const predicate = alias ? new RegExp(`\\b${alias}\\.ArchivedAt IS NULL\\b`) : /(?<![\w.\]])ArchivedAt IS NULL\b/;
  return predicate.test(statementFromRead);
}

/** From the read to the end of its template literal. */
export function statementAt(text: string, index: number): string {
  const end = text.indexOf("`", index);
  return text.slice(index, end === -1 ? undefined : end);
}

/** For a fake database: does this SQL leave the table's archived rows out? */
export function sqlFiltersArchived(sql: string, table: "Carparks" | "TenantOccupancies"): boolean {
  const reads = [...sql.matchAll(PART_READ)].filter((match) => match[1] === table);
  return reads.length > 0 && reads.every((match) => filtersArchived(statementAt(sql, match.index ?? 0), aliasOf(match)));
}
