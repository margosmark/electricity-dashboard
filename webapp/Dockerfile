# Stage 1: Build the application
FROM node:26-alpine AS builder
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY . .

# The commit this image is built from. `GIT_SHA` arrives from
# docker-compose.yml, which reads `${GIT_SHA}` out of the environment of the
# shell running the deploy runbook (`~/bin/deploy-energy-dashboard.sh` exports
# `git rev-parse HEAD`). Empty when nothing supplies it: a local build reports
# 'unknown', never a stale or invented SHA.
#
# IN THE BUILDER this is what a `NEXT_PUBLIC_*` reference in CLIENT code is
# inlined from (Next substitutes it into the browser chunks at build time).
# It does NOT reach the route handler — see the note in stage 2.
ARG GIT_SHA=""
ENV NEXT_PUBLIC_BUILD_SHA=$GIT_SHA
RUN npm run build

# Stage 2: Run the application
FROM node:26-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Security: Run as non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# The SAME stamp, at runtime — and it is this one that `GET /api/version`
# answers.
#
# MEASURED, not assumed (Next 16.3.8 / Turbopack, 2026-10-12): the emitted
# route-handler chunk keeps `process.env.NEXT_PUBLIC_BUILD_SHA||"unknown"`
# verbatim, i.e. a NEXT_PUBLIC_* value is inlined into CLIENT bundles but read
# from the environment in SERVER code. A builder-stage ENV alone therefore
# leaves the container answering 'unknown'. This ENV is what makes the answer
# the build arg, and because it is part of the image config it moves only when
# the image is rebuilt — an unchanged container keeps naming its own commit.
ARG GIT_SHA=""
ENV NEXT_PUBLIC_BUILD_SHA=$GIT_SHA

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
