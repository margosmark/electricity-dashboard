# Security review — Ontario Energy Optimizer (electricity-dashboard)

Scope: the deployed app at https://electricity.markarslan.ca/ — a Next.js
frontend that parses **untrusted files in the browser** (Green Button XML from
a utility portal, JSON backups picked from disk) and a service worker that
decides what may be cached. There is no account system and **no server-side
user data**: readings live only in `localStorage`.

This checklist is executable: every line marked *(tested)* is enforced by
`webapp/src/lib/security.test.tsx` or `webapp/src/lib/backup.test.ts` — if you
change the code under one of them, CI fails. Read the test, not just this file.

## 1. Parsing untrusted XML (Green Button / ESPI)

| # | Rule | Status |
|---|---|---|
| 1.1 | The XML parser is a **data** parser (`fast-xml-parser`), never a DOM/HTML parser. No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `dangerouslySetInnerHTML`, `srcdoc`, `createContextualFragment`, `eval`, `new Function` anywhere in `webapp/src`. | *(tested — source scan)* |
| 1.2 | Feed-derived strings (UsagePoint id, labels, file names) render only through React text nodes / attributes, which escape markup. A feed carrying `<img onerror=…>` shows up as **visible text**. | *(tested — hostile feed rendered through `UsagePointPicker`)* |
| 1.3 | **External entities (XXE) are refused.** `fast-xml-parser` throws `"External entities are not supported"` — no file or network fetch ever happens. | *(tested)* |
| 1.4 | **Entity expansion is bounded.** A billion-laughs document parses to a small object; no megabyte string, no hang. | *(tested)* |
| 1.5 | Non-numeric `<value>` / `<start>` content can never become `NaN` — a single poisoned reading would silently zero every total it touches. Bad readings are dropped, the rest of the file still loads. | *(tested)* |
| 1.6 | Namespace prefixes are stripped before lookup (`removeNSPrefix: true`), so `espi:IntervalReading` and `IntervalReading` behave identically. | *(tested — utility samples)* |

## 2. Parsing untrusted JSON (backup import)

| # | Rule | Status |
|---|---|---|
| 2.1 | The file must carry our `schema` marker **and** an integer `version` this build understands. Anything else is refused with a message that says what was expected. Newer versions are refused, never half-imported. | *(tested — `backup.test.ts`)* |
| 2.2 | **No prototype pollution.** Import copies only whitelisted keys via explicit property reads; `__proto__` / `constructor` / `prototype` payloads in the file are never assigned to anything, and `Object.prototype` is asserted clean afterwards. | *(tested)* |
| 2.3 | Import is **all-or-nothing**: every row and field is validated before the first `localStorage` write, so a rejected file leaves the existing profile byte-identical. | *(tested — `useEnergyData.backup.test.ts`)* |
| 2.4 | Unknown top-level and nested keys are dropped, never carried into app state. | *(tested)* |

## 3. Service worker (cache poisoning / staleness)

The worker (`webapp/public/sw.js`) is executed against hostile synthetic
requests in the test, not merely read:

| # | Rule | Status |
|---|---|---|
| 3.1 | Non-GET requests (`POST/PUT/DELETE/PATCH`) return immediately — `respondWith` is never called, so nothing user-specific can enter a cache. | *(tested)* |
| 3.2 | Cross-origin requests are ignored (`url.origin !== self.location.origin`). | *(tested)* |
| 3.3 | The **only** API path ever intercepted or cached is the exact pathname `/api/rates` (a public, static OEB rate snapshot). `/api/user`, `/api/backup`, `/api/session`, `/api/rates/extra` pass through untouched. | *(tested)* |
| 3.4 | No `importScripts`, no `eval`, no `new Function` — the worker cannot pull remote code. | *(tested)* |
| 3.5 | Cache names are version-prefixed (`oeo-v<N>-…`) so old caches are dropped on activate. | *(tested)* |
| 3.6 | `sw.js` is served `Cache-Control: no-cache, no-store, must-revalidate` (see `next.config.ts`), so a deploy is visible to installed clients. | *(HTTP smoke)* |

Residual note: `/api/rates` is deliberately cached. It contains only OEB
commodity rates — no user input goes to it, and its response is not rendered
as HTML.

## 4. What is out of scope (and why)

- **No accounts, no cookies, no server-side user rows** — there is nothing to
  enumerate or exfiltrate server-side. The threat is entirely client-side
  (malicious file, malicious/PWA-stale bundle).
- **Transport**: TLS via Let's Encrypt at the edge proxy.
- **CSV export**: every exported field is a number or a fixed enum label, so
  spreadsheet formula injection (`=cmd|…`) is not reachable from feed content.

## 5. When you change something here

1. Touched the XML parser, the backup import, or `sw.js`? → update the
   matching `*(tested)*` test in the same change.
2. Added a new way to render feed content? → prove it renders as text with a
   hostile payload (copy the `UsagePointPicker` case).
3. Added a new `caches.open` / `cache.put` in the worker? → add it to the
   allow-list assertion in `never caches any API endpoint other than
   /api/rates`.
4. Bumped the backup schema? → add the migration/refusal test next to
   `BACKUP_VERSION`.
