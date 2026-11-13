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
# it — the exact failure mode the Node pin exists for. Resolved at pin time,
# `1.29-alpine` and `1.29.8-alpine` are the SAME image — digest
# sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de
# (Docker Hub tag API + `docker buildx imagetools inspect`, both measured
# 2026-11-13; the tag was last pushed 2026-04-17) — so this pin is a no-op
# for the running container. Bump DELIBERATELY, in its own commit, with a
# comment naming the reason — never by loosening it back to a floating tag.
FROM nginx:1.29.8-alpine

COPY default.conf.template /etc/nginx/templates/default.conf.template
