# makeacompany-edge-worker

Cloudflare Worker that **idempotently** injects the makeacompany.ai GA4 tag
(`G-29N1GMQ3NE`) on HTML responses across `*.makeacompany.ai`.

This Worker is a **backstop**, not the primary tagging mechanism. Every
makeacompany.ai subdomain should already include the gtag at source (see
`BimRoss/catalinacrew/blob/main/index.html` for the canonical recipe). The
Worker exists to:

- Catch future untagged subdomains that ship without remembering the snippet.
- Re-tag any Pages project that drifts after a manual redeploy of an older
  artifact.

## Behavior

For every request that matches the route:

1. Fetch the origin response.
2. If status is not `200`, pass through unchanged.
3. If `Content-Type` does not start with `text/html`, pass through.
4. If the request matches a bypass rule (see below), pass through.
5. If the response body already contains `G-29N1GMQ3NE`, pass through
   (this is the idempotency guarantee — already-🟢 sites are not re-tagged).
6. Otherwise, inject the gtag snippet immediately before `</head>`.

On any exception during rewrite, the original response is returned unmodified.
The Worker never produces a 5xx of its own.

Every response is stamped with `x-ross-ga-injection`. Possible values:

| Value | Meaning |
| --- | --- |
| `hit` | Snippet was injected. |
| `skip-tagged` | Already tagged at source; left alone. |
| `skip-non-html` | Response was not HTML (or had no `</head>`). |
| `skip-non-200` | Non-200 status; left alone. |
| `skip-bypass` | Path / host / override matched a bypass rule. |
| `error` | Exception during rewrite; original response returned. |

## Bypass rules

- Path prefixes (skip injection): `/api/`, `/auth/`, `/oauth/`, `/_/`,
  `/.well-known/`, `/healthz`, `/admin/`.
- Hostnames: `google-mcp-dev.makeacompany.ai`, `google-mcp-oauth.makeacompany.ai`.
- Query param: `?_no_ga=1`.
- Request header: `x-ross-no-injection: 1`.

## Debugging

```
curl -sI https://<host>/                       # see x-ross-ga-injection header
curl -sI "https://<host>/?_no_ga=1"            # force skip-bypass
curl -sL https://<host>/ | grep -c G-29N1GMQ3NE  # should be exactly 1
```

## Rollout

The Worker ships **without routes baked in**. Routes are applied out-of-band
via the Cloudflare API so we can canary safely:

1. **Phase 1 — Build & deploy script only.** `wrangler deploy` publishes the
   Worker. With no routes attached, it serves zero traffic.
2. **Phase 2 — Canary on `adam.makeacompany.ai/*`.** Verify that the header
   reads `skip-tagged` and that `G-29N1GMQ3NE` still appears exactly once
   in the body. If either check fails, delete the route immediately.
3. **Phase 3 — Expand to `*.makeacompany.ai/*`.** Only after Phase 2 review.
   Performed in a separate session by an operator.

### Disabling

Delete the route via the Cloudflare dashboard, or:

```
curl -X DELETE \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/workers/routes/$ROUTE_ID" \
  -H "Authorization: Bearer $CF_TOKEN"
```

Deleting the route is sufficient — the Worker script can stay published.
