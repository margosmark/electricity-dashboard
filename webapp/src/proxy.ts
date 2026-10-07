/**
 * `x-gb-process` on every response this app produces.
 *
 * The edge router can say which location matched (`X-Edge-Location`) but not
 * who answered: `greenbutton-shim` and `energy-dashboard` run the same image
 * behind the same nginx, so a location-derived header keeps claiming the split
 * is correct even while the wrong container serves the request — measured in
 * production on 2026-10-07 (security finding H1), where nginx's startup-time
 * upstream cache had inverted the split and `X-Edge-Upstream: shim` was
 * returned by the app container.
 *
 * This proxy runs inside the serving process and labels the response from that
 * process's own config, so the header changes when the container changes and
 * not when the path does. Both directions are then checkable from the public
 * URL with no shell:
 *
 *   curl -sSI .../greenbutton/status  →  x-gb-process: shim  (must pair with
 *                                        X-Edge-Location: greenbutton)
 *   curl -sSI .../                    →  x-gb-process: app   (must pair with
 *                                        X-Edge-Location: default)
 *
 * `greenbutton`+`app` or `default`+`shim` is the inversion, on a header the
 * router cannot forge. See src/lib/greenbutton/config.ts#getProcessIdentity.
 */

import { NextResponse } from "next/server";
import { getProcessIdentity } from "@/lib/greenbutton/config";

export default function proxy(): NextResponse {
  const response = NextResponse.next();
  response.headers.set("x-gb-process", getProcessIdentity());
  return response;
}

export const config = {
  // Everything that can carry a body someone might read, minus immutable
  // static assets — a cached sw.js/manifest has no container to identify and
  // must not vary by this header.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest).*)"],
};
