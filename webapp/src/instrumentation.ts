/** Fail account-server startup before accepting traffic if storage or selected
 * live-email configuration is unsafe. Load Node-only validation only in Node. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getAccountConfig, assertAccountDataDir } = await import("@/lib/account/config");
  const cfg = getAccountConfig();
  if (cfg.enabled) assertAccountDataDir(cfg);
}
