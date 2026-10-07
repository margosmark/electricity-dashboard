/**
 * Wave N — the account state machine (auth + multi-device sync).
 *
 * Three jobs, in the order they matter:
 *
 *  1. **Never make the dashboard worse.** Every failure path here — server
 *     down, feature not deployed, bad password, unreadable blob — ends with
 *     the app working exactly as it did before accounts existed. The server
 *     copy is a mirror; localStorage is the source of truth while a page is
 *     open. That invariant is what stops a sync feature from becoming an
 *     outage (design §8, "data-loss floor").
 *  2. **Never lose data silently.** Two guards: an upload from a device that
 *     has never synced is an explicit prompt (the PM ruling's "first-login
 *     migration"), and a write that races another device comes back 409 and
 *     becomes an explicit choice instead of an overwrite. Logout refuses to
 *     wipe a browser whose latest changes never reached the server.
 *  3. **Push without being asked.** After the account is established, the
 *     local dataset is re-fingerprinted on a short interval and whenever the
 *     page is being hidden, so "data persists outside this browser" does not
 *     depend on remembering to press a button.
 *
 * The derived key (`lib/account/crypto.ts`) is needed for anything past
 * auth, so a session with no key — a fresh profile with a surviving cookie —
 * renders as "locked": the same sign-in form, prefilled, which re-derives
 * the key and pulls.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "@/lib/account/client";
import { AccountApiError, type PushPrefs, type SessionInfo } from "@/lib/account/client";
import {
  decryptBlob,
  deriveBlobKey,
  encryptBlob,
  exportSessionKey,
  importSessionKey,
} from "@/lib/account/crypto";
import * as sync from "@/lib/account/sync";
import { parseBackup, serializeBackup } from "@/lib/backup";

export type AccountMessage = { tone: "ok" | "error"; text: string } | null;

export type AccountPrompt =
  /** Local data exists, the account has no copy yet → explicit opt-in upload. */
  | { kind: "migrate" }
  /** Both sides moved (or the server is ahead) → the user picks a winner. */
  | { kind: "conflict"; serverRev: number }
  | null;

export type AccountStatus = {
  probed: boolean;
  enabled: boolean;
  authed: boolean;
  /** Signed in but this browser holds no derived key — sign in again. */
  locked: boolean;
  email: string | null;
  serverRev: number;
  hasBlob: boolean;
  updatedAt: string | null;
  hasRecoveryCode: boolean;
  pushConfigured: boolean;
  /** VAPID public key — needed to `subscribe()`; null when push is not set up. */
  vapidPublicKey: string | null;
  prefs: PushPrefs | null;
  subscriptionCount: number;
};

const INITIAL: AccountStatus = {
  probed: false,
  enabled: false,
  authed: false,
  locked: false,
  email: null,
  serverRev: 0,
  hasBlob: false,
  updatedAt: null,
  hasRecoveryCode: false,
  pushConfigured: false,
  vapidPublicKey: null,
  prefs: null,
  subscriptionCount: 0,
};

/** How often the auto-push checks whether the dataset moved. */
const AUTO_PUSH_MS = 5_000;

/** localStorage flag: the user was asked to upload and said no. */
const UPLOAD_DECLINED_KEY = "account_upload_declined";

type Options = {
  /**
   * What to do after the local dataset changed underneath the app (a pull, a
   * migration upload, a wipe). Dashboard passes a reload so every hook that
   * seeds itself from localStorage re-reads it — the same contract
   * `useEnergyData({ onBackupApplied })` already has.
   */
  onDataApplied?: () => void;
};

