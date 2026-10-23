// Test kit for the contractor suggestion tests: a stand-in for ../db that answers
// each query by the table it reads, records every statement it was sent, and
// refuses a statement nobody expected so a stray query fails the test.

export type Row = Record<string, unknown>;
export interface Sent {
  params: Record<string, unknown>;
  sql: string;
}
type Answer = Row[] | ((params: Record<string, unknown>, sql: string) => Row[]);

export interface FakeDb {
  executeQuery: jest.Mock;
  /** Answers by regular expression on the SQL text; the latest answer registered wins, so a test can override one. */
  answer(pattern: RegExp, rows: Answer): void;
  reset(): void;
  sent: Sent[];
  sentTo(pattern: RegExp): Sent[];
}

export function createFakeDb(): FakeDb {
  const answers: { pattern: RegExp; rows: Answer }[] = [];
  const sent: Sent[] = [];
  const executeQuery = jest.fn(async (_connection: unknown, sql: string, params: { name: string; value: unknown }[] = []) => {
    const values = Object.fromEntries(params.map((param) => [param.name, param.value]));
    sent.push({ params: values, sql });
    const match = answers.find((answer) => answer.pattern.test(sql));
    if (!match) throw new Error(`Unexpected query: ${sql.slice(0, 120)}`);
    return typeof match.rows === "function" ? match.rows(values, sql) : match.rows;
  });
  return {
    answer: (pattern, rows) => void answers.unshift({ pattern, rows }),
    executeQuery,
    reset: () => {
      answers.length = 0;
      sent.length = 0;
      executeQuery.mockClear();
    },
    sent,
    sentTo: (pattern) => sent.filter((entry) => pattern.test(entry.sql)),
  };
}
