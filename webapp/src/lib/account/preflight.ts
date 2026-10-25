/**
 * Account-activation preflight — a READ-ONLY read of this deployment's own
 * configuration, in the one process that is entitled to hold it.
 *
 * WHY IT LIVES HERE, AND WHY IT IS ONLY BOOLEANS.
 *
 * The account feature is deliberately invisible while it is off: every
 * `/account/*` route handler answers a bare `404 {"error":"not_found"}`
 * (http.ts#requireEnabled, pinned by route-matrix.test.ts for every method ×
 * every auth state), and the public app container holds no `ACCT_*` at all.
 * That is the correct security posture — and it is also why nobody could see
 * WHY activation was not happening: the state read as a broken feature
 * rather than a deliberate guard.
 *
 * So the explanation has to be rendered from inside the process that reads
 * the configuration (the account container, reached at `/account/preflight`
 * — a PAGE, not a route handler, so the API's indistinguishable-404 contract
 * is untouched), and it must be a page rather than an endpoint because the
 * route matrix admits no endpoint that answers while the feature is off.
 *
 * The snapshot deliberately carries ONLY `{ id, state }` per check:
 *
 *  - `state` is `"pass" | "pending"` — never a silent failure, never a
 *    detail string. A detail string is where a host name, a sender address
 *    or a credential-mount path would eventually sneak in, and the card for
 *    this work forbids reading SMTP details out. Booleans cannot leak.
 *  - Nothing here is written: no flag, no SMTP setting, no credential and no
 *    account is touched by building a snapshot. `getAccountConfig()` is the
 *    same memoised read every `/account/*` request already performs.
 *
 * The card's fence — presentation and reporting only — is therefore enforced
 * by the TYPE, not by a reviewer's reading of the diff.
 */

import { getAccountConfig, type AccountConfig } from "./config";

export type PreflightState = "pass" | "pending";

export type PreflightCheckId = "smtp" | "accountEnabled" | "emailVerification";

/** Exactly two fields, on purpose — see the module header. */
export type PreflightCheck = {
  id: PreflightCheckId;
  state: PreflightState;
};

export type PreflightSnapshot = {
  /** Ordered: the email half first, then the two flags, as the card lists them. */
  checks: PreflightCheck[];
  /** True only when every prerequisite this page can read is satisfied. */
  ready: boolean;
};

/** The three prerequisites the card names, in the card's order. */
const CHECK_IDS: readonly PreflightCheckId[] = [
  "smtp",
  "accountEnabled",
  "emailVerification",
];

/**
 * Build the snapshot.
 *
 * Defaults to the live configuration (what the page renders); tests pass an
 * explicit config so a state the deployment is not in can still be pinned.
 *
 * SMTP counts as satisfied only when the FULL sender contract is present —
 * `config.ts` builds `smtp` from every required field together, so a half
 * provisioned deployment (host set, no credential mount; port set, no TLS
 * mode; sender domain that does not match the public origin) reports
 * `pending` instead of a misleading pass.
 */
export function buildPreflightSnapshot(cfg: AccountConfig = getAccountConfig()): PreflightSnapshot {
  const satisfied: Record<PreflightCheckId, boolean> = {
    smtp: cfg.smtp !== null,
    accountEnabled: cfg.enabled,
    emailVerification: cfg.emailVerificationEnabled,
  };

  const checks: PreflightCheck[] = CHECK_IDS.map((id) => ({
    id,
    state: satisfied[id] ? "pass" : "pending",
  }));

  return { checks, ready: checks.every((check) => check.state === "pass") };
}
