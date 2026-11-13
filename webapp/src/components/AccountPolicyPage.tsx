"use client";

import Link from "next/link";
import { useTranslation } from "@/i18n";

export type AccountPolicyKind = "privacy" | "terms";

const PANEL = "border-4 border-edge rounded-2xl bg-card p-5 md:p-8 shadow-hard-6";
const LINK = "font-black underline decoration-2 underline-offset-4 focus:outline-none focus:ring-4 focus:ring-purple-300 rounded";

export default function AccountPolicyPage({ kind }: { kind: AccountPolicyKind }) {
  const { t } = useTranslation();
  const privacy = kind === "privacy";
  const title = t(privacy ? "policy.privacy.title" : "policy.terms.title");

  return (
    <main className="min-h-screen bg-inset p-4 md:p-8 text-ink">
      <div className="mx-auto max-w-3xl space-y-5 md:space-y-7">
        <header className="space-y-3">
          <Link href="/" className={LINK} data-testid="policy-back-link">
            {t("policy.backToApp")}
          </Link>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h1 className="text-3xl md:text-5xl font-black uppercase tracking-tighter">{title}</h1>
            <span className="text-xs font-bold text-ink-2">{t("policy.lastUpdated")}</span>
          </div>
          <p className="text-sm font-bold text-ink-2">{t("policy.notLegal")}</p>
          <p className="border-4 border-edge rounded-xl bg-warn-strip p-4 text-sm font-black" role="status">
            {t("policy.registrationDisabled")}
          </p>
        </header>

        <nav aria-label={title} className={`${PANEL} flex flex-wrap gap-4 text-sm`}>
          <Link href="/privacy" className={privacy ? `${LINK} underline-offset-8` : LINK} aria-current={privacy ? "page" : undefined}>
            {t("policy.terms.privacyLink")}
          </Link>
          <Link href="/terms" className={!privacy ? `${LINK} underline-offset-8` : LINK} aria-current={!privacy ? "page" : undefined}>
            {t("policy.terms.termsLink")}
          </Link>
        </nav>

        {privacy ? <PrivacyContent /> : <TermsContent />}
      </div>
    </main>
  );
}

function PrivacyContent() {
  const { t } = useTranslation();
  return (
    <article className="space-y-5 md:space-y-7" data-testid="privacy-policy">
      <p className="text-base md:text-lg font-bold leading-relaxed">{t("policy.privacy.intro")}</p>
      <PolicySection title={t("policy.privacy.encryptionTitle")}>
        <p>{t("policy.privacy.encryptionBody")}</p>
      </PolicySection>
      <PolicySection title={t("policy.privacy.metadataTitle")}>
        <p>{t("policy.privacy.metadataBody")}</p>
      </PolicySection>
      <PolicySection title={t("policy.privacy.notificationTitle")}>
        <p>{t("policy.privacy.notificationBody")}</p>
      </PolicySection>
      <PolicySection title={t("policy.privacy.logsTitle")}>
        <p>{t("policy.privacy.logsBody")}</p>
      </PolicySection>
      <PolicySection title={t("policy.privacy.recoveryTitle")}>
        <p>{t("policy.privacy.recoveryBody")}</p>
      </PolicySection>
      <PolicySection title={t("policy.privacy.retentionTitle")}>
        <p>{t("policy.privacy.retentionBody")}</p>
      </PolicySection>
    </article>
  );
}

function TermsContent() {
  const { t } = useTranslation();
  return (
    <article className="space-y-5 md:space-y-7" data-testid="account-terms">
      <p className="text-base md:text-lg font-bold leading-relaxed">{t("policy.terms.intro")}</p>
      <PolicySection title={t("policy.terms.acceptanceTitle")}>
        <p>{t("policy.terms.acceptanceBody")}</p>
      </PolicySection>
      <PolicySection title={t("policy.terms.serviceTitle")}>
        <p>{t("policy.terms.serviceBody")}</p>
      </PolicySection>
      <PolicySection title={t("policy.terms.recoveryTitle")}>
        <p>{t("policy.terms.recoveryBody")}</p>
      </PolicySection>
      <PolicySection title={t("policy.terms.availabilityTitle")}>
        <p>{t("policy.terms.availabilityBody")}</p>
      </PolicySection>
    </article>
  );
}

function PolicySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={PANEL}>
      <h2 className="text-lg md:text-2xl font-black uppercase tracking-tight mb-3">{title}</h2>
      <div className="text-sm md:text-base font-bold leading-relaxed text-ink-2">{children}</div>
    </section>
  );
}
