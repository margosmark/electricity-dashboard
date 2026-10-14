/**
 * Registration is closed pending a real, configured verification sender.
 * A future verification flow must prove mailbox control BEFORE it accepts a
 * password or creates an account; otherwise an attacker can pre-hijack it.
 * This endpoint never checks account existence, stores pending credentials,
 * issues tokens, or claims email was sent.
 */
import {
  accountError, accountJson, isConfig, rateLimitError, readJsonSmall,
  rejectCrossOrigin, requireEnabled,
} from "@/lib/account/http";
import { normalizeEmail } from "@/lib/account/auth";
import { checkAttempts, registerAttempts, spendAttempts } from "@/lib/account/ratelimit";

export async function POST(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  const csrf = rejectCrossOrigin(request);
  if (csrf) return csrf;
  const body = await readJsonSmall(request);
  if (!body.ok) return accountError(body.status, "bad_request", body.error);
  const email = normalizeEmail((body.value as { email?: unknown } | null)?.email);
  if (!email.ok) return accountError(400, "invalid_email", email.error);
  const attempts = registerAttempts(request);
  const verdict = checkAttempts(attempts);
  if (!verdict.allowed) return rateLimitError(verdict.retryAfterSeconds);
  spendAttempts(attempts);
  return accountJson({
    ok: true,
    status: "verification_pending",
    detail: "Registration is not available yet. If this address can be registered, next steps will be available when verification is implemented.",
  }, { status: 202 });
}

export { wrongMethod as GET, wrongMethod as PUT, wrongMethod as PATCH, wrongMethod as DELETE, wrongMethod as OPTIONS } from "@/lib/account/http";
