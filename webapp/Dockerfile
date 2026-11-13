# Stage 1: Build the application
#
# CVE-2026-111497 (Node2Shell) — pinned 2026-10-23; re-pinned 2026-11-13 to
# node:26.13.1-alpine. This base image carries the Brotli decoder OOB write
# fixed in Node 26.12.1, and 26.13.1 is a later release on that same line, so
# the fix is still carried.
#
# WHY 26.13.1 AND NOT 26.13.0 (the tag Dependabot proposed): Node's security
# release of 2026-11-11 patched 16 CVEs across the 26.x line — 7 high, 6
# medium, 3 low — including CVE-2026-123863 (HTTP/2 teardown assertion),
# CVE-2026-123864 (HTTPS llhttp re-entrancy heap read) and CVE-2026-123865
# (HTTP/2 shutdown leak), plus the llhttp 9.4.3 → 9.4.4 and undici updates;
# the fixed 26.x version is v26.13.1, published 2026-11-11. Source:
# https://nodejs.org/en/blog/vulnerability/november-2026-security-releases
# 26.13.0 (2026-10-28, 'Lithium' LTS transition, see
# https://nodejs.org/en/blog/release/v26.13.0) is metadata-only relative to
# 26.12.1, so pinning IT would have skipped that security release — a
# security-motivated pin must name the newest patched patch.
#
# The tag is PINNED to the exact patch release on purpose: the floating
# `node:26-alpine` tag resolved to the vulnerable 26.12.0 build between its
# bump and the 26.12.1 release, so a rebuild in that window shipped a
# remotely-exploitable runtime with nothing in the diff to show for it. Bump
# this version DELIBERATELY, in its own commit, with a comment naming the
# reason — never by loosening it back to a floating tag.
FROM node:26.13.1-alpine AS builder
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY . .

# The commit this image is built from. `GIT_SHA` arrives from
# docker-compose.yml, which reads `${GIT_SHA}` out of the environment of the
# shell running the deploy runbook (`~/bin/deploy-energy-dashboard.sh` exports
# `git rev-parse HEAD`). Empty/unset when nothing supplies it: `npm run build`
# then stamps 'unknown', never a stale or invented SHA.
#
# It must be in the ENVIRONMENT (not only as an ARG) because the stamp is
# COMPILED by `scripts/bump-build-info.mjs`, which `npm run build` runs from the
# `prebuild` lifecycle and which reads `process.env.GIT_SHA` — the same
# mechanism as the service-worker version in scripts/bump-sw-version.mjs.
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA
RUN npm run build

# Stage 2: Run the application
#
# CVE-2026-111497 (Node2Shell) — pinned 2026-10-23; re-pinned 2026-11-13 to
# node:26.13.1-alpine, for the same reason as the builder above: Node's
# security release of 2026-11-11 patched 16 CVEs on the 26.x line (7 high, 6
# medium, 3 low — incl. CVE-2026-123863/-123864/-123865) plus the llhttp
# 9.4.3 → 9.4.4 and undici updates, and the fixed 26.x version is v26.13.1;
# 26.13.0 is metadata-only versus 26.12.1, so pinning it would skip them.
# https://nodejs.org/en/blog/vulnerability/november-2026-security-releases
# The RUNNER stage executes the untrusted input path (HTTP request bodies), so it
# is the stage that carries the Brotli decoder OOB write fixed in Node 26.12.1
# and the HTTP parser that security release replaced. It is pinned to the same
# exact patch release as the builder above: the two stages must never drift
# apart, or a rebuild could ship a patched builder and a vulnerable runtime.
# Bump DELIBERATELY in its own commit, with a comment naming the reason.
FROM node:26.13.1-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Security: Run as non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# NOTHING IS DECLARED HERE FOR THE BUILD STAMP, on purpose.
#
# `GET /api/version` answers a constant COMPILED into the bundle by the builder
# above (src/lib/buildInfo.generated.ts, which buildInfo.ts re-exports), not a
# value read from this container's environment. That is the property being
# bought: `docker run -e NEXT_PUBLIC_BUILD_SHA=deadbeef… <image>` — or any other
# runtime environment — cannot rename the process, because the answer is a
# literal in the emitted chunk.
#
# The previous mechanism did need an ARG/ENV here: on Next 16.3.8/Turbopack a
# `NEXT_PUBLIC_*` value is inlined into CLIENT chunks but is read from the
# environment in SERVER code, so the route handler answered whatever the
# runtime environment said. Both stages' `ENV NEXT_PUBLIC_BUILD_SHA` are gone
# with it.

# Automatically leverage output: 'standalone' feature
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Permissions
RUN chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
