/**
 * The page half of the preflight: what it is allowed to be.
 *
 * Two things are pinned, both of which would silently break the feature:
 *
 *  1. `dynamic === "force-dynamic"` — without it Next may prerender this
 *     page at build time, in a build container that has none of the `ACCT_*`
 *     env, and bake "everything pending" into the HTML forever. The
 *     preflight would then report the BUILD's ignorance on every deployment,
 *     including a fully activated one.
 *  2. the snapshot the page hands down tracks the runtime environment, so
 *     turning a flag on changes the report (a page that rendered a static
 *     snapshot would be exactly the "mysterious guard" this card exists to
 *     replace).
 *
 * Run: cd webapp && npx vitest run src/app/account/preflight/page.test.ts
 */

import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import AccountPreflightPage, { dynamic } from "./page";
import type AccountPreflight from "@/components/AccountPreflight";
import { resetAccountConfigCache } from "@/lib/account/config";
import type { PreflightSnapshot } from "@/lib/account/preflight";

type PageElement = ReactElement<React.ComponentProps<typeof AccountPreflight>>;

function renderPage(): PreflightSnapshot {
  return (AccountPreflightPage() as PageElement).props.snapshot;
}

function statesOf(snapshot: PreflightSnapshot): Record<string, string> {
  return Object.fromEntries(snapshot.checks.map((c) => [c.id, c.state]));
}

beforeEach(() => {
  delete process.env.ACCT_ENABLED;
  delete process.env.ACCT_EMAIL_VERIFICATION_ENABLED;
  resetAccountConfigCache();
});

afterEach(() => {
  delete process.env.ACCT_ENABLED;
  delete process.env.ACCT_EMAIL_VERIFICATION_ENABLED;
  resetAccountConfigCache();
});

describe("the preflight page", () => {
  it("is forced dynamic, so it reports this deployment and never the build's environment", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("reports three pendings on a deployment with both flags off", () => {
    const snapshot = renderPage();

    expect(statesOf(snapshot)).toEqual({
      smtp: "pending",
      accountEnabled: "pending",
      emailVerification: "pending",
    });
    expect(snapshot.ready).toBe(false);
  });

  it("changes its answer when the environment does — read-only, but not read-once", () => {
    process.env.ACCT_ENABLED = "true";
    process.env.ACCT_EMAIL_VERIFICATION_ENABLED = "true";
    resetAccountConfigCache();

    const snapshot = renderPage();
    expect(statesOf(snapshot).accountEnabled).toBe("pass");
    expect(statesOf(snapshot).emailVerification).toBe("pass");
    // No SMTP contract in this fixture, so the email half stays pending and
    // `ready` correctly refuses to claim the deployment is activation-ready.
    expect(statesOf(snapshot).smtp).toBe("pending");
    expect(snapshot.ready).toBe(false);
  });

  it("returns a serialisable snapshot only — a server page cannot hand a client a config object", () => {
    const snapshot = renderPage();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    for (const check of snapshot.checks) {
      expect(Object.keys(check).sort()).toEqual(["id", "state"]);
    }
  });
});
