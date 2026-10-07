/**
 * Wave M — background refresh decisions.
 *
 * Everything in this file is PURE: no localStorage, no Date.now(), no DOM.
 * Given the state the app already holds it answers three questions:
 *
 *   1. should this trigger actually run a refresh?  (`shouldBackgroundRefresh`)
 *   2. did anything worth telling the user about change?  (`buildRefreshNotices`)
 *   3. what exactly do we say?  (`notificationPayload`)
 *
 * Keeping 2 and 3 pure is the whole point of the card's "tests first" item:
 * the interesting bugs are visibility rules (a banner that fires for a
 * manual-upload-only user, a notice that re-fires every 15 minutes), and
 * those are only cheap to test if the rule is a function of its inputs.
 *
 * --------------------------------------------------------------------------------
 * Honest limits (documented here because they change how the feature is used)
 * --------------------------------------------------------------------------------
 *
 * PERIODIC BACKGROUND SYNC — `registration.periodicSync.register()` is
 * Chromium-only and, in Chrome, only works for a web app that has been
 * **installed to the device and launched as a distinct application**; it
 * "is not available in the context of a regular tab in Chrome". MDN marks it
 * as not Baseline (Safari and Firefox do not implement it). `minInterval` is
 * a FLOOR, not a cadence — Chrome fires `periodicsync` according to the
 * site's engagement score, the device's power/connectivity state, and how
 * often the person actually uses the app, so an hourly request can become a
 * daily or a never. `register()` rejects with `NotAllowedError` when the
 * `periodic-background-sync` permission is not granted (no prompt is shown —
 * it is simply not available).
 *
 * Because of that, the loop that actually delivers "fresh when you come back"
 * everywhere is the focus / visibilitychange fallback below; periodic sync is
 * a bonus that also runs while the app is fully closed. Source for the two
 * quoted constraints: developer.chrome.com/docs/capabilities/periodic-background-sync
 * ("When can it be used?") and MDN's PeriodicSyncManager register().
 *
 * WHAT CAN HAPPEN WHILE CLOSED — the service worker has NO access to
 * `localStorage`, so it cannot merge readings and cannot re-price three plans
 * by itself. Its periodicsync handler therefore only FETCHES the feed and
 * stages it in Cache Storage (plus messages any open window). The merge, the
 * comparison and the banner all still happen in the page. That is a real
 * limitation of the browser platform, not a shortcut — see public/sw.js.
 *
 * WITHOUT AN ACCOUNT — there is no server-side user, so there is no email and
 * no SMS. Alerts are the in-app banner and, only if the user explicitly turns
 * it on, an on-device browser notification. Queued separately as Wave N.
 */

import type { FullDataTotals, ProcessedPoint } from './energy';
import { PLAN_LABEL, type PlanId } from '@/hooks/useSelectedPlan';

/* -------------------------------------------------------------------------- *
 * Storage keys (owned by the hook; named here so lib and hook cannot drift).
 * -------------------------------------------------------------------------- */

/** Best plan the user has been told about. Absent ⇒ current plan. */
export const PLAN_ACK_KEY = 'wave_m_ack_plan';
/** Newest rate effectiveDate seen at the last acknowledgement. Absent ⇒ baseline. */
export const RATE_ACK_KEY = 'wave_m_ack_rate';
/** `notice id` last pushed as an OS notification, so a banner that survives a
 *  reload does not re-notify on every open. */
export const NOTIFIED_KEY = 'wave_m_notified';
/** User's explicit opt-in to on-device notifications. Never set by default. */
export const NOTIFICATIONS_ENABLED_KEY = 'wave_m_notifications';

/* -------------------------------------------------------------------------- *
 * The page ⇄ service-worker handshake.
 *
 * `public/sw.js` is a static file and cannot import from the bundle, so the
 * names below are duplicated there. `backgroundRefresh.test.ts` asserts the
 * two files agree — this is the seam where a silent drift would otherwise
 * park every staged feed where nobody looks.
 * -------------------------------------------------------------------------- */

/** Fixed-name caches: deliberately NOT `${VERSION}-prefixed`, because the
 *  activate handler drops everything that does not start with the new
 *  version, and a cursor or a staged feed must survive a deploy. */
export const GB_CURSOR_CACHE = 'oeo-gb-cursor';
export const GB_STAGED_CACHE = 'oeo-gb-staged';
/** Synthetic Cache Storage keys (a cache is keyed by Request, and neither of
 *  these is ever fetched over the network). */
export const GB_CURSOR_URL = '/__gb_cursor';
export const GB_STAGED_URL = '/__gb_staged_feed';
/** postMessage type: the SW has staged a feed and an open window should merge it. */
export const GB_STAGED_MESSAGE = 'gb-staged-feed';
/** The `periodicsync` tag. Requested by lib/periodicSync.ts, handled by
 *  public/sw.js, asserted identical by backgroundRefresh.test.ts. */
