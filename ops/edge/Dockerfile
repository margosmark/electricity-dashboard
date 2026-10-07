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
FROM nginx:1.29-alpine

COPY default.conf.template /etc/nginx/templates/default.conf.template
