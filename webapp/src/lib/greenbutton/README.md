# Green Button Connect My Data shim

A single-purpose OAuth2 + ESPI pipe-through that lives behind
`/greenbutton/*`. Its whole job is to hold the OAuth client credentials and
the caller's token set, fetch the custodian's feed, and stream it to the
browser — which does the parsing and keeps the readings in `localStorage`,
exactly as if the file had been uploaded by hand.

Nothing else is stored. Ever.

## Where the refresh token lives

**Exactly one place: a JSON file on the host, outside every container, mode
`0600`, owned by uid 1001.**

| | |
| --- | --- |
| host path | `/home/hermes/.greenbutton-shim/tokens.json` (on `.110`, outside the git worktree) |
| container path | `/var/lib/greenbutton/tokens.json` — bind mount of the above |
| env override | `GB_TOKEN_DIR` (host side) / `GB_TOKEN_FILE` (container side) — `GB_TOKEN_DIR` is pinned in the **untracked `.env`**, never in `docker-compose.yml` |
| permissions | `0600`, owner uid 1001 (`nextjs` in the image); directory `0700` |
| inspect | `sudo ls -l /home/hermes/.greenbutton-shim` |

That file is the *only* thing the shim writes. Its key set is pinned by a
test (`PERSISTED_KEYS` in `tokens.ts`): `accessToken`, `refreshToken`,
`expiresAt`, `scope`, `subscriptionUri`, `authorizationUri`, `sessionToken`,
`obtainedAt`. If a reading, an interval or an XML fragment ever appears there,
the suite fails.

It is never:

- **in the browser** — the browser holds an HttpOnly `gb_session` cookie,
  which unlocks this service and nothing else. It is not an OAuth credential,
  and no refresh token is ever handed to JavaScript;
- **in a commit** — `.greenbutton/` is gitignored;
- **in a log** — logs carry status codes, error codes, byte counts and URLs,
  never token values.

If the mount is unwritable the store degrades to memory-only, keeps working
for the life of the process, and `/greenbutton/status` reports
`tokenPersistence: "memory"` so the degradation is visible rather than
silent.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /greenbutton/status` | configured / connected / last-sync metadata (scalars only) |
| `GET /greenbutton/start` | CSRF state → 302 to the custodian's authorize URL |
| `GET /greenbutton/callback` | code exchange → token file → session cookie → app |
| `GET /greenbutton/usage` | **the pipe-through**: ESPI streamed byte for byte |
| `POST /greenbutton/notify/[token]` | the utility's "data changed" webhook (timestamp only) |
| `POST /greenbutton/disconnect` | wipe the token file + expire the cookie |

## Where it runs

Three containers behind one host port (`docker-compose.yml`):

```
edge-router :3939 ─┬─ /greenbutton* → greenbutton-shim   (creds + token mount)
                   └─ everything    → energy-dashboard   (no Green Button env at all)
```

The router is there because the upstream edge forwards *every* path of the
domain to this host — the `/greenbutton/*` split has to happen on-box. Each
response carries `x-gb-process: app|shim` — set by the serving process from
its own config — alongside the router's `X-Edge-Location`, so you can see
which container answered from the public URL *and* catch it when the two
disagree.

Gates:

```bash
webapp/scripts/e2e-greenbutton-loop.sh          # 29 checks, real `next start`
webapp/scripts/e2e-greenbutton-topology.sh      # 46 checks, through the router
```

Full design notes, the registration payload and the security model live in
[`GREENBUTTON-CMD.md`](../../GREENBUTTON-CMD.md).
