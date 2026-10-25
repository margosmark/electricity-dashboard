/**
 * `GET /account/preflight` — the read-only activation preflight.
 *
 * A PAGE, not a route handler, and that distinction is the whole design:
 *
 *  - `route-matrix.test.ts` discovers every `src/app/account/**\/route.ts`
 *    and requires that, feature OFF, each answers a byte-identical 404 for
 *    every method × every auth state. An endpoint that reported the disabled
 *    state would break the security invariant that nothing behind this
 *    origin can be confirmed to exist — correctly.
 *  - `page.tsx` files are outside that sweep, and `/account/terms` already
 *    proves the shape: an HTML page under `/account/` is served by the
 *    account container whether the feature is on or off. This is the one
 *    place that can read `ACCT_ENABLED`, `ACCT_EMAIL_VERIFICATION_ENABLED`
 *    and the SMTP contract and show them to a human.
 *
 * `dynamic = "force-dynamic"` is load-bearing: without it Next may prerender
 * this page at BUILD time, when the build container has none of the `ACCT_*`
 * env at all — baking "pending" into the HTML forever, so the preflight
 * would keep reporting the build's ignorance after activation. Reading at
 * request time is what makes it a report on THIS deployment.
 *
 * Read-only: `buildPreflightSnapshot()` only reads (see lib/account/preflight).
 */

import AccountPreflight from "@/components/AccountPreflight";
import { buildPreflightSnapshot } from "@/lib/account/preflight";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Account Activation Preflight | Ontario Energy Optimizer",
  description: "Read-only prerequisite check for activating accounts.",
};

export default function AccountPreflightPage() {
  return <AccountPreflight snapshot={buildPreflightSnapshot()} />;
}
