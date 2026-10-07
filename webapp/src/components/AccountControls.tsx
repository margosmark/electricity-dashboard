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

const TOGGLE_CLASS =
  "min-h-11 min-w-11 inline-flex items-center justify-center " +
  "p-3 md:p-4 bg-white text-black border-4 border-black rounded-xl md:rounded-2xl " +
  "shadow-[4px_4px_0px_0px_rgba(124,58,237,1)] hover:translate-y-1 active:translate-y-0 active:shadow-[2px_2px_0px_0px_rgba(124,58,237,1)] transition-all";

const BUTTON_CLASS =
  "min-h-11 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-4 border-black text-[11px] " +
  "shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-40";

const INPUT_CLASS =
  "w-full min-h-11 px-3 py-2 rounded-lg border-4 border-black bg-white text-black text-[12px] font-bold normal-case " +
  "focus:outline-none focus:ring-4 focus:ring-purple-300";

const FIELD_LABEL = "block text-[10px] font-black uppercase mb-1";

type Props = {
  /** Reload after the local dataset changed (import and sync share this). */
  onDataApplied?: () => void;
  /** Test/demo affordance: render the drawer open on first paint. */
  defaultOpen?: boolean;
};

export function AccountControls({ onDataApplied, defaultOpen = false }: Props) {
  const account = useAccount({ onDataApplied });
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
    const ok = tab === "signup" ? await account.signUp(email, password) : await account.signIn(email, password);
    if (ok) {
      setPassword("");
      // Sign-in can END with a question the user has to answer (the
      // first-upload prompt on a device that already has data). Closing the
      // drawer here would hide it, and a hidden prompt is a prompt that never
      // happened. Read from the ref, not from `prompt`: the render that carries
      // the new prompt has not happened yet when this resumes.
      if (!account.promptRef.current) setOpen(false);
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
        title="Account & sync"
        aria-label="Account and sync"
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
          aria-label="Account and sync"
          data-account-state={signedIn ? "signed_in" : status.authed ? "locked" : "signed_out"}
          className="absolute left-0 right-0 md:right-auto top-[calc(100%+8px)] z-[260] w-auto md:w-[360px] max-w-[calc(100vw-2rem)] bg-white border-4 border-black rounded-xl md:rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] p-4 md:p-5 text-black font-black uppercase"
        >
          <div className="flex items-start justify-between gap-2 mb-3">
            <div className="text-xs md:text-sm">
              {signedIn ? "Your account" : status.authed ? "Sync locked" : "Sign in"}
            </div>
            <button
              type="button"
              aria-label="Close account drawer"
              onClick={() => setOpen(false)}
              className="min-h-11 min-w-11 inline-flex items-center justify-center p-1 hover:bg-slate-100 active:bg-slate-200 rounded"
            >
              <X size={16} strokeWidth={4} />
            </button>
          </div>

          <p className="text-[9px] md:text-[10px] leading-relaxed text-slate-600 font-black mb-4 normal-case">
            Your readings are encrypted in this browser before they are uploaded. The server stores a blob it
            cannot open — it knows <em>that</em> you have data and <em>when</em> it changed, not what is in it,
            and not your password.
          </p>

          {/* ---------------- explicit prompts (never auto-answered) --------- */}
          {prompt?.kind === "migrate" && (
            <div
              data-testid="account-migrate-prompt"
              className="mb-4 p-3 rounded-lg border-4 border-black bg-yellow-100 text-[10px] leading-relaxed normal-case"
            >
              <div className="uppercase font-black mb-2">Back up this device?</div>
              This browser has data and your new account has none. Upload it so your phone and desktop see the
              same dashboard?
              <div className="flex gap-2 mt-3">
                <button
                  type="button"
                  data-testid="account-upload-accept"
                  disabled={busy}
                  onClick={() => void account.acceptUpload()}
                  className={BUTTON_CLASS + " bg-emerald-300 flex-1"}
                >
                  <CloudUpload size={14} strokeWidth={4} /> Back it up
                </button>
                <button
                  type="button"
                  data-testid="account-upload-decline"
                  onClick={account.declineUpload}
                  className={BUTTON_CLASS + " bg-white flex-1"}
                >
                  Not now
                </button>
              </div>
            </div>
          )}

          {prompt?.kind === "conflict" && (
            <div
              data-testid="account-conflict-prompt"
              className="mb-4 p-3 rounded-lg border-4 border-black bg-orange-100 text-[10px] leading-relaxed normal-case"
            >
              <div className="uppercase font-black mb-2">Two devices changed this data</div>
              The account is at revision {prompt.serverRev} and this browser has changes too. Pick which copy
              wins — nothing is overwritten until you do.
              <div className="flex gap-2 mt-3">
                <button
                  type="button"
                  data-testid="account-conflict-keep-local"
                  disabled={busy}
                  onClick={() => void account.keepThisDevice()}
                  className={BUTTON_CLASS + " bg-emerald-300 flex-1"}
                >
                  This device
                </button>
                <button
                  type="button"
                  data-testid="account-conflict-use-server"
                  disabled={busy}
                  onClick={() => void account.useServerCopy()}
                  className={BUTTON_CLASS + " bg-white flex-1"}
                >
                  Account copy
                </button>
              </div>
            </div>
          )}

          {recoveryCode && (
            <div
              data-testid="account-recovery-code"
              className="mb-4 p-3 rounded-lg border-4 border-black bg-purple-100 text-[10px] leading-relaxed normal-case"
            >
              <div className="uppercase font-black mb-2">Save this recovery code</div>
              <div
                data-testid="account-recovery-code-value"
                className="font-mono text-[13px] tracking-widest my-2 select-all"
              >
                {recoveryCode}
              </div>
              There is no e-mail reset on this server. If you forget your password this code lets you set a new
              one — but the copy stored on the server was encrypted with the old password and cannot be read
              afterwards, so keep this browser&apos;s data until you have re-synced.
              <button
                type="button"
                data-testid="account-recovery-dismiss"
                onClick={account.dismissRecoveryCode}
                className={BUTTON_CLASS + " bg-white w-full mt-2"}
              >
                I have saved it
              </button>
            </div>
          )}

          {/* ---------------- signed in ------------------------------------- */}
          {signedIn && (
            <div className="flex flex-col gap-3" data-testid="account-signed-in">
              <div className="text-[10px] break-all normal-case" data-testid="account-email">
                {status.email}
              </div>
              <div className="text-[9px] text-slate-500 normal-case" data-testid="account-sync-status">
                Account revision {status.serverRev}
                {status.updatedAt ? ` · last change ${new Date(status.updatedAt).toLocaleString()}` : ""}
                {status.hasBlob ? "" : " · nothing backed up yet"}
              </div>

              <button
                type="button"
                data-testid="account-sync-now"
                disabled={busy}
                onClick={() => void account.syncNow()}
                className={BUTTON_CLASS + " bg-yellow-400"}
              >
                <CloudUpload size={14} strokeWidth={4} /> Back up now
              </button>

              <NotificationSettings account={account} status={status} />

              <button
                type="button"
                data-testid="account-signout"
                disabled={busy}
                onClick={() => void account.signOut()}
                className={BUTTON_CLASS + " bg-white"}
              >
                <LogOut size={14} strokeWidth={4} /> Sign out
              </button>
            </div>
          )}

          {/* ---------------- signed out / locked ---------------------------- */}
          {!signedIn && tab !== "recover" && (
            <>
              {status.authed && (
                <div className="mb-3 p-2 border-4 border-black bg-slate-100 text-[10px] normal-case">
                  This device is signed in but has no encryption key — enter your password to unlock it.
                </div>
              )}
              <form onSubmit={submitAuth} className="flex flex-col gap-3" data-testid="account-auth-form">
                <div>
                  <label className={FIELD_LABEL} htmlFor="acct-email">
                    E-mail
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
                <div>
                  <label className={FIELD_LABEL} htmlFor="acct-password">
                    Password
                  </label>
                  <input
                    id="acct-password"
                    data-testid="account-password-input"
                    type="password"
                    autoComplete={tab === "signup" ? "new-password" : "current-password"}
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={INPUT_CLASS}
                  />
                </div>
                <button
                  type="submit"
                  data-testid={tab === "signup" ? "account-register" : "account-login"}
                  disabled={busy}
                  className={BUTTON_CLASS + " bg-purple-300"}
                >
                  {tab === "signup" ? "Create account" : status.authed ? "Unlock" : "Sign in"}
                </button>
                <div className="flex justify-between text-[9px] normal-case">
                  <button
                    type="button"
                    data-testid="account-switch-mode"
                    onClick={() => setTab(tab === "signup" ? "signin" : "signup")}
                    className="underline font-bold"
                  >
                    {tab === "signup" ? "Have an account? Sign in" : "No account? Create one"}
                  </button>
                  <button
                    type="button"
                    data-testid="account-switch-recover"
                    onClick={() => setTab("recover")}
                    className="underline font-bold"
                  >
                    Forgot password?
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
                  E-mail
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
                  Recovery code
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
                  New password
                </label>
                <input
                  id="rec-password"
                  data-testid="account-recover-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className={INPUT_CLASS}
                />
              </div>
              <p className="text-[9px] text-slate-600 normal-case">
                The stored copy was encrypted with the old password and will be removed — this recovers your
                account, not your data. Re-sync from a device that still has it.
              </p>
              <button type="submit" disabled={busy} className={BUTTON_CLASS + " bg-purple-300"}>
                <KeyRound size={14} strokeWidth={4} /> Set new password
              </button>
            </form>
          )}

          {message && (
            <div
              data-testid="account-message"
              role={message.tone === "error" ? "alert" : "status"}
              className={
                "mt-3 text-[9px] md:text-[10px] break-words normal-case font-bold " +
                (message.tone === "error" ? "text-red-600" : "text-emerald-700")
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

const TOPIC_LABELS: Record<string, string> = {
  plan_change: "A cheaper plan appears for your usage",
  oeb_rates: "New Ontario rates are published",
  data_available: "Your utility posted new data",
  anomaly: "An unusually expensive day is detected",
};

const MIN_INTERVAL_TEXT: Record<string, string> = {
  plan_change: "at most once a day",
  oeb_rates: "at most once a week",
  data_available: "at most once a day",
  anomaly: "at most once a day",
};

type AccountApi = ReturnType<typeof useAccount>;

function NotificationSettings({ account, status }: { account: AccountApi; status: AccountStatus }) {
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
    <div className="border-4 border-black rounded-lg p-3" data-testid="account-notifications">
      <button
        type="button"
        data-testid="account-notifications-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between text-[10px]"
      >
        <span className="flex items-center gap-2">
          {subscribed ? <Bell size={14} strokeWidth={4} /> : <BellOff size={14} strokeWidth={4} />}
          Notifications {subscribed ? "on" : "off"}
        </span>
        <span aria-hidden>{expanded ? "−" : "+"}</span>
      </button>

      {expanded && (
        <div className="mt-3 flex flex-col gap-3">
          {!status.pushConfigured && (
            <div className="text-[9px] text-slate-600 normal-case">
              This server has no VAPID keys yet, so notifications cannot be delivered.
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
              className={BUTTON_CLASS + (subscribed ? " bg-white" : " bg-emerald-300") + " flex-1"}
            >
              {subscribed ? "Turn off" : "Turn on"}
            </button>
          </div>

          {prefs && (
            <>
              <fieldset>
                <legend className="text-[9px] font-black uppercase mb-1">Tell me about</legend>
                {Object.keys(TOPIC_LABELS).map((topic) => (
                  <label key={topic} className="flex items-start gap-2 text-[9px] normal-case py-1 cursor-pointer">
                    <input
                      type="checkbox"
                      data-testid={`account-topic-${topic}`}
                      checked={prefs.topics.includes(topic)}
                      onChange={() => toggleTopic(topic)}
                      className="mt-0.5 h-4 w-4 accent-purple-600"
                    />
                    <span>
                      {TOPIC_LABELS[topic]}
                      <span className="block text-slate-500">{MIN_INTERVAL_TEXT[topic]}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              <div className="grid grid-cols-2 gap-2">
                <label className="text-[9px]">
                  <span className="block font-black uppercase mb-1">Per day (max)</span>
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
                  <span className="block font-black uppercase mb-1">Quiet</span>
                  <input
                    type="text"
                    data-testid="account-quiet-hours"
                    value={quiet}
                    onChange={(e) => setQuiet(e.target.value)}
                    onBlur={commitLimits}
                    className={INPUT_CLASS}
                    pattern="\d{1,2}:\d{2}-\d{1,2}:\d{2}"
                    title="HH:MM-HH:MM"
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
