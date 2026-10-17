import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { completeMyobLink } from "../myob-link";
import { MyobTokenCryptoError } from "../myob-token-crypto";

// MYOB redirects the user here after they sign in and approve the app, with
// ?code&state&businessId. src/myob-link.ts does the work: the state must be
// unused, unexpired and minted for an admin; businessId must be the expected
// company file; the token must carry only the agreed scopes. Only then are the
// tokens stored (encrypted) and the link ledgered.
//
// Anonymous because MYOB drives this redirect and carries no Entra token.
// Register the full URL of this endpoint as the MYOB app's Redirect Uri, e.g.
// https://<func>.azurewebsites.net/api/myobAuthCallback

function htmlPage(body: string, statusCode = 200): HttpResponseInit {
  return {
    status: statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<!doctype html><html><head><meta charset="utf-8"><title>MYOB</title>
<style>body{font-family:system-ui,sans-serif;background:#0e0f12;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:24px;text-align:center}main{max-width:480px}h1{font-size:18px;margin:0 0 12px;font-weight:600}p{font-size:14px;color:#9aa0a6;margin:0 0 16px;line-height:1.5}code{background:#1a1d22;padding:2px 6px;border-radius:4px;font-family:ui-monospace,monospace;font-size:12px}</style>
</head><body><main>${body}</main>
<script>setTimeout(function(){try{window.close()}catch(e){}},2500)</script>
</body></html>`,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function myobAuthCallback(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const code = request.query.get("code");
  const state = request.query.get("state");
  const error = request.query.get("error");

  if (error) {
    context.warn(`MYOB OAuth returned error: ${error} — ${request.query.get("error_description")}`);
    return htmlPage(
      `<h1>MYOB authorization failed</h1><p>${escapeHtml(error)}: ${escapeHtml(request.query.get("error_description") ?? "")}</p>`,
      400,
    );
  }
  if (!code || !state) {
    return htmlPage(
      `<h1>Missing parameters</h1><p>The callback was hit without a <code>code</code> or <code>state</code> — try authorizing again from the admin page.</p>`,
      400,
    );
  }

  try {
    const outcome = await completeMyobLink({ businessId: request.query.get("businessId"), code, state });
    if (!outcome.ok) {
      context.warn(`MYOB link refused (${outcome.status}): ${outcome.title} — ${outcome.detail}`);
      return htmlPage(`<h1>${escapeHtml(outcome.title)}</h1><p>${escapeHtml(outcome.detail)}</p>`, outcome.status);
    }
    const who = outcome.myobUsername ? ` as <code>${escapeHtml(outcome.myobUsername)}</code>` : "";
    return htmlPage(
      `<h1>MYOB ${outcome.relinked ? "re-linked" : "connected"}.</h1><p>Company file <code>${escapeHtml(outcome.businessId)}</code>${who}. You can close this tab and reload the admin page.</p>`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.error("MYOB link failed:", message);
    // Settings problems are the admin's to fix; anything else stays in the log.
    const shown = err instanceof MyobTokenCryptoError ? message : "Nothing was linked. The details are in the function log.";
    return htmlPage(`<h1>MYOB link failed</h1><p>${escapeHtml(shown)}</p>`, 500);
  }
}

export { myobAuthCallback };

app.http("myobAuthCallback", {
  authLevel: "anonymous",
  handler: myobAuthCallback,
  methods: ["GET"],
});
