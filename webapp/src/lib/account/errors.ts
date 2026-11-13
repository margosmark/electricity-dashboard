/**
 * What the reader is told when an account call fails.
 *
 * The recovery contract (security gate t_b6260ed7, finding F3): the
 * exception's own message never reaches the reader. Everything a catch site
 * renders comes from one of two channels, and both are ours:
 *
 *  - `describeAuthError` — one sentence per server `error` code, or the
 *    hand-written `detail` the server sent. Since `lib/account/http.ts`
 *    stopped echoing JSON.parse's text, every string that can arrive here
 *    was written in this repo.
 *  - `describeAccountError` — the catch-all wrapper: a server failure
 *    through the same mapper, anything else a fixed sentence. The caught
 *    exception itself belongs on `console.warn`, where its audience is a
 *    developer — that is what the call sites below do.
 *
 * Moved verbatim out of `hooks/useAccount.ts` so the components' catch
 * sites (AccountControls, classic AccountControls) can render the same
 * copy sign-in/sign-up already do.
 */

import { AccountApiError } from "@/lib/account/client";

/** Human-readable auth failures, one per server code — no raw codes in UI. */
export function describeAuthError(code: string): string {
  switch (code) {
    case "invalid_credentials":
      return "That e-mail address and password do not match.";
    case "email_taken":
      return "An account already exists for that e-mail address.";
    case "invalid_email":
      return "That does not look like an e-mail address.";
    case "invalid_password":
      return "Use at least 8 characters for the password.";
    case "account_limit":
      return "This server is full — ask the operator to raise the account limit.";
    case "network":
      return "The account server is not reachable. Nothing was changed.";
    case "session_required":
      return "Your session expired — sign in again.";
    default:
      // Server `detail` is hand-written copy (413's "larger than the 10 MB
      // limit" rides here), so show it verbatim. A bare machine code —
      // `http_500`, `invalid_recovery` with no detail — is not a sentence,
      // and this function's whole job is "no raw codes in UI": say one
      // instead of echoing the code word (the same rule the Green Button
      // toolbar's describeGbError default was held to).
      return /\s/.test(code) ? code : "Something went wrong on the account server. Please try again.";
  }
}

/**
 * The catch-all every account surface renders through.
 *
 * Server failures keep their specific sentence (the mapped code, or the
 * server's own detail); everything else — a browser DOMException from
 * `pushManager.subscribe`, a response the client could not classify —
 * gets fixed copy. The raw exception never becomes text: callers
 * `console.warn` it alongside.
 */
export function describeAccountError(error: unknown): string {
  if (error instanceof AccountApiError) {
    return describeAuthError(error.detail ?? error.code);
  }
  return "Something went wrong. Please try again.";
}
