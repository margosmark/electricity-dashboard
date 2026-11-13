"use client";

/**
 * Account activation preflight — the rendered half of
 * `lib/account/preflight.ts`.
 *
 * It is a leaf: every word comes from `t()`, every fact comes from the
 * snapshot it is handed (booleans only — this component could not print an
 * SMTP detail if it tried), and it renders nothing that could be mistaken
 * for a control. There is no form, no button that changes state and no
 * action to take on this page: it is a report.
 *
 * The three rows are `data-state="pass|pending"` and the fail-closed
 * statement is a `role="status"` banner, so a test can assert the preflight
 * says what it means in either language without reading pixels.
 */

import Link from "next/link";
import { ArrowLeft, Check, Clock3, ShieldCheck } from "lucide-react";
import { useTranslation } from "@/i18n";
import type { PreflightCheckId, PreflightSnapshot, PreflightState } from "@/lib/account/preflight";

const PANEL = "border-4 border-edge rounded-2xl bg-card p-5 md:p-7 shadow-hard-6";
const LINK =
  "inline-flex items-center gap-2 font-black underline decoration-2 underline-offset-4 " +
  "focus:outline-none focus:ring-4 focus:ring-ulo rounded";

/**
 * Key maps instead of template strings: the i18n coverage sweep can only
 * verify a literal `t("…")`, so `t(\`preflight.check.${id}\`)` would be a key
 * no gate ever checks. The maps are typed over the same union the snapshot
 * uses, and `AccountPreflight.test.tsx` walks every entry in both catalogs.
 */
const CHECK_LABEL: Record<PreflightCheckId, string> = {
  smtp: "preflight.check.smtp",
  accountEnabled: "preflight.check.accountEnabled",
  emailVerification: "preflight.check.emailVerification",
};

const CHECK_DETAIL: Record<PreflightCheckId, Record<PreflightState, string>> = {
  smtp: {
    pass: "preflight.detail.smtp.pass",
    pending: "preflight.detail.smtp.pending",
  },
  accountEnabled: {
    pass: "preflight.detail.accountEnabled.pass",
    pending: "preflight.detail.accountEnabled.pending",
  },
  emailVerification: {
    pass: "preflight.detail.emailVerification.pass",
    pending: "preflight.detail.emailVerification.pending",
  },
};

const STATE_LABEL: Record<PreflightState, string> = {
  pass: "preflight.state.pass",
  pending: "preflight.state.pending",
};

/**
 * The activation checklist. Static by design: it is what must be true
 * before activation is CONSIDERED, so it has to read the same on a
 * deployment where every box is already ticked.
 */
const CHECKLIST: readonly string[] = [
  "preflight.item.1",
  "preflight.item.2",
  "preflight.item.3",
  "preflight.item.4",
  "preflight.item.5",
  "preflight.item.6",
  "preflight.item.7",
];

type Props = {
  snapshot: PreflightSnapshot;
};

export default function AccountPreflight({ snapshot }: Props) {
  const { t } = useTranslation();

  return (
    <main className="min-h-screen bg-inset p-4 md:p-8 text-ink">
      <div className="mx-auto max-w-3xl space-y-5 md:space-y-7">
        <header className="space-y-3">
          <Link href="/" className={LINK} data-testid="preflight-back-link">
            <ArrowLeft size={14} strokeWidth={4} aria-hidden="true" />
            {t("preflight.backToApp")}
          </Link>
          <h1 className="text-3xl md:text-5xl font-black uppercase tracking-tighter">
            {t("preflight.title")}
          </h1>
          <p className="text-sm font-bold text-ink-2">{t("preflight.intro")}</p>
          <p
            className="border-4 border-edge rounded-xl bg-warn-strip p-4 text-sm font-black"
            role="status"
            data-testid="preflight-verdict"
            data-ready={String(snapshot.ready)}
          >
            {snapshot.ready ? t("preflight.readyNote") : t("preflight.failClosed")}
          </p>
        </header>

        <section aria-labelledby="preflight-checks-title" className={PANEL}>
          <h2
            id="preflight-checks-title"
            className="text-lg font-black uppercase tracking-tight mb-4"
            data-testid="preflight-checks-title"
          >
            {t("preflight.checksTitle")}
          </h2>
          <ul className="space-y-3" data-testid="preflight-checks">
            {snapshot.checks.map((check) => (
              <li
                key={check.id}
                data-testid={`preflight-check-${check.id}`}
                data-state={check.state}
                className="flex flex-wrap items-start gap-3 border-4 border-edge rounded-xl bg-card p-4"
              >
                <span className="shrink-0 mt-0.5" aria-hidden="true">
                  {check.state === "pass" ? (
                    <Check size={18} strokeWidth={4} />
                  ) : (
                    <Clock3 size={18} strokeWidth={4} />
                  )}
                </span>
                <span className="flex-1 min-w-[12rem] space-y-1">
                  <span className="block text-sm font-black">{t(CHECK_LABEL[check.id])}</span>
                  <span className="block text-xs font-bold text-ink-2">
                    {t(CHECK_DETAIL[check.id][check.state])}
                  </span>
                </span>
                <span
                  className="shrink-0 border-4 border-edge rounded-full bg-card px-3 py-1 text-[11px] font-black uppercase"
                  data-testid={`preflight-state-${check.id}`}
                >
                  {t(STATE_LABEL[check.state])}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section
          aria-labelledby="preflight-checklist-title"
          className={PANEL}
          data-testid="preflight-checklist"
        >
          <h2
            id="preflight-checklist-title"
            className="text-lg font-black uppercase tracking-tight mb-4"
          >
            {t("preflight.checklistTitle")}
          </h2>
          <ol className="list-decimal space-y-2 pl-5 text-sm font-bold">
            {CHECKLIST.map((key) => (
              <li key={key} data-testid={`preflight-item-${key.split(".").pop()}`}>
                {t(key)}
              </li>
            ))}
          </ol>
        </section>

        <p
          className="flex items-start gap-2 text-xs font-bold text-ink-2"
          role="note"
          data-testid="preflight-readonly"
        >
          <ShieldCheck size={16} strokeWidth={4} className="shrink-0 mt-px" aria-hidden="true" />
          <span>{t("preflight.readOnly")}</span>
        </p>
      </div>
    </main>
  );
}