export const GB_PERIODIC_TAG = 'greenbutton-refresh';

/* -------------------------------------------------------------------------- *
 * Trigger rules
 * -------------------------------------------------------------------------- */

/**
 * Floor between two refreshes, however they were triggered (15 minutes — the
 * same cadence Wave K's visible-tab interval already uses, so the app's total
 * rate stays "at most one pull per quarter hour").
 *
 * Read through `window.__GB_BG_MIN_MS` so the e2e can prove the
 * `visibilitychange` wiring in a couple of seconds instead of a quarter hour.
 * The seam is inert unless a test installs it; `backgroundRefreshMinMs` is
 * pinned by a unit test so it can never quietly become "no throttle".
 */
export const DEFAULT_BACKGROUND_REFRESH_MIN_MS = 15 * 60 * 1000;

declare global {
  var __GB_BG_MIN_MS: number | undefined;
}

export function backgroundRefreshMinMs(): number {
  if (typeof window === 'undefined') return DEFAULT_BACKGROUND_REFRESH_MIN_MS;
  const seam = window.__GB_BG_MIN_MS;
  return typeof seam === 'number' && Number.isFinite(seam) && seam >= 0
    ? seam
    : DEFAULT_BACKGROUND_REFRESH_MIN_MS;
}

export type RefreshTrigger =
  /** the one-shot pull on page load */
  | 'load'
  /** Wave K's visible-tab interval */
  | 'interval'
  /** the tab came back to the foreground */
  | 'visibility'
  /** the window regained focus */
  | 'focus'
  /** the service worker staged a feed (periodic background sync) */
  | 'staged';

export type RefreshDecisionInput = {
  trigger: RefreshTrigger;
  now: number;
  /** 0 = nothing has refreshed yet this session. */
  lastRefreshAt: number;
  minIntervalMs: number;
  /** The `gb_session` cookie exists — the ONLY gate that keeps a
   *  manual-DMD-only user's experience byte-for-byte unchanged. */
  connected: boolean;
  /** A refresh is already in flight (never overlap). */
  syncing: boolean;
  visibility: DocumentVisibilityState;
};

/**
 * Whether a trigger should start a background refresh.
 *
 * Four rules, in order:
 *  - never without an authorisation (`connected`) — scope 4 of the card:
 *    a manual-DMD-only user gets no banner, no notification permission
 *    request, and no background loop, ever;
 *  - never overlapping a refresh already running;
 *  - the interval only ticks while the tab is visible (Wave K behaviour,
 *    unchanged) and the visibility/focus triggers only fire when it IS
 *    visible (they are meaningless otherwise);
 *  - everything except the initial load is throttled by `minIntervalMs`,
 *    so tab-flipping cannot turn into a request storm.
 */
