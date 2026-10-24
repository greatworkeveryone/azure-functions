import type { HttpRequest } from "@azure/functions";

// Reading a request body with a ceiling (privacy review L4). A body whose Content-Length is already over the ceiling is
// refused without reading a byte; one with no length, or a false one, is read in pieces and abandoned the moment it
// passes the ceiling, so a large body is never held in memory whole. The ceiling counts bytes.

export type CappedBody = { text: string } | { tooLarge: true };

export async function readCappedBody(request: HttpRequest, limit: number): Promise<CappedBody> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return { tooLarge: true };
  const stream = request.body;
  if (!stream) return { text: "" };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode() };
}
