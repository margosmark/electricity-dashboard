import type { AccountConfig } from "./config";
import { sendTransactionalEmail, type TransactionalMessage } from "./smtp";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function linkMessage(cfg: AccountConfig, to: string, subject: string, intro: string, link: string): TransactionalMessage {
  const safeLink = escapeHtml(link);
  const text = `${intro}\n\nOpen this link, then complete the action with the form shown:\n${link}\n\nThis link expires in 30 minutes and can be used once. If you did not request it, no account was changed.`;
  const html = `<p>${escapeHtml(intro)}</p><p><a href="${safeLink}">Continue</a></p><p>This link expires in 30 minutes and can be used once. If you did not request it, no account was changed.</p>`;
  return { to, subject, text, html };
}

export function registrationEmail(cfg: AccountConfig, email: string, token: string): TransactionalMessage {
  const link = `${cfg.publicOrigin}/account/verify?token=${encodeURIComponent(token)}`;
  return linkMessage(cfg, email, "Verify your electricity dashboard account", "Confirm your e-mail address to finish creating your electricity dashboard account.", link);
}

export function recoveryEmail(cfg: AccountConfig, email: string, token: string): TransactionalMessage {
  const link = `${cfg.publicOrigin}/account/recover/verify?token=${encodeURIComponent(token)}`;
  return linkMessage(cfg, email, "Recover your electricity dashboard account", "A password recovery was requested for this electricity dashboard account.", link);
}

export function sendAccountEmail(cfg: AccountConfig, message: TransactionalMessage): Promise<void> {
  return sendTransactionalEmail(cfg, message);
}

/* ---------------------------------------------------------------------------
 * Provider-level e-mail intent validation (inherited from main's account
 * hardening). Kept as a fail-fast check — `assertAccountDataDir` validates
 * `ACCT_EMAIL_*` intent independently of the SMTP sender contract above, so a
 * misconfigured live deployment refuses to start rather than half-send.
 * ------------------------------------------------------------------------- */

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
