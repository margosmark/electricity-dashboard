/**
 * Wave N — the browser's account API client.
 *
 * Thin, typed wrappers over `/account/*`. Every non-2xx becomes an
 * `AccountApiError` carrying the machine-readable `error` code the server
 * sent, so the UI can say "that e-mail and password do not match" instead of
 * "request failed".
 *
 * Nothing here touches localStorage or React: it is the transport layer, and
 * `hooks/useAccount.ts` owns the state machine.
 */

export class AccountApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
    /**
     * The raw error body, so callers can read fields the short constructor
     * drops — 409 carries `currentRev`, which the conflict prompt needs.
     */
    readonly payload: Record<string, unknown> = {},
  ) {
    super(detail || code);
    this.name = "AccountApiError";
  }
}

export type PushPrefs = {
  topics: string[];
  dailyCap: number;
  quietStart: number;
  quietEnd: number;
  tzOffset: number;
};

export type SessionInfo = {
  enabled: boolean;
  authed: boolean;
  email?: string;
  kdfSalt?: string;
  hasRecoveryCode?: boolean;
  hasBlob?: boolean;
  rev?: number;
  updatedAt?: string | null;
  pushConfigured: boolean;
  vapidPublicKey: string | null;
  prefs?: PushPrefs;
  maxAccounts?: number;
};

export type SyncState = {
  rev: number;
  updatedAt: string | null;
  iv: string | null;
  data: string | null;
  kdfSalt: string;
  hasRecoveryCode: boolean;
};

export type SyncWriteResult = {
  rev: number;
  updatedAt: string;
  recoveryCode: string | null;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  } catch (e) {
    // Network failure is not an API error: the account server being down
    // must leave the dashboard working, so callers get a distinguishable code.
    throw new AccountApiError(0, "network", e instanceof Error ? e.message : String(e));
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const record = (body ?? {}) as { error?: string; detail?: string };
    throw new AccountApiError(res.status, record.error ?? `http_${res.status}`, record.detail, {
      ...record,
    });
  }
  return body as T;
}

function post<T>(path: string, payload?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: payload === undefined ? undefined : JSON.stringify(payload) });
}

/* -------------------------------------------------------------------------- */

export const fetchSession = () => request<SessionInfo>("/account/session");

export const login = (email: string, password: string) =>
  post<{
    ok: true;
    email: string;
    kdfSalt: string;
    hasRecoveryCode: boolean;
    hasBlob: boolean;
    rev: number;
    updatedAt: string | null;
  }>("/account/login", { email, password });

export const register = (email: string, password: string, hasLocalData: boolean) =>
  post<{
    ok: true;
    email: string;
    kdfSalt: string;
    recoveryCode: string | null;
    hasBlob: boolean;
    rev: number;
  }>("/account/register", { email, password, hasLocalData });

export const logout = () => post<{ ok: boolean }>("/account/logout");

export const getSync = () => request<SyncState>("/account/sync");

export function putSync(payload: { iv: string; data: string; baseRev: number }): Promise<SyncWriteResult> {
  return request<SyncWriteResult>("/account/sync", { method: "PUT", body: JSON.stringify(payload) });
}

export const fetchPrefs = () =>
  request<{ prefs: PushPrefs; subscriptionCount: number; pushConfigured: boolean; vapidPublicKey: string | null }>(
    "/account/push/preferences",
  );

export const putPrefs = (prefs: PushPrefs) =>
  request<{ ok: true; prefs: PushPrefs }>("/account/push/preferences", {
    method: "PUT",
    body: JSON.stringify(prefs),
  });

export const subscribe = (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
  post<{ ok: true; subscriptions: number }>("/account/push/subscribe", subscription);

export const unsubscribe = (endpoint: string) =>
  request<{ ok: true; subscriptions: number }>("/account/push/subscribe", {
    method: "DELETE",
    body: JSON.stringify({ endpoint }),
  });

export const notify = (payload: { topic: string; title: string; body?: string }) =>
  post<{ ok: true; sent: number; suppressed: string | null }>("/account/notify", payload);

export const recover = (payload: { email: string; recoveryCode: string; newPassword: string }) =>
  post<{
    ok: true;
    email: string;
    kdfSalt: string;
    hadBlob: boolean;
    blobDropped: boolean;
    blobDroppedReason: string | null;
    recoveryCode: string;
    rev: number;
  }>("/account/recover", payload);
