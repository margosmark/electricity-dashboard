# The `/account/*` route contract matrix — measured, 2026-10-12

Card `t_b1408f61` (M178 candidate). Every number below was produced on this
LXC against a **real `next start`** of the production build, in **both** flag
states — not read off the code. The two earlier patches this card exists to
close the class of are `2c8ca8d` (a wrong-method probe answered `405`, and
auto-`OPTIONS` `204 + Allow`, on a deployment claiming to have no account API)
and `e147a85` (the ON gate was red as written: the container's `/data` was not
writable). Both were found by a probe aimed at one cell; this gate aims at the
whole surface at once.

## The surface

Read from disk by both gates — 10 route files, 9 of them app-owned and probed
over HTTP (`/account/internal/notify` is denied at the edge with `403`, so it
is the topology gate's leg, not this one's):

```
/account/login  /account/notify  /account/recover  /account/register
/account/session  /account/sync  /account/push/preferences
/account/push/subscribe  /account/logout          (+ /account/internal/notify)
```

Contract per route: real verbs (register/login/logout/notify/recover/internal =
`POST`; session = `GET`; sync and push/preferences = `GET, PUT`; push/subscribe
= `POST, DELETE`) answer their own gate chain; **every other verb** — including
`HEAD`, which Next serves from the route's `GET` — is the shared
`wrongMethod`: `404` while the feature is OFF, an honest `405` naming the
method while it is ON.

## Green — the state that ships

| Gate | Command | Result |
| --- | --- | --- |
| In-process matrix | `cd webapp && npx vitest run src/lib/account/route-matrix.test.ts` | **30 passed / 30** — 700 behavioural cells (10 routes × 7 methods × 5 auth states × 2 flag states) + 10 structural/rotation tests |
| HTTP gate, feature OFF | `bash tests/e2e/account_smoke.sh http://127.0.0.1:3197 --expect-disabled` | **88 passed, 0 failed** (was 68) |
| HTTP gate, feature ON | `bash tests/e2e/account_smoke.sh http://127.0.0.1:3198` | **270 passed, 0 failed** (was ~60) |

The auth states are `anonymous`, `valid` (a live session), `forged` (a cookie
that was never issued), `expired` (a real row past its `expires_at`) and
`stale` (a live row untouched for >24 h). A cookie that resolves to no live row
must answer **exactly** what no cookie answers — one `401 session_required`,
never a second code that would tell a prober whether a cookie was ever real.

### What the real router actually answered (ON, measured — not assumed)

```
GET      /account/login   405      HEAD     /account/session  200   (served from GET)
HEAD     /account/login   405      HEAD     /account/logout   405   (from the GET stub)
OPTIONS  /account/login   405      DELETE   /account/session  405
PUT      /account/login   405      OPTIONS  /account/session  405
```

No `Allow` header on any of them: the stubs are real handlers, so Next never
gets to emit its own auto-`OPTIONS` `204`/`Allow` pair.

## Red — the flip checks (each regression, then restored)

| Flip | Expected red | Measured |
| --- | --- | --- |
| Remove `wrongMethod` stubs from `/account/login` (the `2c8ca8d` defect) | OFF gate + matrix | OFF HTTP gate **7 failed** (6 wrong-method cells on `/account/login` + the forged-cookie sweep), all naming that route; vitest **12 failed / 18 passed**. Router measured directly: `GET/HEAD/PUT → 405`, `OPTIONS → 204` + `Allow: OPTIONS, POST` |
| `wrongMethod` blanket-`404` (drop the honest `405`) | ON gate + matrix | ON HTTP gate **144 failed / 270 passed** (every stub cell × 3 auth states); vitest **10 failed / 20 passed** |
| Add an 11th route file (`/account/device/route.ts`) | both surface guards | Shell guard: `FAIL: the route files and this gate's path list disagree` + `< /account/device`, exit 1; vitest **5 failed / 27 passed** (`/account/device has no module in this test's map`) |

Note on the first flip: `next build` **refuses** the reverted-stub tree at the
type-check step (`account.test.ts(174,24): Property 'GET' does not exist on
typeof import(.../login/route)`), because the pre-existing pin from `2c8ca8d`
imports that export. The HTTP red was therefore measured under `next dev`
(same App Router, same routing decision); the type-check failure is itself
evidence that the stub cannot be deleted silently.

## Reproducing the HTTP half locally (no docker)

```bash
cd webapp && npm ci && npm run build
npx next start -p 3197 &                                        # feature OFF
npx next start -p 3198 &                                        # feature ON
# …then the two commands from the table above, against those two ports.
# The ON server needs a writable database directory:
#   ACCT_ENABLED=true ACCT_DB_PATH=<tmp>/accounts.db
```

Each run needs a **fresh** database (the gate registers `smoke@example.com`
and asserts `201`), and each `npm run build` rewrites the tracked
`webapp/public/sw.js` service-worker version — restore it before committing.
