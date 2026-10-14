/** Edge-safe process identity. Keep this module free of Node-only imports. */
export function isAccountProcess(): boolean {
  const value = process.env.ACCT_ENABLED;
  return value !== undefined && value.trim().toLowerCase() === "true";
}
