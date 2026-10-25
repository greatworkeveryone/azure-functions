import { TYPES } from "tedious";
import type { SqlParam } from "../../db";

/** `@U0, @U1, ...` and its parameters, for an IN list of ids. Only placeholders reach the SQL text. */
export function intList(prefix: string, ids: readonly number[]): { params: SqlParam[]; placeholders: string } {
  const params: SqlParam[] = ids.map((id, index) => ({ name: `${prefix}${index}`, type: TYPES.Int, value: id }));
  return { params, placeholders: ids.length === 0 ? "NULL" : params.map((param) => `@${param.name}`).join(", ") };
}
