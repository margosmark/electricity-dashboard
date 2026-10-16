/**
 * POST /account/internal/smtp-events — signed relay bounce/complaint events.
 *
 * This is the generic SMTP equivalent of a provider webhook. The relay must
 * sign `${timestamp}.${rawBody}` with ACCT_SMTP_EVENTS_SECRET and retain the
 * configured suppression/bounce policy. Replayed or stale signatures are
 * rejected before parsing; token/message contents are never logged.
 */

import { createHmac } from "node:crypto";
import { getDb, isConfig, accountError, accountJson, readTextCapped, requireEnabled } from "@/lib/account/http";
import { normalizeEmail, secretEquals } from "@/lib/account/auth";
import { rememberSmtpEvent, suppressEmail } from "@/lib/account/db";
import { SMTP_EVENT_MAX_SKEW_MS } from "@/lib/account/config";

export async function POST(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  if (!cfg.emailVerificationEnabled || !cfg.smtp?.eventsSecret) return accountError(404, "not_found");
  const timestamp = request.headers.get("x-smtp-timestamp") ?? "";
  const signature = request.headers.get("x-smtp-signature") ?? "";
  const timestampMs = Number(timestamp) * 1000;
  if (!/^\d{10,13}$/.test(timestamp) || !Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > SMTP_EVENT_MAX_SKEW_MS) return accountError(401, "invalid_signature");
  const body = await readTextCapped(request);
  if (!body.ok) return accountError(body.status, "bad_request");
  const expected = createHmac("sha256", cfg.smtp.eventsSecret).update(`${timestamp}.${body.value}`).digest("hex");
  const provided = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  if (!/^[a-f0-9]{64}$/i.test(provided) || !secretEquals(provided.toLowerCase(), expected)) return accountError(401, "invalid_signature");
  const db = getDb(cfg);
  if (!rememberSmtpEvent(db, provided.toLowerCase())) return accountError(409, "replayed_event");
  let value: unknown;
  try {
    value = JSON.parse(body.value) as unknown;
  } catch {
    return accountError(400, "bad_request");
  }
  if (!value || typeof value !== "object") return accountError(400, "bad_request");
  const event = value as { event?: unknown; email?: unknown; reason?: unknown };
  if (event.event !== "bounce" && event.event !== "complaint") return accountError(400, "unsupported_event");
  const email = normalizeEmail(event.email);
  if (!email.ok) return accountError(400, "bad_request");
  suppressEmail(db, email.value, event.event, "smtp_event");
  return accountJson({ ok: true });
}

export { wrongMethod as GET, wrongMethod as PUT, wrongMethod as PATCH, wrongMethod as DELETE, wrongMethod as OPTIONS } from "@/lib/account/http";
