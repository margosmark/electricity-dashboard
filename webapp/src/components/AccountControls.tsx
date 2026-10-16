/**
 * Wave N — the Account control: sign in, sync, notification preferences.
 *
 * A twin of `BackupControls` in shape (one toolbar toggle, one drawer, Escape
 * and outside-tap to close, `data-testid` on every state a test needs) and
 * the deliberate opposite in message: the backup drawer says "everything
 * lives in this browser — no server copy", this one says what the server
 * copy actually is — encrypted, unreadable, and optional.
 *
 * Scope fence from the card: three modals and nothing else — sign in,
 * create account, settings. No marketing, no onboarding funnel, no upsell.
 * A power-user tool.
 *
 * The component owns no storage logic: `useAccount` does. It renders the
 * prompts that must be answered explicitly (first upload, device conflict)
 * and never lets either of them be answered by accident.
 */

"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Bell, BellOff, CloudUpload, KeyRound, LogOut, User, X } from "lucide-react";
import { useAccount, type AccountStatus } from "@/hooks/useAccount";
import { useTranslation } from "@/i18n";

const TOGGLE_CLASS =
  "min-h-11 min-w-11 inline-flex items-center justify-center " +
  "p-3 md:p-4 bg-card text-ink border-4 border-edge rounded-xl md:rounded-2xl " +
  "shadow-hard-violet-4 hover:translate-y-1 active:translate-y-0 active:shadow-hard-violet-2 transition-all";

const BUTTON_CLASS =
  "min-h-11 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-4 border-edge text-[11px] " +
  "shadow-hard-3 active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-40";

const INPUT_CLASS =
  "w-full min-h-11 px-3 py-2 rounded-lg border-4 border-edge bg-card text-ink text-[12px] font-bold normal-case " +
  "focus:outline-none focus:ring-4 focus:ring-ulo";

const FIELD_LABEL = "block text-[10px] font-black uppercase mb-1";

type Props = {
  /** Reload after the local dataset changed (import and sync share this). */
  onDataApplied?: () => void;
  /** Test/demo affordance: render the drawer open on first paint. */
  defaultOpen?: boolean;
};

