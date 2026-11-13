"use client";

/**
 * Client-side rate staleness check — runs ONCE PER SESSION, fetches the OEB
 * page through the stateless `/oeb-rates-page` same-origin route handler
 * (formerly a next.config rewrite; OEB has no CORS/JSON/RSS — see
 * src/app/oeb-rates-page/route.ts), parses it with the shared pure parser,
 * and compares effectiveDate against the shipped /api/rates set.
 *
 * The session guard stores the RESULT (stale payload or clean marker), so the
 * banner stays persistent across reloads within the same tab session without
 * refetching. Any failure degrades to "no banner" — this check never blocks
 * render; the weekly gateway cron is the authoritative staleness signal.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ProcessedPoint, RateSet } from '@/lib/energy';
import {
  OEB_RATES_PROXY_PATH,
  parseOebRatesPage,
  maxShippedEffectiveDate,
  isOebDateNewer,
  summarizeRateChange,
  calculateRateChangeImpact,
  type RatePeriodDelta,
  type RateChangeImpact,
} from '@/lib/oebRates';

const SESSION_KEY = 'oeb_staleness_check';

export type StaleInfo = {
  oebEffectiveDate: string;
  shippedEffectiveDate: string;
  newSet: RateSet | null;
  deltas: RatePeriodDelta[];
};

type SessionState = {
  /** The stale payload, or null when the OEB page was not newer / check failed. */
  stale: StaleInfo | null;
  /** True once a session check settled (success, clean, or failure). */
  done: boolean;
};

export type StalenessResult = {
  /** null while idle/failed — callers render no banner. */
  stale: (StaleInfo & { impact: RateChangeImpact | null }) | null;
  /** True once the session check has completed. */
  checked: boolean;
};

/** Returns prior session state, or null when absent/corrupt/private-mode. */
function readSession(): SessionState | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { stale?: StaleInfo | null };
    if (!parsed || typeof parsed !== 'object') return null;
    return { stale: parsed.stale ?? null, done: true };
  } catch {
    return null;
  }
}

function writeSession(stale: StaleInfo | null): void {
  try {
    // `{"stale":null}` is the clean marker — distinguishable from "absent".
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ stale }));
  } catch {
    /* private mode: check still runs, just not memoized */
  }
}

export function useRateStaleness(
  rateHistory: RateSet[],
  processedData: ProcessedPoint[],
): StalenessResult {
  // Lazy init: a prior check in this tab session replays immediately on mount
  // (persistent banner, no refetch) without any setState-in-effect.
  const [session, setSession] = useState<SessionState>(
    () => readSession() ?? { stale: null, done: false },
  );

  const shippedMax = useMemo(() => maxShippedEffectiveDate(rateHistory), [rateHistory]);

  useEffect(() => {
    if (session.done) return; // already checked this session
    if (rateHistory.length === 0) return; // wait for /api/rates to arrive

    let cancelled = false;
    (async () => {
      let found: StaleInfo | null = null;
      try {
        const res = await fetch(OEB_RATES_PROXY_PATH);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const parsed = parseOebRatesPage(html);
        if (parsed.effectiveDate && isOebDateNewer(parsed.effectiveDate, shippedMax)) {
          const shippedSet =
            rateHistory.find((r) => r.effectiveDate === shippedMax) ?? rateHistory[0];
          found = {
            oebEffectiveDate: parsed.effectiveDate,
            shippedEffectiveDate: shippedMax ?? 'unknown',
            newSet: parsed.rates,
            deltas:
              parsed.rates && shippedSet ? summarizeRateChange(shippedSet, parsed.rates) : [],
          };
        }
      } catch {
        // Network/parse failure: treat as clean-for-this-session (stay
        // silent). The weekly cron remains the authoritative signal.
      }
      writeSession(found);
      if (!cancelled) setSession({ stale: found, done: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [session.done, rateHistory, shippedMax]);

  // Impact needs the loaded data; recompute when it changes (cheap, pure).
  const impact = useMemo(
    () => (session.stale?.newSet ? calculateRateChangeImpact(processedData, session.stale.newSet) : null),
    [session.stale, processedData],
  );

  const merged = useMemo(
    () => (session.stale ? { ...session.stale, impact } : null),
    [session.stale, impact],
  );

  return { stale: merged, checked: session.done };
}
