/**
 * Public account-policy versions.
 *
 * These are application disclosure versions, not legal certification or a
 * promise that the current retention policy exists. Registration remains
 * disabled until the operator can enforce and publish a concrete retention
 * policy.
 */
export const PRIVACY_POLICY_VERSION = "2026-10-16";
export const ACCOUNT_TERMS_VERSION = "2026-10-16";

export type PolicyAcceptance = {
  privacyVersion: string | null;
  termsVersion: string | null;
  acceptedAt: number | null;
};

export function hasCurrentPolicyAcceptance(value: PolicyAcceptance): boolean {
  return (
    value.privacyVersion === PRIVACY_POLICY_VERSION &&
    value.termsVersion === ACCOUNT_TERMS_VERSION &&
    typeof value.acceptedAt === "number" &&
    Number.isFinite(value.acceptedAt) &&
    value.acceptedAt > 0
  );
}

export function acceptanceFromRequest(value: unknown): PolicyAcceptance | null {
  if (!value || typeof value !== "object") return null;
  const input = value as {
    policyAccepted?: unknown;
    privacyVersion?: unknown;
    termsVersion?: unknown;
  };
  if (
    input.policyAccepted !== true ||
    input.privacyVersion !== PRIVACY_POLICY_VERSION ||
    input.termsVersion !== ACCOUNT_TERMS_VERSION
  ) {
    return null;
  }
  return {
    privacyVersion: PRIVACY_POLICY_VERSION,
    termsVersion: ACCOUNT_TERMS_VERSION,
    acceptedAt: Date.now(),
  };
}
