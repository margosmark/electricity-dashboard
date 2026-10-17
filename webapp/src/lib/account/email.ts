import type { AccountConfig } from "./config";
import {
  claimEmailOutbox,
  deleteEmailToken,
  enqueueEmailOutbox,
  markEmailOutboxSent,
  retryEmailOutbox,
  suppressEmail,
} from "./db";
import { sendTransactionalEmail, SmtpDeliveryError, type TransactionalMessage } from "./smtp";

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
  // Fragments are not sent in HTTP requests, so nginx access/error logs and
  // Referer headers never receive the bearer token. The landing page copies
  // the fragment into the explicit POST body after the user opens the link.
  const link = `${cfg.publicOrigin}/account/verify#token=${encodeURIComponent(token)}`;
  return linkMessage(cfg, email, "Verify your electricity dashboard account", "Confirm your e-mail address to finish creating your electricity dashboard account.", link);
}

export function recoveryEmail(cfg: AccountConfig, email: string, token: string): TransactionalMessage {
  const link = `${cfg.publicOrigin}/account/recover/verify#token=${encodeURIComponent(token)}`;
  return linkMessage(cfg, email, "Recover your electricity dashboard account", "A password recovery was requested for this electricity dashboard account.", link);
}

export function sendAccountEmail(cfg: AccountConfig, message: TransactionalMessage): Promise<void> {
  return sendTransactionalEmail(cfg, message);
}

/** Persist before returning; delivery is retried independently of the request. */
export function enqueueAccountEmail(
  db: Parameters<typeof claimEmailOutbox>[0],
  tokenHash: string,
  message: TransactionalMessage,
): boolean {
  return enqueueEmailOutbox(db, { tokenHash, to: message.to, subject: message.subject, text: message.text, html: message.html });
}

/** Deliver one durable row. It intentionally does not log message data. */
export async function drainOutbox(cfg: AccountConfig, db: Parameters<typeof claimEmailOutbox>[0]): Promise<void> {
  const row = claimEmailOutbox(db);
  if (!row || !cfg.smtp) return;
  try {
    await sendAccountEmail(cfg, { to: row.to_address, subject: row.subject, text: row.text, html: row.html });
    markEmailOutboxSent(db, row.id);
  } catch (error) {
    const permanent = error instanceof SmtpDeliveryError && error.permanent;
    retryEmailOutbox(db, row.id, permanent);
    if (permanent) {
      deleteEmailToken(db, row.token_hash);
      suppressEmail(db, row.to_address, "permanent_delivery_failure", "smtp");
    }
  }
}
