// Bounded body reads for the anonymous tenant endpoints (TR3). Content-Length is a hint a client can lie
// about or omit (chunked), so the bytes are counted as they arrive and the read stops at the cap.

import type { HttpRequest } from "@azure/functions";

/** The body as bytes, or "too_large" the moment it passes `maxBytes`, whatever the headers claim. */
export async function readCappedBody(request: HttpRequest, maxBytes: number): Promise<Buffer | "too_large"> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) return "too_large";
  const stream = request.body;
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value as Uint8Array);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return "too_large";
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }
  const bytes = Buffer.from(await request.arrayBuffer());
  return bytes.length > maxBytes ? "too_large" : bytes;
}
