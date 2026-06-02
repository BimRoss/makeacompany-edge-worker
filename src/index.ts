// makeacompany-edge-worker
//
// Backstop GA4 gtag injector for *.makeacompany.ai. Every makeacompany.ai
// subdomain should already be tagged with G-29N1GMQ3NE at source/artifact —
// this Worker exists to catch (a) future untagged subdomains and (b) any
// Pages project that drifts after a manual redeploy.
//
// Safety-first design:
//  - Only injects on 200 + text/html responses.
//  - Skips functional/auth/oauth paths so we never touch API surfaces.
//  - Skips hosts known to be internal/OAuth (google-mcp-*).
//  - Self-detects an existing G-29N1GMQ3NE tag and bypasses to avoid double-tagging.
//  - On ANY exception, returns the original unrewritten response. Never 500s.
//  - Stamps `x-ross-ga-injection` with the decision for post-hoc analysis.

const MEASUREMENT_ID = "G-29N1GMQ3NE";

// Path prefixes that should never receive HTML injection. Anchored at start.
const BYPASS_PATH_PREFIXES = [
  "/api/",
  "/auth/",
  "/oauth/",
  "/_/",
  "/.well-known/",
  "/healthz",
  "/admin/",
];

// Hostnames that should never receive injection (internal / OAuth flows).
const BYPASS_HOSTS = new Set<string>([
  "google-mcp-dev.makeacompany.ai",
  "google-mcp-oauth.makeacompany.ai",
]);

type InjectionDecision =
  | "hit"
  | "skip-tagged"
  | "skip-non-html"
  | "skip-non-200"
  | "skip-bypass"
  | "error";

// Mirrors BimRoss/catalinacrew/blob/main/index.html — canonical recipe.
const GTAG_SNIPPET = `
    <!-- Google tag (gtag.js) — injected by makeacompany-edge-worker -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', '${MEASUREMENT_ID}');

      // Synthetic health event: one non-interaction ping per browser session.
      try {
        var gaHealthKey = 'ga_health_ping_sent';
        if (!sessionStorage.getItem(gaHealthKey)) {
          var gaDebug = window.location.search.indexOf('ga_debug=1') !== -1;
          gtag('event', 'ga_health_ping', {
            event_category: 'observability',
            event_label: 'frontend_boot',
            non_interaction: true,
            debug_mode: gaDebug
          });
          sessionStorage.setItem(gaHealthKey, '1');
        }
      } catch (err) {
        // Ignore storage restrictions in private/locked-down browser contexts.
      }
    </script>
  `;

function shouldBypass(request: Request): boolean {
  const url = new URL(request.url);

  if (BYPASS_HOSTS.has(url.hostname)) return true;
  if (url.searchParams.get("_no_ga") === "1") return true;
  if (request.headers.get("x-ross-no-injection") === "1") return true;

  for (const prefix of BYPASS_PATH_PREFIXES) {
    if (url.pathname.startsWith(prefix)) return true;
  }
  return false;
}

function stamp(response: Response, decision: InjectionDecision): Response {
  // Clone headers so we can mutate (original headers may be immutable).
  const headers = new Headers(response.headers);
  headers.set("x-ross-ga-injection", decision);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, _env: unknown, _ctx: ExecutionContext): Promise<Response> {
    // Fetch from origin first. If this throws, let the platform handle it
    // (we have no response to fall back to).
    const originResponse = await fetch(request);

    try {
      // Rule 2: non-200 → passthrough untouched.
      if (originResponse.status !== 200) {
        return stamp(originResponse, "skip-non-200");
      }

      // Rule 3: non-HTML → passthrough untouched.
      const contentType = originResponse.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("text/html")) {
        return stamp(originResponse, "skip-non-html");
      }

      // Rule 4: bypass paths/hosts/overrides → passthrough.
      if (shouldBypass(request)) {
        return stamp(originResponse, "skip-bypass");
      }

      // Rule 5: stream + detect existing tag + inject before </head>.
      // We buffer the response text so we can do an honest substring check
      // for the measurement ID before deciding to inject. HTMLRewriter alone
      // can't peek across element boundaries reliably.
      const bodyText = await originResponse.clone().text();

      if (bodyText.includes(MEASUREMENT_ID)) {
        // Already tagged at source — do not double-inject.
        return stamp(
          new Response(bodyText, {
            status: originResponse.status,
            statusText: originResponse.statusText,
            headers: originResponse.headers,
          }),
          "skip-tagged",
        );
      }

      // No tag found — inject immediately before </head>.
      const headCloseIdx = bodyText.search(/<\/head\s*>/i);
      if (headCloseIdx === -1) {
        // No </head> to anchor on. Don't risk a malformed inject; passthrough.
        return stamp(
          new Response(bodyText, {
            status: originResponse.status,
            statusText: originResponse.statusText,
            headers: originResponse.headers,
          }),
          "skip-non-html",
        );
      }

      const injected =
        bodyText.slice(0, headCloseIdx) + GTAG_SNIPPET + bodyText.slice(headCloseIdx);

      // Drop Content-Length (body size changed) but keep everything else.
      const outHeaders = new Headers(originResponse.headers);
      outHeaders.delete("content-length");

      return stamp(
        new Response(injected, {
          status: originResponse.status,
          statusText: originResponse.statusText,
          headers: outHeaders,
        }),
        "hit",
      );
    } catch (_err) {
      // Rule 6: any exception → return the original, unrewritten response.
      // Best-effort stamp; if stamping itself throws (it shouldn't), fall
      // all the way back to the raw response.
      try {
        return stamp(originResponse, "error");
      } catch {
        return originResponse;
      }
    }
  },
} satisfies ExportedHandler;
