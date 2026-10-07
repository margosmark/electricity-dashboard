/**
 * Wave M — the notice state machine: "what changed, and have we said it yet?"
 *
 * Three persisted facts, all in localStorage, none of them component state:
 *
 *   `wave_m_ack_plan`  the best plan the user has been told about
 *   `wave_m_ack_rate`  the rate effectiveDate the last observation saw
 *   `wave_m_notified`  the last notice raised as an OS notification
 *
 * `revision` is the only piece of React state here, and it is a bare "the
 * user dismissed something, re-derive" counter. That split is the point of
 * the design: **the notice list is a pure derivation** (`useMemo` over the
 * dataset + the acknowledgements). A background refresh that brings back
 * "nothing new" can still be the refresh that crossed into a new rate period,
 * and a page that opens after data landed elsewhere must show the banner too
 * — both fall out of "recompute from state" instead of needing a "something
 * changed" event that would be easy to forget to emit. The effect below
 * consequently has NO setState in it: its two jobs are exactly the ones
 * effects exist for — writing to an external system, and firing one alert.
 *
 * ONE EVENT, AT MOST ONE SYSTEM NOTIFICATION: the effect below also skips
 * `showNotification` for a notice whose topic a live push subscription
 * already covers (`pushTopics`), because push is the channel governed by the
 * daily cap and quiet hours — firing both would double-pop AND bypass those
 * rules. The banner always renders; it is not a system notification.
 *
 * GATE: `connected` (the `gb_session` cookie) short-circuits everything. A
 * manual-DMD-only browser gets an empty array and no storage writes at all —
 * scope 4 of the card, enforced inside `buildRefreshNotices` so the rule
 * lives in one place.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FullDataTotals, ProcessedPoint } from '@/lib/energy';
import type { PlanId } from '@/hooks/useSelectedPlan';
import {
  NOTIFIED_KEY,
  PLAN_ACK_KEY,
  RATE_ACK_KEY,
  buildRefreshNotices,
  notificationPayload,
  type RefreshNotice,
} from '@/lib/backgroundRefresh';
import { showNotification } from '@/lib/notifications';
import { topicHasProducer } from '@/lib/account/topics';

const NO_PUSH_TOPICS: string[] = [];

/**
 * Which push topic each notice kind would raise.
 *
 * The dedup guard below asks "would push already tell the user about this?"
 * — and a topic with no producer cannot, so `plan_change` (Wave M's
 * detector, which posts nothing) keeps its on-device alert until its
 * producer lands. Remove nothing here by hand: `topicHasProducer` is the
 * same table the drawer renders its disabled checkbox rows from.
 */
const NOTICE_TOPIC: Record<RefreshNotice['kind'], string> = {
  'plan-change': 'plan_change',
  'rate-change': 'oeb_rates',
};

/**
 * Is this notice already covered by a live push subscription?
 *
 * One event must reach the user at most ONCE as a system notification: push
 * is the channel governed by the daily cap and quiet hours, so letting the
 * on-device alert fire alongside it would double-pop AND bypass those rules.
 * The banner always renders either way — it is not a system notification.
 *
 * Stated consequence, not hidden: if the server suppresses the push (cap or
 * quiet hours) the user gets the banner and no system notification. That is
 * what the cap and the quiet hours asked for.
 */
export function pushCoversNotice(kind: RefreshNotice['kind'], pushTopics: string[]): boolean {
  const topic = NOTICE_TOPIC[kind];
  return topicHasProducer(topic) && pushTopics.includes(topic);
}

function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode: the notice works for this session, it just forgets */
  }
}

export type RefreshNoticeState = {
  /** Plan-change first when both fired — it is the actionable one. */
  notices: RefreshNotice[];
  /** Forget one: persists the acknowledgement so it does not come back. */
  dismiss: (id: string) => void;
};

export function useRefreshNotices(input: {
  connected: boolean;
  totals: FullDataTotals | null;
  processedData: ProcessedPoint[];
  currentPlan: PlanId;
  /** Incremented by useEnergyData after every background refresh. */
  refreshTick: number;
  /**
   * Topics a live, subscribed push would already deliver (empty when push is
   * off). Read from the shared account state, so turning push on mid-session
   * is picked up without a reload.
   */
  pushTopics?: string[];
}): RefreshNoticeState {
  const { connected, totals, processedData, currentPlan, refreshTick } = input;
  const pushTopics = input.pushTopics ?? NO_PUSH_TOPICS;

  // Bumped only from an event handler (a dismissal), never from an effect.
  const [revision, setRevision] = useState(0);

  const derived = useMemo(
    () =>
      buildRefreshNotices({
        connected,
        totals,
        processedData,
        currentPlan,
        // Read, never cached in state: the acknowledgement is EXTERNAL state,
        // and re-reading it here is what makes a dismissal take effect on the
        // next derivation rather than on the next full page load.
        ackPlan: readKey(PLAN_ACK_KEY),
        ackRateDate: readKey(RATE_ACK_KEY),
      }),
    // `refreshTick` and `revision` are deliberately NOT read inside: they are
    // the two things that must force a re-derivation so it re-reads the
    // acknowledgements from storage (a refresh just landed, or the user just
    // dismissed a banner).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connected, totals, processedData, currentPlan, refreshTick, revision],
  );

  // Ids already raised as OS notifications, seeded from disk so reopening the
  // app does not re-notify about a banner that is still on screen.
  const notifiedRef = useRef<Set<string> | null>(null);
  if (notifiedRef.current === null) {
    const seed = readKey(NOTIFIED_KEY);
    notifiedRef.current = new Set(seed ? [seed] : []);
  }

  useEffect(() => {
    // First observation of a rate date: persist it as the baseline. There is
    // nothing to render for it — the derivation already returned no rate
    // notice in this branch — so this needs no state and no cascading render.
    if (derived.rateBaseline !== null) writeKey(RATE_ACK_KEY, derived.rateBaseline);

    // Optional on-device alert. Guarded three ways: the id set (once per
    // notice, across reloads), the user's drawer toggle, and the browser
    // permission — and NEVER a requestPermission(), which only a click
    // handler may trigger (settings drawer, or the account panel's Web Push).
    for (const notice of derived.notices) {
      const notified = notifiedRef.current;
      if (!notified || notified.has(notice.id)) continue;
      // Mark it EITHER way: push already told the user (or is about to), so
      // turning push off again must not retro-notify an event they have
      // already been told about.
      notified.add(notice.id);
      writeKey(NOTIFIED_KEY, notice.id);
      if (pushCoversNotice(notice.kind, pushTopics)) continue;
      showNotification(notificationPayload(notice));
    }
  }, [derived, pushTopics]);

  const dismiss = useCallback(
    (id: string) => {
      const target = derived.notices.find((n) => n.id === id);
      if (!target) return;
      if (target.kind === 'plan-change') writeKey(PLAN_ACK_KEY, target.plan);
      else writeKey(RATE_ACK_KEY, target.effectiveDate);
      setRevision((r) => r + 1);
    },
    [derived],
  );

  return { notices: derived.notices, dismiss };
}
