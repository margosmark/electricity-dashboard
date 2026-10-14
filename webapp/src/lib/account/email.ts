/**
 * Provider-agnostic boundary for verified registration and account recovery.
 * There is deliberately no concrete sender in this release: a future flow
 * must verify mailbox control before asking for/committing a passphrase.
 * Never persist clear tokens in an outbox or write token-bearing URLs to logs.
 */
import { accessSync, constants, statSync } from "node:fs";

export type VerificationPurpose = "registration" | "recovery";
export type VerificationMessage = {
  to: string;
  purpose: VerificationPurpose;
  /** Absolute HTTPS link; caller creates a purpose-bound, one-use token. */
  verificationUrl: string;
};

export interface VerificationEmailAdapter {
  send(message: VerificationMessage): Promise<void>;
}

export type EmailMode = "off" | "test" | "live";
export type EmailConfig = { mode: EmailMode; provider: "postmark" | "resend" | null; from: string | null; credentialFile: string | null };

/** Validate deployment intent without loading or logging secret contents. */
export function validateEmailConfig(env: Record<string, string | undefined>): EmailConfig {
  const mode = (env.ACCT_EMAIL_MODE ?? "off").trim().toLowerCase();
  if (mode !== "off" && mode !== "test" && mode !== "live") throw new Error("Invalid ACCT_EMAIL_MODE; use off, test, or live.");
  if (mode !== "live") return { mode, provider: null, from: null, credentialFile: null };

  const provider = (env.ACCT_EMAIL_PROVIDER ?? "").trim().toLowerCase();
  if (provider !== "postmark" && provider !== "resend") throw new Error("Live email requires ACCT_EMAIL_PROVIDER=postmark or resend.");
  const from = (env.ACCT_EMAIL_FROM ?? "").trim();
  if (!from || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) throw new Error("Live email requires a valid ACCT_EMAIL_FROM address.");
  const credentialFile = (env.ACCT_EMAIL_API_KEY_FILE ?? "").trim();
  if (!credentialFile) throw new Error("Live email requires ACCT_EMAIL_API_KEY_FILE pointing to a secret mount.");
  try {
    const stat = statSync(credentialFile);
    accessSync(credentialFile, constants.R_OK);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error();
  } catch {
    throw new Error("Live email credential mount must be a readable regular file with mode 0600 or stricter.");
  }
  return { mode, provider, from, credentialFile };
}
