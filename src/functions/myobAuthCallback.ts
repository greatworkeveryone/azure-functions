import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { exchangeCodeForTokens, verifyAuthState } from "../myob-auth";

// MYOB redirects the user here after they sign in and approve the app.
// We exchange the authorization code for tokens, persist them, and serve a
// small HTML page that closes the popup tab.
//
// This route is intentionally anonymous — MYOB itself drives the redirect
// and won't carry our Entra bearer token. Security is provided by:
//   1. The state parameter, signed with MYOB_CLIENT_SECRET (10-min TTL)
//   2. The code being single-use and tied to our MYOB_CLIENT_ID
//
// In the MYOB developer portal, register the Redirect Uri as the full URL of
// this endpoint, e.g. https://<func>.azurewebsites.net/api/myobAuthCallback

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

async function myobAuthCallback(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const code = request.query.get("code");
  const state = request.query.get("state");
  const error = request.query.get("error");
  const errorDescription = request.query.get("error_description");

  if (error) {
    context.warn(`MYOB OAuth returned error: ${error} — ${errorDescription}`);
    return htmlPage(
      `<h1>MYOB authorization failed</h1><p>${error}: ${errorDescription ?? ""}</p>`,
      400,
    );
  }

  if (!code || !state) {
    return htmlPage(
      `<h1>Missing parameters</h1><p>The callback was hit without a <code>code</code> or <code>state</code> — try authorizing again from the admin page.</p>`,
      400,
    );
  }

  if (!verifyAuthState(state)) {
    return htmlPage(
      `<h1>State check failed</h1><p>The state parameter didn't match or has expired (10-min TTL). Restart the flow from the admin page.</p>`,
      400,
    );
  }

  try {
    // The callback runs without a user JWT — MYOB drives this redirect —
    // so token storage falls back to the service-principal SQL connection.
    await exchangeCodeForTokens({ code, authorizedBy: null, sqlToken: null });
    return htmlPage(
      `<h1>MYOB connected.</h1><p>You can close this tab. Reload the admin page to see the linked status.</p>`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.error("MYOB token exchange failed:", message);
    return htmlPage(
      `<h1>Token exchange failed</h1><p>${escapeHtml(message)}</p>`,
      500,
    );
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

app.http("myobAuthCallback", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: myobAuthCallback,
});
