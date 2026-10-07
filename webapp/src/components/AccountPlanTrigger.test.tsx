/**
 * Wave N — the last missing client trigger, asserted through the component.
 *
 * The server half of this trigger (`POST /account/notify` → `notify_log` →
 * `decide()`'s caps) is covered exhaustively in `lib/account/account.test.ts`.
 * What only exists at this level is the client contract, and it has exactly
 * three failure modes that would actually ship:
 *
 *  1. **Asking more than once.** `notices` is re-derived on every background
 *     refresh, so an id set that leaks would mean one push per chart render.
 *  2. **Asking when there is nobody to ask for.** A browser with no account
 *     system, or no session, must not fire a request at `/account/notify` at
 *     all — asserted as `notify` never being called, which is a stronger
 *     claim than "the server said 401".
 *  3. **Shouting about its own failure.** A probe or post that rejects must
 *     be silent AND leave the notice retryable: a server that was down for
 *     one derivation must not cost the user the message for good.
 *
 * The transport is mocked (`@/lib/account/client`), so these tests decide
 * what the server says; the derivation, the id set, the storage and the
 * gating are all real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

vi.mock("@/lib/account/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/account/client")>();
  return { ...actual, fetchSession: vi.fn(), notify: vi.fn() };
});

import { AccountPlanTrigger, ACCOUNT_PLAN_POSTED_KEY } from "./AccountPlanTrigger";
import * as api from "@/lib/account/client";
import type { SessionInfo } from "@/lib/account/client";
import { buildRefreshNotices, notificationPayload } from "@/lib/backgroundRefresh";
import {
  calculateFullDataTotals,
  processRawData,
  type DataPoint,
  type ProcessedPoint,
  type RateSet,
} from "@/lib/energy";
import type { PlanId } from "@/hooks/useSelectedPlan";

/* ------------------------------------------------------------------ *
 * Fixtures — a real derivation, not a hand-written notice: what gets
 * posted must be what `RefreshNoticeBanner` puts on screen.
 * ------------------------------------------------------------------ */

const RATES: RateSet = {
  effectiveDate: "2024-11-01",
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 600, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
};

const RAW: DataPoint[] = (() => {
  const rows: DataPoint[] = [];
  const start = new Date(2025, 5, 1);
  for (let d = 0; d < 30; d++) {
    for (let h = 0; h < 24; h++) {
      const at = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d, h);
      rows.push({ timestamp: Math.floor(at.getTime() / 1000), usage_kwh: 1.5 });
    }
  }
  return rows;
})();

const PROCESSED: ProcessedPoint[] = processRawData(RAW, [RATES]);
const TOTALS = calculateFullDataTotals(PROCESSED)!;
const BEST: PlanId = TOTALS.bestPlan;
const LOSER: PlanId = (["Tiered", "TOU", "ULO"] as const).find((p) => p !== BEST)!;

/** Exactly what `useRefreshNotices` hands over for a brand-new best plan. */
const planNotices = buildRefreshNotices({
  connected: true,
  totals: TOTALS,
  processedData: PROCESSED,
  currentPlan: LOSER,
  ackPlan: null,
  // First observation ⇒ a silent baseline, so this fixture is plan-only.
  ackRateDate: null,
}).notices;

/** The rate-only fixture: already on the winner, rates advanced since. */
const rateNotices = buildRefreshNotices({
  connected: true,
  totals: TOTALS,
  processedData: PROCESSED,
  currentPlan: BEST,
  ackPlan: BEST,
  ackRateDate: "2000-01-01",
}).notices;

function sessionInfo(over: Partial<SessionInfo> = {}): SessionInfo {
  return { enabled: true, authed: true, pushConfigured: false, vapidPublicKey: null, ...over };
}

const fetchSession = vi.mocked(api.fetchSession);
const notify = vi.mocked(api.notify);

/** Let every `.then` the effect started settle, without a state update. */
const flush = () => act(async () => {});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  fetchSession.mockResolvedValue(sessionInfo());
  notify.mockResolvedValue({ ok: true, sent: 1, suppressed: null });
});

afterEach(() => {
  cleanup();
});

/* ------------------------------------------------------------------ */

