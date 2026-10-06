/**
 * GET /greenbutton/start — kick off the authorization_code flow.
 *
 * Generates the CSRF state, parks it (in memory + an HttpOnly cookie), and
 * hands the browser to the custodian. Nothing about the user is known here;
 * the utility does the authenticating, exactly as Connect My Data intends.
 */

import { NextResponse } from "next/server";
import { buildAuthorizeUrl } from "@/lib/greenbutton/oauth";
import { newState } from "@/lib/greenbutton/session";
import {
  cookieSecure,
  getConfig,
  redirectToApp,
  STATE_COOKIE,
} from "@/lib/greenbutton/http";

export async function GET(): Promise<Response> {
  const cfg = getConfig();
  if (!cfg.configured) return redirectToApp("gb=error:not_configured");

  const state = newState();
  const url = buildAuthorizeUrl(cfg, state, cfg.redirectUri, cfg.scope);

  const res = NextResponse.redirect(url, 302);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