export function shouldBackgroundRefresh(input: RefreshDecisionInput): boolean {
  if (!input.connected) return false;
  if (input.syncing) return false;
  if (input.trigger === 'interval' && input.visibility !== 'visible') return false;
  if ((input.trigger === 'visibility' || input.trigger === 'focus') && input.visibility !== 'visible') {
    return false;
  }
  if (input.lastRefreshAt > 0 && input.now - input.lastRefreshAt < input.minIntervalMs) {
    return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- *
 * Notice detection
 * -------------------------------------------------------------------------- */

export type RefreshNoticeKind = 'plan-change' | 'rate-change';

export type PlanChangeNotice = {
  kind: 'plan-change';
  /** Stable id — what the notification guard de-duplicates on. */
  id: string;
  /** The newly-best plan. */
  plan: PlanId;
  /** What the dataset used to say was best (the user's plan before the
   *  first acknowledgement). Drives the card's "{old}" slot. */
  previousBest: PlanId;
  /** What the user actually has selected (Wave H's `useSelectedPlan`). */
  currentPlan: PlanId;
  /** $/mo the new best saves over `previousBest`. */
  monthlySavingVsPrevious: number;
  /** $/mo it would save the user over what they are on right now. */
  monthlySavingVsCurrent: number;
  /** Cost of the whole dataset under each plan, per month. */
  monthlyCosts: { plan: PlanId; cost: number }[];
  headline: string;
  detail: string;
};

export type RateChangeNotice = {
  kind: 'rate-change';
  id: string;
  /** The effectiveDate the readings are now priced under. */
  effectiveDate: string;
  /** The effectiveDate the previous observation saw. */
  previousEffectiveDate: string;
  headline: string;
  detail: string;
};

export type RefreshNotice = PlanChangeNotice | RateChangeNotice;

export type RefreshNoticeInput = {
  /** `gb_session` present. False ⇒ zero output, zero side effects. */
  connected: boolean;
  /** The whole-dataset 3-plan comparison (`calculateFullDataTotals`). */
  totals: FullDataTotals | null;
  /** Every processed reading — needed to see which rate set is in force. */
  processedData: ProcessedPoint[];
  /** Wave H's persisted plan. */
  currentPlan: PlanId;
  /** Last acknowledged best plan; `null` = never acknowledged. */
  ackPlan: string | null;
  /** Last acknowledged rate effectiveDate; `null` = never observed. */
  ackRateDate: string | null;
};

export type RefreshNoticeResult = {
  notices: RefreshNotice[];
  /**
   * Non-null on the very first observation: the caller must persist this as
   * the rate baseline WITHOUT showing anything. It is how "advanced since the
   * last sync" gets a starting point without nagging everyone on day one.
   */
  rateBaseline: string | null;
};

/** Newest `activeRateSet.effectiveDate` any reading is priced under. */
export function maxActiveEffectiveDate(processedData: ProcessedPoint[]): string | null {
  let max: string | null = null;
  for (const row of processedData) {
    const date = row.activeRateSet?.effectiveDate;
    if (date && (max === null || date > max)) max = date;
  }
  return max;
}

/** Days spanned by the dataset (inclusive), floored at 1. */
export function datasetDays(totals: FullDataTotals): number {
  const start = Date.parse(`${totals.firstDate}T00:00:00Z`);
  const end = Date.parse(`${totals.lastDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1;
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}

/** Whole-dataset cost of a plan, normalised to a month (30.44 d — the same
 *  annualisation basis the totals strip uses: `perDay * 365.25 / 12`). */
export function perMonth(total: number, days: number): number {
  return (total / days) * (365.25 / 12);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function planCost(totals: FullDataTotals, plan: PlanId): number {
  return plan === 'TOU' ? totals.costTOU : plan === 'Tiered' ? totals.costTiered : totals.costULO;
}

/**
 * The plan-switch signal.
 *
 * Fires when the dataset's best plan is BOTH different from what the user has
 * selected AND different from the last one they were told about — so it reads
 * "your best plan changed", appears once, and stays dismissed until the answer
 * genuinely changes again. Recomputing from state on every refresh (rather
 * than diffing an event) is what makes a background pull that brings back
 * "nothing new" still able to raise a banner: the comparison is a property of
 * the data, not of the fetch.
 */
export function detectPlanChange(input: {
  totals: FullDataTotals | null;
  currentPlan: PlanId;
  ackPlan: string | null;
}): PlanChangeNotice | null {
  const { totals, currentPlan } = input;
  if (!totals) return null;

  const best = totals.bestPlan;
  // Nothing to act on: the user is already on the winner.
  if (best === currentPlan) return null;
  // The acknowledgement defaults to the user's plan — an unacknowledged
  // answer that happens to match what they picked is not news.
  const previousBest = input.ackPlan === currentPlan || input.ackPlan === null
    ? currentPlan
    : isKnownPlan(input.ackPlan)
      ? input.ackPlan
      : currentPlan;
  if (best === previousBest) return null;

  const days = datasetDays(totals);
  const bestMonthly = perMonth(planCost(totals, best), days);
  const prevMonthly = perMonth(planCost(totals, previousBest), days);
  const currentMonthly = perMonth(planCost(totals, currentPlan), days);

  const savingVsPrevious = round2(Math.max(0, prevMonthly - bestMonthly));
  const savingVsCurrent = round2(Math.max(0, currentMonthly - bestMonthly));

  // A winner whose margin rounds away to nothing is a TIE, not a change:
  // "your best plan changed: X now saves ~$0.00/mo" would be noise. The
  // whole-dataset basis produces exactly that when a couple of stray old rows
  // stretch the denominator (43 kWh spread across seven years measures a
  // 0.0000003¢/mo difference), and a tie is not worth interrupting anyone for.
  if (savingVsPrevious <= 0) return null;

  return {
    kind: 'plan-change',
    id: `plan:${best}`,
    plan: best,
    previousBest,
    currentPlan,
    monthlySavingVsPrevious: savingVsPrevious,
    monthlySavingVsCurrent: savingVsCurrent,
    monthlyCosts: (['Tiered', 'TOU', 'ULO'] as const)
      .map((p) => ({ plan: p, cost: round2(perMonth(planCost(totals, p), days)) }))
      .sort((a, b) => a.cost - b.cost),
    // The card's copy, verbatim in shape: name the winner and the gap.
    headline: `Your best plan changed: ${PLAN_LABEL[best]} now saves ~$${savingVsPrevious.toFixed(2)}/mo vs ${PLAN_LABEL[previousBest]}`,
    detail:
      best === previousBest
        ? ''
        : savingVsCurrent > 0 && currentPlan !== previousBest
          ? `You are on ${PLAN_LABEL[currentPlan]} — switching to ${PLAN_LABEL[best]} is ~$${savingVsCurrent.toFixed(2)}/mo on these readings.`
          : `Recomputed across ${totals.totalKwh.toFixed(0)} kWh of readings after the latest refresh.`,
  };
}

function isKnownPlan(value: string): value is PlanId {
  return value === 'TOU' || value === 'Tiered' || value === 'ULO';
}

/**
 * The rate-change signal: any reading now priced under a LATER
 * `effectiveDate` than the last observation saw. That happens two ways and
 * both matter — the readings themselves cross into a new rate period, or the
 * deployed `/api/rates` gained a newer set. "New OEB rates in effect" is true
 * in either case: the three-plan comparison just changed meaning.
 */
export type RateChangeOutcome =
  /** Nothing priced yet, or this is the first ever observation. */
  | { kind: 'none' }
  /** First observation: persist `baseline` silently, show nothing. */
  | { kind: 'baseline'; baseline: string }
  /** The effectiveDate advanced since the last acknowledgement. */
  | { kind: 'changed'; notice: RateChangeNotice };

export function detectRateChange(input: {
  processedData: ProcessedPoint[];
  ackRateDate: string | null;
}): RateChangeOutcome {
  const current = maxActiveEffectiveDate(input.processedData);
  if (current === null) return { kind: 'none' };

  // First observation: record the baseline and say nothing. Without this the
  // banner would fire once for every connected user on the first run after
  // this ships, about rates that are not new to them.
  if (input.ackRateDate === null) return { kind: 'baseline', baseline: current };
  if (current === input.ackRateDate) return { kind: 'none' };

  return {
    kind: 'changed',
    notice: {
      kind: 'rate-change',
      id: `rate:${current}`,
      effectiveDate: current,
      previousEffectiveDate: input.ackRateDate,
      headline: 'New OEB rates in effect — re-comparing your plans',
      detail: `Your readings are now priced from the set effective ${current} (was ${input.ackRateDate}). The three plan costs above were recomputed on it.`,
    },
  };
}

/**
 * Everything the user should be told about after a refresh, or right away on
 * a page that opened with changed data.
 *
 * `connected: false` short-circuits to nothing: a manual-DMD-only browser
 * must see zero change — no banner, no permission request, no background loop.
 */
export function buildRefreshNotices(input: RefreshNoticeInput): RefreshNoticeResult {
  if (!input.connected) return { notices: [], rateBaseline: null };

  const notices: RefreshNotice[] = [];
  const plan = detectPlanChange({
    totals: input.totals,
    currentPlan: input.currentPlan,
    ackPlan: input.ackPlan,
  });
  if (plan) notices.push(plan);

  const rate = detectRateChange({
    processedData: input.processedData,
    ackRateDate: input.ackRateDate,
  });
  let rateBaseline: string | null = null;
  if (rate.kind === 'baseline') rateBaseline = rate.baseline;
  else if (rate.kind === 'changed') notices.push(rate.notice);

  return { notices, rateBaseline };
}

/* -------------------------------------------------------------------------- *
 * Copy for the on-device notification (the optional half of the feature).
 * -------------------------------------------------------------------------- */

export type NotificationPayload = { title: string; body: string; tag: string };

/**
 * The notification text. Deliberately more conservative than the banner: an
 * alert that appears when the tab is closed cannot be dismissed in place and
 * cannot link anywhere useful, so it states the finding and points at the app
 * rather than trying to be the whole comparison.
 *
 * Honesty note (also printed in the settings drawer): with no account server
 * this is the ONLY push channel. No email, no SMS — Wave N is where a local
 * account server would be evaluated for those.
 */
export function notificationPayload(notice: RefreshNotice): NotificationPayload {
  if (notice.kind === 'plan-change') {
    return {
      title: `Best plan changed to ${PLAN_LABEL[notice.plan]}`,
      body:
        `Your readings now put ${PLAN_LABEL[notice.plan]} ~$${notice.monthlySavingVsPrevious.toFixed(2)}/mo ahead of ` +
        `${PLAN_LABEL[notice.previousBest]}. Open the dashboard to re-compare all three plans.`,
      tag: notice.id,
    };
  }
  return {
    title: 'New Ontario energy rates',
    body: `Rates effective ${notice.effectiveDate} are in your readings — the dashboard is re-comparing your plans.`,
    tag: notice.id,
  };
}