describe("AccountPlanTrigger", () => {
  it("derives exactly one plan-change notice in this fixture", () => {
    expect(planNotices).toHaveLength(1);
    expect(planNotices[0].kind).toBe("plan-change");
    expect(rateNotices.map((n) => n.kind)).toEqual(["rate-change"]);
  });

  it("renders nothing at all", () => {
    const { container } = render(<AccountPlanTrigger notices={planNotices} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("posts the notice to /account/notify as topic plan_change", async () => {
    render(<AccountPlanTrigger notices={planNotices} />);

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const payload = notificationPayload(planNotices[0]);
    expect(notify).toHaveBeenCalledWith({
      topic: "plan_change",
      title: payload.title,
      body: payload.body,
    });
    // The copy is the one the on-device alert shows — one sentence, no
    // readings, nothing the server could total into a number.
    expect(payload.title).toMatch(/Best plan changed/);
    expect(payload.body).not.toContain("kWh");

    // …and the account probe is what authorised it.
    expect(fetchSession).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(localStorage.getItem(ACCOUNT_PLAN_POSTED_KEY)).toBe(planNotices[0].id),
    );
  });

  it("posts exactly once per notice key, not once per render", async () => {
    const { rerender, unmount } = render(<AccountPlanTrigger notices={planNotices} />);
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));

    // Re-derivation is what happens on every background refresh: a new
    // array, a new notice object, the same id.
    for (let tick = 1; tick <= 3; tick++) {
      rerender(<AccountPlanTrigger notices={[{ ...planNotices[0] }]} />);
    }
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(fetchSession).toHaveBeenCalledTimes(1);

    // A page load after the banner was acknowledged-away-and-back must not
    // re-ask either: the marker is read from storage on mount.
    unmount();
    render(<AccountPlanTrigger notices={planNotices} />);
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(fetchSession).toHaveBeenCalledTimes(1);
  });

  it("never posts when the browser is signed out", async () => {
    fetchSession.mockResolvedValue(sessionInfo({ authed: false }));
    render(<AccountPlanTrigger notices={planNotices} />);

    await waitFor(() => expect(fetchSession).toHaveBeenCalled());
    await flush();
    expect(notify).not.toHaveBeenCalled();
    // Not marked either: signing in later still gets the message.
    expect(localStorage.getItem(ACCOUNT_PLAN_POSTED_KEY)).toBeNull();
  });

  it("never posts when the account feature is off", async () => {
    fetchSession.mockResolvedValue(sessionInfo({ enabled: false, authed: false }));
    render(<AccountPlanTrigger notices={planNotices} />);

    await waitFor(() => expect(fetchSession).toHaveBeenCalled());
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(localStorage.getItem(ACCOUNT_PLAN_POSTED_KEY)).toBeNull();
  });

  it("never probes at all when there is no notice (a manual-DMD-only browser)", async () => {
    render(<AccountPlanTrigger notices={[]} />);
    await flush();
    expect(fetchSession).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("stays silent when the server cannot be reached, and retries later", async () => {
    fetchSession.mockRejectedValue(new Error("ECONNREFUSED"));
    const { rerender } = render(<AccountPlanTrigger notices={planNotices} />);
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(localStorage.getItem(ACCOUNT_PLAN_POSTED_KEY)).toBeNull();

    // The account server comes back: the SAME notice is still retryable,
    // because a failed attempt never burned the id.
    fetchSession.mockResolvedValue(sessionInfo());
    rerender(<AccountPlanTrigger notices={[{ ...planNotices[0] }]} />);
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
  });

  it("stays silent when the post itself fails, and retries later", async () => {
    notify.mockRejectedValue(new Error("503"));
    const { rerender } = render(<AccountPlanTrigger notices={planNotices} />);
    await flush();
    expect(localStorage.getItem(ACCOUNT_PLAN_POSTED_KEY)).toBeNull();

    notify.mockResolvedValue({ ok: true, sent: 1, suppressed: null });
    rerender(<AccountPlanTrigger notices={[{ ...planNotices[0] }]} />);
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(localStorage.getItem(ACCOUNT_PLAN_POSTED_KEY)).toBe(planNotices[0].id),
    );
  });

  it("never posts a rate notice — the server owns the oeb_rates topic", async () => {
    render(<AccountPlanTrigger notices={rateNotices} />);
    await flush();
    expect(fetchSession).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(localStorage.getItem(ACCOUNT_PLAN_POSTED_KEY)).toBeNull();
  });

  it("posts the plan change only when both notices are on screen", async () => {
    render(<AccountPlanTrigger notices={[...planNotices, ...rateNotices]} />);
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0].topic).toBe("plan_change");
  });
});
