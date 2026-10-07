/**
 * Wave N — the Green Button shim telling the account server that new data
 * exists (the `data_available` trigger).
 *
 * The shim is the only process that hears Oakville Hydro's BatchList
 * webhook, and it deliberately holds **scalars only** (`lastSyncAt`,
 * `lastSyncBytes`, `dataAvailableSince` — see `lib/greenbutton/session.ts`).
 * So what crosses the docker network here is a sentence, not a reading:
 *
 *   "something changed at 09:11, here is a byte count"
 *
 * and the account server turns it into at most one notification per day per
 * subscriber, subject to the same caps as everything else
 * (`lib/account/push.ts#decide`).
 *
 * Rules this helper keeps:
 *
 *  - **The webhook must still answer 200.** A fan-out that fails, times out
 *    or is not configured must never make the utility's notification bounce
 *    and retry — so every outcome here is swallowed and logged, never thrown.
 *  - **Absent config means "no account server", not "misconfiguration".**
 *    Both `ACCT_NOTIFY_URL` and `ACCT_INTERNAL_TOKEN` must be present; the
 *    feature is off in exactly the deployments that do not run Wave N.
 */

const TIMEOUT_MS = 5_000;

function str(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? null : value.trim();
}

export type NotifyConfig = { url: string; token: string } | null;

/** Read the fan-out target. Memoised like every other config reader. */
export function getAccountNotifyConfig(): NotifyConfig {
  const url = str("ACCT_NOTIFY_URL");
  const token = str("ACCT_INTERNAL_TOKEN");
  if (!url || !token) return null;
  return { url, token };
}

/** Test hook — env changes must be observable. */
export function resetAccountNotifyConfig(): void {
  cached = null;
}

let cached: NotifyConfig | undefined | null = null;

export function accountNotifyConfig(): NotifyConfig {
  if (cached === undefined) cached = getAccountNotifyConfig();
  return cached;
}

/**
 * Fire the `data_available` fan-out. Resolves `true` only when the account
 * server acknowledged it — callers log the result and do nothing else.
 */
export async function notifyAccountServer(
  detail: { resources: number; bytes: number; at?: Date } = { resources: 0, bytes: 0 },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const cfg = accountNotifyConfig();
  if (!cfg) return false;

  const at = detail.at ?? new Date();
  const time = at.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" });

  try {
    const res = await fetchImpl(cfg.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Constant-time-compared on the other side; the path itself is
        // denied at the edge (ops/edge/default.conf.template).
        "x-account-internal": cfg.token,
      },
      body: JSON.stringify({
        topic: "data_available",
        title: "New usage data available",
        body: `Oakville Hydro posted new data at ${time}. Open the dashboard to pull it in.`,
        url: "/",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch (e) {
    console.warn(`[greenbutton] account fan-out failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
