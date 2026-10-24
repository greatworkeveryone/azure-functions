// echo_test: the admin health check (Admin → AI activity → "Run a test call").
// It proves the whole path works (switch, redaction, provider, answer checks,
// log row) without touching any record. A new purpose is a file like this one in
// this folder, and nothing else: see src/ai/registry.ts.

import { definePurpose } from "../types";
import { accept, boundedString, isRecord, refuse, unknownKeys } from "../validate";

export interface EchoTestOutput {
  echo: string;
}

export const purpose = definePurpose<EchoTestOutput>({
  expectsJson: true,
  id: "echo_test",
  maxInputChars: 200,
  maxOutputTokens: 100,
  mock: (input) => JSON.stringify({ echo: input }),
  promptVersion: "echo_test@1",
  systemPrompt:
    'You are the health check for a property management app. Answer with one JSON object, {"echo": "<the user\'s message, word for word>"}, and nothing else.',
  validate: (value) => {
    if (!isRecord(value)) return refuse("The answer is not a JSON object.");
    if (unknownKeys(value, ["echo"]).length > 0) return refuse("The answer has fields it should not.");
    const echo = boundedString(value.echo, 1_000);
    if (echo === null || echo.trim() === "") return refuse("The answer has no echo text.");
    return accept({ echo });
  },
});
