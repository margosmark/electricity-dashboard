/**
 * The account verify routes' response policy — one module so the two layers
 * that set a CSP for these paths cannot drift apart: `src/proxy.ts` and the
 * two route handlers under `src/app/account/verify/route.ts` and
 * `src/app/account/recover/verify/route.ts`. Same "one source, both layers"
 * design as src/lib/oebRouteCsp.ts (F2, t_9ae84620).
 *
 * WHY THE PROXY MUST CARRY THIS VALUE — measured, not assumed (curl against a
 * production `next start` build, 2026-11-09, the F2 re-gate t_3838351d): the
 * proxy sets `Content-Security-Policy` on EVERY response its matcher covers,
 * and Next applies the proxy's headers AFTER the route handler's, so a
 * `content-security-policy` set inside the handler never reaches the wire —
 * CSP was the only name that collided; the same response's `cache-control:
 * no-store` came through intact. Before this module existed, both handlers
 * asserted their belt and the browser got the APP-wide policy
 * (`default-src 'self'; script-src 'self' 'unsafe-inline'; …`) instead — the
 * belt was dead on arrival.
 *
 * The HTML branch of both GETs is config-gated (`emailVerificationEnabled`
 * plus a complete SMTP contract), so the overwrite on THIS path was inferred
 * from the measured mechanism until t_30b7e0d7 booted a configured build and
 * curled it; the fix asserts the value at the layer that actually wins.
 *
 * WHAT THE POLICY IS FOR — both GET handlers serve their own minimal markup:
 * one form plus one inline script that copies the `#token=…` fragment into
 * the explicit POST body (fragments never reach nginx, logs or Referer). So:
 *   - `default-src 'none'` refuses every subresource, and as the fallback it
 *     also covers `object-src`, `base-uri` and `connect-src` — nothing this
 *     document loads and nothing an injected element could reach;
 *   - `script-src 'unsafe-inline'` — the single inline fragment-handoff
 *     script above is the whole JS surface, and it is ours;
 *   - `form-action 'self'` — the POST must reach the same route, nowhere else.
 * Framing stays covered by `X-Frame-Options: DENY` from next.config.ts on
 * every response (this policy carries no `frame-ancestors` of its own — the
 * exact belt these handlers always asserted, unchanged).
 *
 * The proxy applies the policy by PATH, so the non-HTML answers on these two
 * routes (the config-off 404, the SMTP-unavailable 503, the JSON POSTs) carry
 * it too. That is deliberate and inert: a CSP only constrains a document, and
 * those are not documents.
 */

/** Exact-path keys for the per-path CSP map in `src/proxy.ts`. */
export const ACCOUNT_VERIFY_PATH = "/account/verify";
export const ACCOUNT_RECOVER_VERIFY_PATH = "/account/recover/verify";

/**
 * The belt both verify handlers assert on their HTML — byte-identical to the
 * literal they shipped before this module existed, and now also the value the
 * proxy sets for these paths, so whichever layer wins the header name (measured:
 * the proxy), the browser gets this policy.
 */
export const ACCOUNT_VERIFY_CSP = "default-src 'none'; script-src 'unsafe-inline'; form-action 'self'";
