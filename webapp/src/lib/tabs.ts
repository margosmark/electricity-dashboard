/**
 * Wave R — the four dashboard tabs and the one place that knows how a tab is
 * spelled in storage and in the URL.
 *
 * Pure data + string helpers only (no React, no window): the state machine
 * that glues these to localStorage and the location hash lives in
 * `src/hooks/useTabs.ts`, and the ARIA tablist that renders them lives in
 * `src/components/TabNav.tsx`.
 *
 * Why a hash as well as storage: a stored tab answers "where was I?", a
 * `#tab=` deep link answers "send me exactly this section", and the pair is
 * what makes the browser back button walk the tabs instead of leaving the app.
 */

export const TAB_IDS = ['overview', 'usage', 'plans', 'money'] as const;

export type TabId = (typeof TAB_IDS)[number];

/** The decision-first default: the best-choice banner is the first thing seen. */
export const DEFAULT_TAB: TabId = 'overview';

/** localStorage key the active tab is remembered under. */
export const TAB_STORAGE_KEY = 'oeo_active_tab';

export type TabDef = {
  id: TabId;
  /** Short label — the strip must fit 390 px with icons. */
  label: string;
  /** Full section name, shown as the panel's heading and the tab's tooltip. */
  title: string;
  /** One line about what lives here (tooltip / screen-reader context). */
  description: string;
};

export const TABS: readonly TabDef[] = [
  {
    id: 'overview',
    label: 'Overview',
    title: 'Overview',
    description: 'The answer first: best plan, totals, data freshness, this month’s bill.',
  },
  {
    id: 'usage',
    label: 'Usage',
    title: 'Usage',
    description: 'The chart, rate seasons, anomalies and the weekday/hour routine.',
  },
  {
    id: 'plans',
    label: 'Plans',
    title: 'Plans & Track Record',
    description: 'The three plans, shift advice and the audited switch history.',
  },
  {
    id: 'money',
    label: 'Money',
    title: 'Money & What-If',
    description: 'Bills, cost breakdowns, the EV scenario and the true-bill estimate.',
  },
] as const;

export function isTabId(value: unknown): value is TabId {
  return typeof value === 'string' && (TAB_IDS as readonly string[]).includes(value);
}

/** `usage` → `#tab=usage`. */
export function tabHash(tab: TabId): string {
  return `#tab=${tab}`;
}

/**
 * `#tab=plans` → `plans`; anything else → null.
 *
 * Null means "this URL states no tab", which is NOT the same as "overview":
 * the caller decides (mount falls back to storage, a hashchange falls back to
 * the default entry), because those two moments have different histories.
 */
export function tabFromHash(hash: string | null | undefined): TabId | null {
  if (!hash) return null;
  const match = /^#tab=([a-z]+)$/.exec(hash.trim());
  if (!match) return null;
  return isTabId(match[1]) ? match[1] : null;
}

/** Storage read, validated — a corrupt value degrades to the default tab. */
export function tabFromStorage(raw: string | null | undefined): TabId {
  return isTabId(raw) ? raw : DEFAULT_TAB;
}