export function AccountControls({ onDataApplied, defaultOpen = false }: Props) {
  const account = useAccount({ onDataApplied });
  const { t } = useTranslation();
  const { status, busy, message, prompt, recoveryCode } = account;

  const [open, setOpen] = useState(defaultOpen);
  const [tab, setTab] = useState<"signin" | "signup" | "recover">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoveryCodeInput, setRecoveryCodeInput] = useState("");
  const [newPassword, setNewPassword] = useState("");

  // Escape closes, exactly like every other overlay in this app. Registered
  // once (not gated on `open`) so there is never a frame where the drawer is
  // on screen but Escape is unhandled — see BackupControls for the history.
  const openRef = useRef(open);
  useLayoutEffect(() => {
    openRef.current = open;
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openRef.current && !e.defaultPrevented) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: Event) => {
      const target = e.target as Node | null;
      if (target && rootRef.current && !rootRef.current.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  // Nothing to show until the feature flag probe answers, and nothing at all
  // when the answer is "this deployment has no account server".
  if (!status.probed || !status.enabled) return null;

  const signedIn = status.authed && !status.locked;

  const submitAuth = async (e: FormEvent) => {
    e.preventDefault();
    const ok = tab === "signup" ? await account.signUp(email) : await account.signIn(email, password);
    if (ok) {
      setPassword("");
      // Sign-in can END with a question the user has to answer (the
      // first-upload prompt on a device that already has data). Closing the
      // drawer here would hide it, and a hidden prompt is a prompt that never
      // happened. Read from the ref, not from `prompt`: the render that carries
      // the new prompt has not happened yet when this resumes.
      if (tab !== "signup" && !account.promptRef.current) setOpen(false);
    }
  };

  const submitRecover = async (e: FormEvent) => {
    e.preventDefault();
    const { recover } = await import("@/lib/account/client");
    const entered = newPassword;
    try {
      const res = await recover({
        email: recoveryEmail,
        recoveryCode: recoveryCodeInput,
        newPassword: entered,
      });
      setRecoveryCodeInput("");
      setNewPassword("");
      setTab("signin");
      setEmail(recoveryEmail);
      if (res.blobDropped && res.blobDroppedReason) account.notify("error", res.blobDroppedReason);
      else account.notify("ok", "Password updated — sign in with it.");
      // Re-entering through the normal sign-in keeps ONE code path for
      // "derive the key and pull"; nothing about recovery is special there.
      await account.signIn(recoveryEmail, entered);
      setOpen(false);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      account.notify("error", `Could not recover: ${detail}`);
    }
  };

  return (
    <div ref={rootRef} className="md:relative">
      <button
        type="button"
        data-testid="account-toggle"
        title={t('account.toggleTitle')}
        aria-label={t('account.toggleAria')}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={busy}
        onClick={() => {
          setOpen((v) => !v);
          account.dismissMessage();
        }}
        className={TOGGLE_CLASS + " disabled:opacity-40 disabled:cursor-not-allowed"}
      >
        <User size={18} strokeWidth={4} />
      </button>

      {open && (
        <div
          data-testid="account-drawer"
          role="dialog"
          aria-label={t('account.toggleAria')}
          data-account-state={signedIn ? "signed_in" : status.authed ? "locked" : "signed_out"}
          className="absolute left-0 right-0 md:right-auto top-[calc(100%+8px)] z-[260] w-auto md:w-[360px] max-w-[calc(100vw-2rem)] bg-card border-4 border-edge rounded-xl md:rounded-2xl shadow-hard-6 p-4 md:p-5 text-ink font-black uppercase"
        >
          <div className="flex items-start justify-between gap-2 mb-3">
            <div className="text-xs md:text-sm">
              {signedIn ? t('account.headingSignedIn') : status.authed ? t('account.headingLocked') : t('account.headingSignedOut')}
            </div>
            <button
              type="button"
              aria-label={t('account.drawerCloseAria')}
              onClick={() => setOpen(false)}
              className="min-h-11 min-w-11 inline-flex items-center justify-center p-1 hover:bg-hover active:bg-track rounded"
            >
              <X size={16} strokeWidth={4} />
            </button>
          </div>

          <p className="text-[9px] md:text-[10px] leading-relaxed text-ink-2 font-black mb-4 normal-case">
            {t('account.privacyIntro')}{" "}
            <em>{t('account.privacyThat')}</em>{" "}
            {t('account.privacyYouHave')}{" "}
            <em>{t('account.privacyWhen')}</em>{" "}
            {t('account.privacyRest')}
          </p>

          {/* ---------------- explicit prompts (never auto-answered) --------- */}
          {prompt?.kind === "migrate" && (
            <div
              data-testid="account-migrate-prompt"
              className="mb-4 p-3 rounded-lg border-4 border-edge bg-accent-soft text-[10px] leading-relaxed normal-case"
            >
              <div className="uppercase font-black mb-2">{t('account.migrateTitle')}</div>
              {t('account.migrateBody')}
              <div className="flex gap-2 mt-3">
                <button
                  type="button"
                  data-testid="account-upload-accept"
                  disabled={busy}
                  onClick={() => void account.acceptUpload()}
                  className={BUTTON_CLASS + " bg-good-slab-soft flex-1"}
                >
                  <CloudUpload size={14} strokeWidth={4} /> {t('account.migrateAccept')}
                </button>
                <button
                  type="button"
                  data-testid="account-upload-decline"
                  onClick={account.declineUpload}
                  className={BUTTON_CLASS + " bg-card flex-1"}
                >
                  {t('account.migrateDecline')}
                </button>
              </div>
            </div>
          )}

          {prompt?.kind === "conflict" && (
            <div
              data-testid="account-conflict-prompt"
              className="mb-4 p-3 rounded-lg border-4 border-edge bg-warn-soft text-[10px] leading-relaxed normal-case"
            >
              <div className="uppercase font-black mb-2">{t('account.conflictTitle')}</div>
              {t('account.conflictBody', { rev: prompt.serverRev })}
              <div className="flex gap-2 mt-3">
                <button
                  type="button"
                  data-testid="account-conflict-keep-local"
                  disabled={busy}
                  onClick={() => void account.keepThisDevice()}
                  className={BUTTON_CLASS + " bg-good-slab-soft flex-1"}
                >
                  {t('account.conflictKeepLocal')}
                </button>
                <button
                  type="button"
                  data-testid="account-conflict-use-server"
                  disabled={busy}
                  onClick={() => void account.useServerCopy()}
                  className={BUTTON_CLASS + " bg-card flex-1"}
                >
                  {t('account.conflictUseServer')}
                </button>
              </div>
            </div>
          )}

          {recoveryCode && (
            <div
              data-testid="account-recovery-code"
              className="mb-4 p-3 rounded-lg border-4 border-edge bg-violet-slab-soft text-[10px] leading-relaxed normal-case"
            >
              <div className="uppercase font-black mb-2">{t('account.recoveryTitle')}</div>
              <div
                data-testid="account-recovery-code-value"
                className="font-mono text-[13px] tracking-widest my-2 select-all"
              >
                {recoveryCode}
              </div>
              {t('account.recoveryBody')}
              <button
                type="button"
                data-testid="account-recovery-dismiss"
                onClick={account.dismissRecoveryCode}
                className={BUTTON_CLASS + " bg-card w-full mt-2"}
              >
                {t('account.recoverySaved')}
              </button>
            </div>
          )}

          {/* ---------------- signed in ------------------------------------- */}
          {signedIn && (
            <div className="flex flex-col gap-3" data-testid="account-signed-in">
              <div className="text-[10px] break-all normal-case" data-testid="account-email">
                {status.email}
              </div>
              <div className="text-[9px] text-ink-3 normal-case" data-testid="account-sync-status">
                {t('account.syncStatusRevision')} {status.serverRev}
                {status.updatedAt
                  ? t('account.syncStatusLastChange', { when: new Date(status.updatedAt).toLocaleString() })
                  : ""}
                {status.hasBlob ? "" : t('account.syncStatusNoBlob')}
              </div>

              <button
                type="button"
                data-testid="account-sync-now"
                disabled={busy}
                onClick={() => void account.syncNow()}
                className={BUTTON_CLASS + " bg-accent"}
              >
                <CloudUpload size={14} strokeWidth={4} /> {t('account.syncNow')}
              </button>

              <NotificationSettings account={account} status={status} />

              <button
                type="button"
                data-testid="account-signout"
                disabled={busy}
                onClick={() => void account.signOut()}
                className={BUTTON_CLASS + " bg-card"}
              >
                <LogOut size={14} strokeWidth={4} /> {t('account.signOut')}
              </button>
            </div>
          )}

          {/* ---------------- signed out / locked ---------------------------- */}
          {!signedIn && tab !== "recover" && (
            <>
              {status.authed && (
                <div className="mb-3 p-2 border-4 border-edge bg-inset text-[10px] normal-case">
                  {t('account.lockedHelp')}
                </div>
              )}
              <form onSubmit={submitAuth} className="flex flex-col gap-3" data-testid="account-auth-form">
                <div>
                  <label className={FIELD_LABEL} htmlFor="acct-email">
                    {t('account.emailLabel')}
                  </label>
                  <input
                    id="acct-email"
                    data-testid="account-email-input"
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={INPUT_CLASS}
                  />
                </div>
                {tab === "signup" && (
                  <p role="status" className="border-4 border-edge bg-warn-soft p-3 text-[10px] normal-case">
                    {t('account.registrationClosed')}
                  </p>
                )}
                {tab !== "signup" && (
                  <div>
                    <label className={FIELD_LABEL} htmlFor="acct-password">{t('account.passwordLabel')}</label>
                    <input
                      id="acct-password"
                      data-testid="account-password-input"
                      type="password"
                      autoComplete="current-password"
                      required
                      minLength={1}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={INPUT_CLASS}
                    />
                  </div>
                )}
                <button
                  type="submit"
                  data-testid={tab === "signup" ? "account-register" : "account-login"}
                  disabled={busy}
                  className={BUTTON_CLASS + " bg-violet-slab"}
                >
                  {tab === "signup" ? t('account.createAccount') : status.authed ? t('account.unlock') : t('account.signIn')}
                </button>
                <div className="flex justify-between text-[9px] normal-case">
                  <button
                    type="button"
                    data-testid="account-switch-mode"
                    onClick={() => setTab(tab === "signup" ? "signin" : "signup")}
                    className="underline font-bold"
                  >
                    {tab === "signup" ? t('account.haveAccount') : t('account.noAccount')}
                  </button>
                  <button
                    type="button"
                    data-testid="account-switch-recover"
                    onClick={() => setTab("recover")}
                    className="underline font-bold"
                  >
                    {t('account.forgotPassword')}
                  </button>
                </div>
              </form>
            </>
          )}

          {/* ---------------- recovery -------------------------------------- */}
          {tab === "recover" && !signedIn && !status.authed && (
            <form onSubmit={submitRecover} className="flex flex-col gap-3 mt-3" data-testid="account-recover-form">
              <div>
                <label className={FIELD_LABEL} htmlFor="rec-email">
                  {t('account.emailLabel')}
                </label>
                <input
                  id="rec-email"
                  data-testid="account-recover-email"
                  type="email"
                  required
                  value={recoveryEmail}
                  onChange={(e) => setRecoveryEmail(e.target.value)}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className={FIELD_LABEL} htmlFor="rec-code">
                  {t('account.recoveryCodeLabel')}
                </label>
                <input
                  id="rec-code"
                  data-testid="account-recover-code"
                  type="text"
                  required
                  autoComplete="one-time-code"
                  value={recoveryCodeInput}
                  onChange={(e) => setRecoveryCodeInput(e.target.value)}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className={FIELD_LABEL} htmlFor="rec-password">
                  {t('account.newPasswordLabel')}
                </label>
                <input
                  id="rec-password"
                  data-testid="account-recover-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={15}
                  maxLength={200}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className={INPUT_CLASS}
                />
              </div>
              <p className="text-[9px] text-ink-2 normal-case">{t('account.passphraseHint')}</p>
              <p className="text-[9px] text-ink-2 normal-case">
                {t('account.recoverWarn')}
              </p>
              <button type="submit" disabled={busy} className={BUTTON_CLASS + " bg-violet-slab"}>
                <KeyRound size={14} strokeWidth={4} /> {t('account.setPassword')}
              </button>
            </form>
          )}

          {message && (
            <div
              data-testid="account-message"
              role={message.tone === "error" ? "alert" : "status"}
              className={
                "mt-3 text-[9px] md:text-[10px] break-words normal-case font-bold " +
                (message.tone === "error" ? "text-bad" : "text-good")
              }
            >
              {message.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Notification preferences — every control writes through `savePrefs`, so the
 * panel can only ever show values the server accepted.
 * -------------------------------------------------------------------------- */

/** The topics in the order the panel lists them. The words live in the i18n
 *  catalog (`account.topic.*` / `account.interval.*`), so they translate. */
const TOPIC_ORDER = ["plan_change", "oeb_rates", "data_available", "anomaly"] as const;

type AccountApi = ReturnType<typeof useAccount>;

function NotificationSettings({ account, status }: { account: AccountApi; status: AccountStatus }) {
  const { t } = useTranslation();
  const prefs = status.prefs;
  const [cap, setCap] = useState(prefs?.dailyCap ?? 3);
  const [quiet, setQuiet] = useState(
    prefs ? `${minutesToTime(prefs.quietStart)}-${minutesToTime(prefs.quietEnd)}` : "22:00-07:00",
  );
  const [expanded, setExpanded] = useState(false);

  // Re-seed the local form fields when the SERVER's copy of the preferences
  // changes (first load, or after a save round-trip). Done during render with
  // a previous-value guard rather than in an effect — the fields are a draft
  // of `prefs`, and a render-phase adjustment is how React says "the source
  // of truth moved" without an extra committed pass.
  const [seenPrefs, setSeenPrefs] = useState(prefs);
  if (prefs !== seenPrefs) {
    setSeenPrefs(prefs);
    if (prefs) {
      setCap(prefs.dailyCap);
      setQuiet(`${minutesToTime(prefs.quietStart)}-${minutesToTime(prefs.quietEnd)}`);
    }
  }

  const subscribed = status.subscriptionCount > 0;

  const toggleTopic = (topic: string) => {
    if (!prefs) return;
    const topics = prefs.topics.includes(topic)
      ? prefs.topics.filter((t) => t !== topic)
      : [...prefs.topics, topic];
    void account.savePrefs({ ...prefs, topics });
  };

  const commitLimits = () => {
    if (!prefs) return;
    const [start, end] = quiet.split("-");
    void account.savePrefs({
      ...prefs,
      dailyCap: Math.max(0, Math.min(20, Math.round(cap))),
      quietStart: timeToMinutes(start),
      quietEnd: timeToMinutes(end),
    });
  };

  return (
    <div className="border-4 border-edge rounded-lg p-3" data-testid="account-notifications">
      <button
        type="button"
        data-testid="account-notifications-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between text-[10px]"
      >
        <span className="flex items-center gap-2">
          {subscribed ? <Bell size={14} strokeWidth={4} /> : <BellOff size={14} strokeWidth={4} />}
          {subscribed ? t('account.notificationsOn') : t('account.notificationsOff')}
        </span>
        <span aria-hidden>{expanded ? "−" : "+"}</span>
      </button>

      {expanded && (
        <div className="mt-3 flex flex-col gap-3">
          {!status.pushConfigured && (
            <div className="text-[9px] text-ink-2 normal-case">
              {t('account.pushUnconfigured')}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              data-testid={subscribed ? "account-notify-disable" : "account-notify-enable"}
              disabled={!status.pushConfigured}
              onClick={() =>
                void (subscribed ? account.disableNotifications() : account.enableNotifications())
              }
              className={BUTTON_CLASS + (subscribed ? " bg-card" : " bg-good-slab-soft") + " flex-1"}
            >
              {subscribed ? t('account.notifyTurnOff') : t('account.notifyTurnOn')}
            </button>
          </div>

          {prefs && (
            <>
              <fieldset>
                <legend className="text-[9px] font-black uppercase mb-1">{t('account.tellMeAbout')}</legend>
                {TOPIC_ORDER.map((topic) => (
                  <label key={topic} className="flex items-start gap-2 text-[9px] normal-case py-1 cursor-pointer">
                    <input
                      type="checkbox"
                      data-testid={`account-topic-${topic}`}
                      checked={prefs.topics.includes(topic)}
                      onChange={() => toggleTopic(topic)}
                      className="mt-0.5 h-4 w-4 accent-purple-600"
                    />
                    <span>
                      {t(`account.topic.${topic}`)}
                      <span className="block text-ink-3">{t(`account.interval.${topic}`)}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              <div className="grid grid-cols-2 gap-2">
                <label className="text-[9px]">
                  <span className="block font-black uppercase mb-1">{t('account.perDayMax')}</span>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    data-testid="account-daily-cap"
                    value={cap}
                    onChange={(e) => setCap(Number(e.target.value))}
                    onBlur={commitLimits}
                    className={INPUT_CLASS}
                  />
                </label>
                <label className="text-[9px]">
                  <span className="block font-black uppercase mb-1">{t('account.quiet')}</span>
                  <input
                    type="text"
                    data-testid="account-quiet-hours"
                    value={quiet}
                    onChange={(e) => setQuiet(e.target.value)}
                    onBlur={commitLimits}
                    className={INPUT_CLASS}
                    pattern="\d{1,2}:\d{2}-\d{1,2}:\d{2}"
                    title={t('account.quietFormat')}
                  />
                </label>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function minutesToTime(minutes: number): string {
  const m = Math.max(0, Math.min(1439, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function timeToMinutes(value: string | undefined): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? "");
  if (!match) return 0;
  const hours = Math.min(23, Number(match[1]));
  const mins = Math.min(59, Number(match[2]));
  return hours * 60 + mins;
}

export default AccountControls;