export function useAccount(options: Options = {}) {
  const { onDataApplied } = options;

  const [status, setStatus] = useState<AccountStatus>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<AccountMessage>(null);
  const [prompt, setPromptState] = useState<AccountPrompt>(null);
  /**
   * The same value as `prompt`, readable synchronously.
   *
   * `signIn` finishes BEFORE React re-renders with the prompt it just raised,
   * so a caller asking "did sign-in end with a question for the user?" from
   * rendered state would always see `null`. The drawer reads this ref to stay
   * open when sign-in raised the first-upload prompt — a prompt nobody can
   * see is a prompt that never happened (PM ruling: never silent).
   */
  const promptRef = useRef<AccountPrompt>(null);
  const showPrompt = useCallback((next: AccountPrompt) => {
    promptRef.current = next;
    setPromptState(next);
  }, []);
  /** Shown once, right after the server first stores data (see sync PUT). */
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  const keyRef = useRef<CryptoKey | null>(null);
  const saltRef = useRef<string | null>(null);
  const serverRevRef = useRef(0);
  const fingerprintRef = useRef<string | null>(null);
  const busyRef = useRef(false);

  const say = useCallback((tone: "ok" | "error", text: string) => setMessage({ tone, text }), []);

  /* ------------------------------------------------------------------------
   * Key handling
   * ---------------------------------------------------------------------- */

  const adoptKey = useCallback(async (password: string, salt: string): Promise<boolean> => {
    try {
      const key = await deriveBlobKey(password, salt);
      keyRef.current = key;
      saltRef.current = salt;
      sync.saveSessionKey(await exportSessionKey(key));
      return true;
    } catch (e) {
      say("error", e instanceof Error ? e.message : "Could not derive the encryption key.");
      return false;
    }
  }, [say]);

  const loadKeyIfPresent = useCallback(async (): Promise<boolean> => {
    const stored = sync.loadSessionKey();
    if (!stored) return false;
    try {
      keyRef.current = await importSessionKey(stored);
      return true;
    } catch {
      // Unreadable key is worse than no key: drop it so the UI asks again
      // instead of failing every decrypt with a cryptic error.
      sync.clearSessionKey();
      return false;
    }
  }, []);

  /* ------------------------------------------------------------------------
   * Read paths
   * ---------------------------------------------------------------------- */

  const pullNow = useCallback(async (): Promise<boolean> => {
    const key = keyRef.current;
    if (!key) {
      say("error", "Enter your password to unlock this device's copy.");
      return false;
    }
    const remote = await api.getSync();
    serverRevRef.current = remote.rev;
    if (remote.rev === 0 || !remote.data || !remote.iv) return false;

    let text: string;
    try {
      text = await decryptBlob(key, remote.iv, remote.data);
    } catch {
      // AES-GCM is authenticated: this is either the wrong password or a
      // tampered/corrupt blob. Distinguishing them would be guessing.
      say(
        "error",
        "The server copy could not be decrypted with this device's key — it was encrypted with a different password.",
      );
      return false;
    }

    const parsed = parseBackup(text);
    if (!parsed.ok) {
      say("error", `The server copy was rejected: ${parsed.error}`);
      return false;
    }

    sync.applyDocument(parsed.value);
    sync.setLocalRev(remote.rev);
    fingerprintRef.current = sync.documentFingerprint(parsed.value);
    setStatus((s) => ({ ...s, serverRev: remote.rev, hasBlob: true, updatedAt: remote.updatedAt }));
    onDataApplied?.();
    return true;
  }, [onDataApplied, say]);

  /**
   * Work out what this device owes the account after signing in (or on load).
   *
   * Four cases, and the difference between them is whether data could be
   * lost: adopt the server copy on an empty device, ask before creating one,
   * ask before overwriting either side, and otherwise do nothing at all.
   */
  const reconcile = useCallback(
    async (serverRev: number) => {
      const localData = sync.hasLocalData();
      const localRev = sync.getLocalRev();

      if (!localData) {
        // Empty device (a phone that has never seen the export): adopting a
        // server copy cannot lose anything, so it is not a question.
        if (serverRev > 0) await pullNow().catch(() => false);
        return;
      }

      if (serverRev > localRev) {
        showPrompt({ kind: "conflict", serverRev });
        return;
      }

      if (serverRev === 0 && localRev === 0) {
        // Nothing on either side has ever been synced. Uploading is a
        // decision, not a default (PM ruling: "never silent").
        if (localStorage.getItem(UPLOAD_DECLINED_KEY) === "1") return;
        showPrompt({ kind: "migrate" });
        return;
      }

      // In step: remember what we would upload, so the auto-push fires only
      // when the dataset actually changes.
      const doc = sync.readLocalDocument();
      fingerprintRef.current = doc ? sync.documentFingerprint(doc) : null;
    },
    [pullNow, showPrompt],
  );

  const applySessionInfo = useCallback(
    async (info: SessionInfo) => {
      if (!info.enabled) {
        setStatus({ ...INITIAL, probed: true, enabled: false });
        return;
      }
      const authed = Boolean(info.authed);
      const hasKey = authed ? await loadKeyIfPresent() : false;
      if (hasKey && info.kdfSalt) saltRef.current = info.kdfSalt;
      serverRevRef.current = info.rev ?? 0;

      setStatus({
        probed: true,
        enabled: true,
        authed,
        locked: authed && !hasKey,
        email: info.email ?? null,
        serverRev: info.rev ?? 0,
        hasBlob: Boolean(info.hasBlob),
        updatedAt: info.updatedAt ?? null,
        hasRecoveryCode: Boolean(info.hasRecoveryCode),
        pushConfigured: info.pushConfigured,
        vapidPublicKey: info.vapidPublicKey ?? null,
        prefs: info.prefs ?? null,
        subscriptionCount: 0,
      });

      if (authed && hasKey) {
        try {
          await reconcile(info.rev ?? 0);
        } catch {
          /* a failed reconcile must not stop the app from rendering */
        }
        try {
          const loaded = await api.fetchPrefs();
          let prefs = loaded.prefs;
          // Quiet hours and the daily-cap boundary are computed in the USER's
          // time, not UTC (`lib/account/push.ts` takes `tzOffset`). Nothing
          // else can supply it — the server cannot know the timezone of the
          // person reading the notification — so the first device that
          // notices a mismatch writes it. A failure here is cosmetic.
          const deviceOffset = -new Date().getTimezoneOffset();
          if (prefs.tzOffset !== deviceOffset) {
            try {
              prefs = (await api.putPrefs({ ...prefs, tzOffset: deviceOffset })).prefs;
            } catch {
              /* keep the stored offset; the next save corrects it */
            }
          }
          setStatus((s) => ({ ...s, prefs, subscriptionCount: loaded.subscriptionCount }));
        } catch {
          /* prefs are cosmetic */
        }
      }
    },
    [loadKeyIfPresent, reconcile],
  );

  const probe = useCallback(async () => {
    try {
      await applySessionInfo(await api.fetchSession());
    } catch {
      // 404 = this is the app container (no ACCT_* env), 502 = the
      // account-server container is not running, 0 = unreachable. All three
      // mean the same thing to the UI: there is no account system here, so
      // draw no account controls at all.
      setStatus({ ...INITIAL, probed: true, enabled: false });
    }
  }, [applySessionInfo]);

  useEffect(() => {
    // Once per mount: the probe is the feature flag — 404/502/unreachable all
    // mean "this deployment has no account system", so the controls stay off
    // the page. The async IIFE is the `useRateStaleness` shape: no state can
    // be touched before the first suspension point.
    void (async () => {
      await probe();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------------------
   * Write paths
   * ---------------------------------------------------------------------- */

  const pushDoc = useCallback(
    async (explicit: boolean): Promise<"unchanged" | "pushed" | "conflict" | "failed" | "no_data"> => {
      const key = keyRef.current;
      const doc = sync.readLocalDocument();
      if (!doc) return "no_data";
      if (!key) return "failed";

      const fp = sync.documentFingerprint(doc);
      if (!explicit && fp === fingerprintRef.current) return "unchanged";

      let payload: { iv: string; data: string };
      try {
        payload = await encryptBlob(key, serializeBackup(doc));
      } catch (e) {
        if (explicit) say("error", e instanceof Error ? e.message : "Could not encrypt the data.");
        return "failed";
      }

      try {
        const result = await api.putSync({ ...payload, baseRev: serverRevRef.current });
        serverRevRef.current = result.rev;
        sync.setLocalRev(result.rev);
        fingerprintRef.current = fp;
        setStatus((s) => ({
          ...s,
          serverRev: result.rev,
          hasBlob: true,
          updatedAt: result.updatedAt,
          hasRecoveryCode: true,
        }));
        if (result.recoveryCode) setRecoveryCode(result.recoveryCode);
        return "pushed";
      } catch (e) {
        if (e instanceof AccountApiError && e.status === 409) {
          const currentRev = Number((e.payload as { currentRev?: number }).currentRev ?? 0);
          showPrompt({ kind: "conflict", serverRev: currentRev });
          return "conflict";
        }
        // Server unreachable: swallow it on the automatic path (the dashboard
        // must not care), surface it when the user pressed a button.
        if (explicit) {
          say(
            "error",
            e instanceof AccountApiError && e.status === 0
              ? "The account server is not reachable — nothing was uploaded, and this browser still has your data."
              : `Could not upload: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return "failed";
      }
    },
    [say, showPrompt],
  );

  /** Debounced auto-push. Fires only once the account and key both exist. */
  const autoPush = useCallback(() => {
    if (!status.authed || status.locked || prompt || busyRef.current) return;
    if (serverRevRef.current === 0 && sync.getLocalRev() === 0) return; // migration still pending
    void pushDoc(false);
  }, [prompt, pushDoc, status.authed, status.locked]);

  useEffect(() => {
    if (!status.authed || status.locked) return;
    const id = setInterval(autoPush, AUTO_PUSH_MS);
    const onHidden = () => {
      if (document.visibilityState === "hidden") autoPush();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [autoPush, status.authed, status.locked]);

  /* ------------------------------------------------------------------------
   * Auth actions
   * ---------------------------------------------------------------------- */

  const signIn = useCallback(
    async (email: string, password: string): Promise<boolean> => {
      setBusy(true);
      busyRef.current = true;
      try {
        const info = await api.login(email, password);
        if (!(await adoptKey(password, info.kdfSalt))) return false;
        serverRevRef.current = info.rev;
        fingerprintRef.current = null;
        showPrompt(null);
        await applySessionInfo({
          ...(await api.fetchSession()),
          enabled: true,
          authed: true,
        } as SessionInfo);
        say("ok", "Signed in.");
        return true;
      } catch (e) {
        const detail = e instanceof AccountApiError ? e.detail ?? e.code : "unknown_error";
        say("error", describeAuthError(detail));
        return false;
      } finally {
        setBusy(false);
        busyRef.current = false;
      }
    },
    [adoptKey, applySessionInfo, say, showPrompt],
  );

  const signUp = useCallback(
    async (email: string, password: string): Promise<boolean> => {
      setBusy(true);
      busyRef.current = true;
      try {
        const created = await api.register(email, password, sync.hasLocalData());
        if (!(await adoptKey(password, created.kdfSalt))) return false;
        serverRevRef.current = created.rev;
        await applySessionInfo({
          ...(await api.fetchSession()),
          enabled: true,
          authed: true,
        } as SessionInfo);
        if (created.recoveryCode) setRecoveryCode(created.recoveryCode);
        say(
          "ok",
          sync.hasLocalData()
            ? "Account created. Choose whether to back this device's data up to it."
            : "Account created.",
        );
        return true;
      } catch (e) {
        const detail = e instanceof AccountApiError ? e.detail ?? e.code : "unknown_error";
        say("error", describeAuthError(detail));
        return false;
      } finally {
        setBusy(false);
        busyRef.current = false;
      }
    },
    [adoptKey, applySessionInfo, say],
  );

  const signOut = useCallback(async () => {
    setBusy(true);
    busyRef.current = true;
    let note = "Signed out — this device's data was removed, the server copy was kept.";
    try {
      const doc = sync.readLocalDocument();
      let safeToWipe = true;

      if (doc && !keyRef.current) {
        safeToWipe = false;
        note = "Signed out. Your local data was left in place: this device has no unlocked copy to compare it against.";
      } else if (doc) {
        const pending = sync.documentFingerprint(doc) !== fingerprintRef.current;
        if (pending) {
          // The card's one unacceptable failure mode: losing UNSYNCED local
          // data. Upload first; if that fails, do not wipe.
          const result = await pushDoc(true);
          if (result !== "pushed" && result !== "unchanged") {
            safeToWipe = false;
            note = "Signed out, but this device's latest changes could not be uploaded — they were left in the browser.";
          }
        }
      }

      // End the server session BEFORE touching this browser. If this call
      // fails the catch below reports it and nothing local has changed —
      // a failed sign-out must never be able to destroy data, which is the
      // mirror image of the rule above (never upload less than we claim).
      await api.logout();

      if (safeToWipe) {
        sync.wipeLocalDataset();
        note = "Signed out — this device's data was removed, the server copy was kept.";
      }

      keyRef.current = null;
      fingerprintRef.current = null;
      serverRevRef.current = 0;
      showPrompt(null);
      setStatus((s) => ({ ...s, authed: false, locked: false, email: null, serverRev: 0, hasBlob: false }));
      say("ok", note);
      if (safeToWipe) onDataApplied?.();
    } catch (e) {
      say(
        "error",
        e instanceof AccountApiError && e.status === 0
          ? "The account server is not reachable — you are still signed in on this device."
          : "Could not sign out.",
      );
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }, [onDataApplied, pushDoc, say, showPrompt]);

  /* ------------------------------------------------------------------------
   * Prompt resolutions
   * ---------------------------------------------------------------------- */

  const acceptUpload = useCallback(async () => {
    showPrompt(null);
    setBusy(true);
    try {
      const result = await pushDoc(true);
      if (result === "pushed") say("ok", "Backed up to your account.");
    } finally {
      setBusy(false);
    }
  }, [pushDoc, say, showPrompt]);

  const declineUpload = useCallback(() => {
    try {
      localStorage.setItem(UPLOAD_DECLINED_KEY, "1");
    } catch {
      /* storage blocked: we will simply ask again */
    }
    showPrompt(null);
  }, [showPrompt]);

  /** Conflict: this device wins — overwrite the server copy (LWW, explicit). */
  const keepThisDevice = useCallback(async () => {
    const current = prompt && prompt.kind === "conflict" ? prompt.serverRev : serverRevRef.current;
    serverRevRef.current = current;
    showPrompt(null);
    setBusy(true);
    try {
      const result = await pushDoc(true);
      if (result === "pushed") say("ok", "This device's data is now the account copy.");
    } finally {
      setBusy(false);
    }
  }, [prompt, pushDoc, say, showPrompt]);

  /** Conflict: the server wins — replace what is in this browser. */
  const useServerCopy = useCallback(async () => {
    showPrompt(null);
    setBusy(true);
    try {
      const ok = await pullNow();
      if (ok) say("ok", "Loaded your account's copy into this browser.");
    } catch {
      say("error", "Could not load the account copy.");
    } finally {
      setBusy(false);
    }
  }, [pullNow, say, showPrompt]);

  /** Explicit button: upload now (also clears a "declined" marker). */
  const syncNow = useCallback(async () => {
    setBusy(true);
    try {
      try {
        localStorage.removeItem(UPLOAD_DECLINED_KEY);
      } catch {
        /* ignore */
      }
      const result = await pushDoc(true);
      if (result === "pushed") say("ok", "Backed up to your account.");
      else if (result === "unchanged") say("ok", "Already up to date.");
      else if (result === "no_data") say("error", "There is nothing to back up yet — upload your utility XML first.");
    } finally {
      setBusy(false);
    }
  }, [pushDoc, say]);

  /* ------------------------------------------------------------------------
   * Push notifications
   * ---------------------------------------------------------------------- */

  const enableNotifications = useCallback(async (): Promise<boolean> => {
    const publicKey = status.pushConfigured ? status.vapidPublicKey : null;
    if (!publicKey) {
      say("error", "This server has no VAPID keys, so notifications are not enabled.");
      return false;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      say("error", "This browser does not support Web Push.");
      return false;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        say("error", "Notifications were blocked in the browser.");
        return false;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8(publicKey),
      });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        say("error", "The browser produced an unusable subscription.");
        return false;
      }
      const res = await api.subscribe({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      });
      setStatus((s) => ({ ...s, subscriptionCount: res.subscriptions }));
      say("ok", "Notifications enabled.");
      return true;
    } catch (e) {
      say("error", `Could not enable notifications: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }, [say, status.pushConfigured, status.vapidPublicKey]);

  const disableNotifications = useCallback(async () => {
    try {
      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        const existing = await registration?.pushManager.getSubscription();
        if (existing) {
          const endpoint = existing.endpoint;
          await existing.unsubscribe().catch(() => false);
          await api.unsubscribe(endpoint).catch(() => null);
        }
      }
      setStatus((s) => ({ ...s, subscriptionCount: 0 }));
      say("ok", "Notifications turned off.");
    } catch {
      say("error", "Could not turn notifications off.");
    }
  }, [say]);

  const savePrefs = useCallback(
    async (prefs: PushPrefs) => {
      setBusy(true);
      try {
        // Always send this device's offset: quiet hours mean the reader's
        // night, and the field is meaningless at UTC default 0 for anyone
        // who is not on UTC.
        const res = await api.putPrefs({ ...prefs, tzOffset: -new Date().getTimezoneOffset() });
        setStatus((s) => ({ ...s, prefs: res.prefs }));
        say("ok", "Notification preferences saved.");
      } catch {
        say("error", "Could not save notification preferences.");
      } finally {
        setBusy(false);
      }
    },
    [say],
  );

  return {
    status,
    busy,
    message,
    prompt,
    /** Synchronous view of `prompt` — see the field's comment. */
    promptRef,
    recoveryCode,
    /** Surface a message from a caller outside this hook (e.g. recovery). */
    notify: say,
    dismissMessage: () => setMessage(null),
    dismissRecoveryCode: () => setRecoveryCode(null),
    refresh: probe,
    signIn,
    signUp,
    signOut,
    syncNow,
    pull: pullNow,
    acceptUpload,
    declineUpload,
    keepThisDevice,
    useServerCopy,
    enableNotifications,
    disableNotifications,
    savePrefs,
  };
}

/* -------------------------------------------------------------------------- */

/** Human-readable auth failures, one per server code — no raw codes in UI. */
function describeAuthError(code: string): string {
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
      return code;
  }
}

/** VAPID keys are unpadded base64url; WebCrypto wants raw bytes. */
function urlBase64ToUint8(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
