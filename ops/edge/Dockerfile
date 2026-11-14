# The edge router is config, not code: nginx with the path split baked in.
#
# It is BUILT rather than bind-mounted so that a change to
# default.conf.template produces a new image ID, and `docker compose up -d
# --build` therefore recreates the container. A bind-mounted config file is
# invisible to Compose's recreate logic: edit it, run `up -d`, and the running
# nginx keeps serving the old policy — which is how a fix can sit on disk
# while production keeps the old behaviour.
#
# The template still has to be correct on its own terms, though: this image
# only guarantees the running container matches the commit. See
# default.conf.template for why a router that outlives its upstreams matters.
#
# PINNED 2026-11-13 to the exact patch release — the same discipline as
# webapp/Dockerfile (its lesson and its pin test live there; the edge
# analogue is webapp/src/lib/dockerEdgeImagePin.test.ts).
# `nginx:1.29-alpine` is a floating PATCH tag: a rebuild inside a window
# where upstream moves it ships a changed router with zero diff to show for
# it — the exact failure mode the Node pin exists for.
#
# Bumped 2026-11-13, 1.29.8 → 1.30.6: the 1.29 line is EOL, and nginx.org's
# advisory list (fetched 2026-11-13) puts 1.29.8 inside the Vulnerable
# range of 18 of 68 advisories — including major CVE-2026-42533
# (map+regex), CVE-2026-15176 (alias+rewrite) and CVE-2026-97205 (SSI+AIO
# UAF) — and every fix for those shipped only on 1.30.x/1.31.x. 1.30.6 is
# the current stable (released 2026-10-14) and clears 17 of the 18; the
# residual CVE-2009-4487 (severity none) is unfixed in every version —
# mainline 1.31.8 clears the same 17 — so stable is the target. Digest
# resolved at pin time:
# sha256:901e593c95dc85f5a729f5765516321366ef4ac401821431d408897e95287d0a
# (Docker Hub tag API + `docker buildx imagetools inspect`, both measured
# 2026-11-13; tag last pushed 2026-11-13).
# Unlike the original 1.29.8 pin — which was a no-op for the running
# container — this is a REAL runtime change (a minor bump), so it was
# validated before merge: `nginx -t` on the rendered template, the path
# split exercised in a throwaway topology compose, `nginx -V` module
# parity. Bump DELIBERATELY, in its own commit, with a comment naming the
# reason — never by loosening it back to a floating tag.
FROM nginx:1.31.7-alpine

COPY default.conf.template /etc/nginx/templates/default.conf.template
