/**
 * The preflight's whole contract: three prerequisites in, three pass/pending
 * answers out, and nothing else on the way out.
 *
 * Run: cd webapp && npx vitest run src/lib/account/preflight.test.ts
 *
 * The states are driven through the REAL environment (the same
 * `ACCT_*` keys the deployment sets) rather than a hand-built config object,
 * so what is pinned here is what `config.ts` would actually conclude about a
 * deployment — including the half-provisioned SMTP case where a naive check
 * would report a reassuring pass.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPreflightSnapshot, type PreflightState } from "./preflight";
import { resetAccountConfigCache } from "./config";

const ORIGIN = "https://electricity.markarslan.ca";
const DOMAIN = "electricity.markarslan.ca";

const ENV_KEYS = [
  "ACCT_ENABLED",
  "ACCT_EMAIL_VERIFICATION_ENABLED",
  "ACCT_PUBLIC_ORIGIN",
  "ACCT_SMTP_HOST",
  "ACCT_SMTP_PORT",
  "ACCT_SMTP_TLS_MODE",
  "ACCT_SMTP_HELO",
  "ACCT_SMTP_FROM",
  "ACCT_SMTP_REPLY_TO",
  "ACCT_SMTP_TIMEOUT_MS",
  "ACCT_SMTP_USERNAME_FILE",
  "ACCT_SMTP_PASSWORD_FILE",
  "ACCT_SMTP_EVENTS_SECRET_FILE",
] as const;

let secretDir = "";

/** A 0400 file the config's `secretFile()` accepts — value never read out. */
function secretFile(name: string): string {
  const path = join(secretDir, name);
  writeFileSync(path, "fixture-only-placeholder", { mode: 0o400 });
  chmodSync(path, 0o400);
  return path;
}

function statesOf(snapshot: ReturnType<typeof buildPreflightSnapshot>): Record<string, PreflightState> {
  return Object.fromEntries(snapshot.checks.map((c) => [c.id, c.state]));
}

/** The deployment this card describes: every gate off, nothing provisioned. */
function clearDeployment(): void {
  for (const key of ENV_KEYS) delete process.env[key];
  resetAccountConfigCache();
}

function completeSmtpContract(): void {
  process.env.ACCT_PUBLIC_ORIGIN = ORIGIN;
  process.env.ACCT_SMTP_HOST = "smtp.example.test";
  process.env.ACCT_SMTP_PORT = "587";
  process.env.ACCT_SMTP_TLS_MODE = "starttls";
  process.env.ACCT_SMTP_HELO = DOMAIN;
  process.env.ACCT_SMTP_FROM = `accounts@${DOMAIN}`;
  process.env.ACCT_SMTP_REPLY_TO = `support@${DOMAIN}`;
  process.env.ACCT_SMTP_TIMEOUT_MS = "1000";
  process.env.ACCT_SMTP_USERNAME_FILE = secretFile("smtp-username");
  process.env.ACCT_SMTP_PASSWORD_FILE = secretFile("smtp-password");
  process.env.ACCT_SMTP_EVENTS_SECRET_FILE = secretFile("smtp-events");
}

beforeEach(() => {
  secretDir = mkdtempSync(join(tmpdir(), "preflight-"));
  clearDeployment();
});

afterEach(() => {
  clearDeployment();
  rmSync(secretDir, { recursive: true, force: true });
});

describe("buildPreflightSnapshot", () => {
  it("reports the deployed state — all three off — as three pendings, never a silent failure", () => {
    const snapshot = buildPreflightSnapshot();

    expect(snapshot.checks).toHaveLength(3);
    expect(statesOf(snapshot)).toEqual({
      smtp: "pending",
      accountEnabled: "pending",
      emailVerification: "pending",
    });
    expect(snapshot.ready).toBe(false);
  });

  it("flips exactly the row its own flag names, and no other", () => {
    process.env.ACCT_ENABLED = "true";
    resetAccountConfigCache();
    expect(statesOf(buildPreflightSnapshot())).toEqual({
      smtp: "pending",
      accountEnabled: "pass",
      emailVerification: "pending",
    });

    clearDeployment();
    process.env.ACCT_EMAIL_VERIFICATION_ENABLED = "true";
    resetAccountConfigCache();
    expect(statesOf(buildPreflightSnapshot())).toEqual({
      smtp: "pending",
      accountEnabled: "pending",
      emailVerification: "pass",
    });
  });

  it("reads 'true' case-insensitively, the way config.ts does, and anything else as off", () => {
    for (const value of ["TRUE", " true ", "1", "yes"]) {
      clearDeployment();
      process.env.ACCT_ENABLED = value;
      resetAccountConfigCache();
      expect(statesOf(buildPreflightSnapshot()).accountEnabled, `ACCT_ENABLED=${value}`).toBe(
        value.trim().toLowerCase() === "true" ? "pass" : "pending",
      );
    }
  });

  it("keeps SMTP pending while the contract is half provisioned — no reassuring partial pass", () => {
    process.env.ACCT_SMTP_HOST = "smtp.example.test";
    process.env.ACCT_SMTP_PORT = "587";
    resetAccountConfigCache();
    expect(statesOf(buildPreflightSnapshot()).smtp).toBe("pending");
  });

  it("passes SMTP only when the complete sender contract config.ts requires is present", () => {
    completeSmtpContract();
    resetAccountConfigCache();

    expect(statesOf(buildPreflightSnapshot()).smtp).toBe("pass");
  });

  it("reports ready only when every prerequisite is satisfied", () => {
    process.env.ACCT_ENABLED = "true";
    process.env.ACCT_EMAIL_VERIFICATION_ENABLED = "true";
    completeSmtpContract();
    resetAccountConfigCache();

    expect(statesOf(buildPreflightSnapshot())).toEqual({
      smtp: "pass",
      accountEnabled: "pass",
      emailVerification: "pass",
    });
    expect(buildPreflightSnapshot().ready).toBe(true);
  });

  /* ---------------------------------------------------------------------
   * The secrecy pin. The card forbids reading SMTP details out, and the
   * module's defence is that the snapshot is booleans-only — so assert the
   * shape itself, not a list of strings that happen to be missing today.
   * ------------------------------------------------------------------- */
  it("carries nothing but an id and a state per check", () => {
    completeSmtpContract();
    process.env.ACCT_ENABLED = "true";
    process.env.ACCT_EMAIL_VERIFICATION_ENABLED = "true";
    resetAccountConfigCache();

    const snapshot = buildPreflightSnapshot();
    for (const check of snapshot.checks) {
      expect(Object.keys(check).sort()).toEqual(["id", "state"]);
    }
    expect(Object.keys(snapshot).sort()).toEqual(["checks", "ready"]);
  });

  it("serialises to JSON that holds no address, host, path or secret name", () => {
    completeSmtpContract();
    resetAccountConfigCache();

    const json = JSON.stringify(buildPreflightSnapshot());
    expect(json).not.toMatch(/@/);
    expect(json).not.toMatch(/:\/\//);
    expect(json).not.toMatch(/smtp\.[a-z]/i); // a literal SMTP host
    expect(json).not.toMatch(/ACCT_SMTP_(HOST|PORT|FROM|REPLY_TO|HELO|USERNAME|PASSWORD)/);
    expect(json).not.toMatch(/fixture-only-placeholder/);
  });
});
