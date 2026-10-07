/**
 * Wave N — the Account control: sign in, backup, sync.
 *
 * The push preferences used to live here as a "Notifications" block; they
 * moved to the Alerts drawer (`NotificationToggle`), which is the ONE surface
 * that explains how this app can reach you. This drawer deliberately gains no
 * pointer line: one entry point is the point.
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
import { CloudUpload, KeyRound, LogOut, User, X } from "lucide-react";
import { type AccountApi } from "@/hooks/useAccount";
import { useAccountFeature } from "@/hooks/useAccountFeature";

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
  /**
   * The single account state machine, owned by `Dashboard`.
   *
   * Passed in rather than created here because the Alerts drawer needs the
   * SAME instance for its push section: a second `useAccount()` would mean a
   * second `GET /account/session`, a second key derivation and a second
   * auto-push interval racing over the same localStorage.
   */
  account: AccountApi;
  /** Test/demo affordance: render the drawer open on first paint. */
  defaultOpen?: boolean;
  /**
   * "Open the drawer now", as a counter — the Alerts drawer's
   * `Sign in to use push` button bumps it. Uncontrolled on purpose: this
   * component keeps owning `open`, so `defaultOpen` still means what it
   * meant, and no new modal is introduced to route one click to another.
   */
  openSignal?: number;
};

export function AccountControls({ account, defaultOpen = false, openSignal = 0 }: Props) {
  const { status, busy, message, prompt, recoveryCode } = account;
  // The feature flag, read from the ONE shared probe — never a second one.
  const feature = useAccountFeature();

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

  // "Sign in to use push" (Alerts drawer) opens THIS drawer. A counter, not
  // a boolean, so pressing it twice after closing still opens it again.
  const lastOpenSignal = useRef(0);
  useEffect(() => {
    if (openSignal !== 0 && openSignal !== lastOpenSignal.current) {
      lastOpenSignal.current = openSignal;
      setOpen(true);
    }
  }, [openSignal]);

  // Nothing to show until the feature flag probe answers, and nothing at all
  // when the answer is "this deployment has no account server". The flag
  // comes from the shared probe (one GET per page load); `status.probed` says
  // the state machine has caught up with it.
  if (!feature.enabled || !status.probed) return null;

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

export default AccountControls;