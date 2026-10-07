/**
 * The merged Alerts drawer — one surface, three channels.
 *
 * What is worth pinning here is the honesty contract, not the markup:
 *
 *  - the ORDERED push state table (feature off ⇒ no section, signed out ⇒
 *    Sign in, no VAPID ⇒ inert, browser blocked ⇒ inert, subscribed ⇒ off +
 *    disclosure, otherwise ⇒ on) — the first true row is the only one that
 *    renders, because every row after it would be a claim we cannot back;
 *  - the copy Wave M shipped that was FALSE (a page-context `Notification`
 *    cannot reach a closed tab, and "there is no account" is untrue the
 *    moment someone signs in);
 *  - the moved push controls, which keep their behaviour and take `alerts-*`
 *    testids;
 *  - `plan_change`, a topic with no producer yet: disabled, checked, and
 *    honest about why.
 *
 * The transport is mocked (`@/lib/account/client`) so the tests decide what
 * the server says; everything between the click and the store is real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@/lib/account/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/account/client")>();
  return {
    ...actual,
    fetchSession: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    getSync: vi.fn(),
    putSync: vi.fn(),
    fetchPrefs: vi.fn(),
    putPrefs: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    notify: vi.fn(),
    recover: vi.fn(),
  };
});

import { NotificationToggle } from "@/components/NotificationToggle";
import { AccountControls } from "@/components/AccountControls";
import { useAccount, type AccountApi } from "@/hooks/useAccount";
import * as api from "@/lib/account/client";
import type { SessionInfo } from "@/lib/account/client";
import { bytesToBase64 } from "@/lib/account/crypto";
import { ACCOUNT_KEY_ITEM } from "@/lib/account/sync";
import { NOTIFICATIONS_ENABLED_KEY } from "@/lib/backgroundRefresh";

const KEY_B64 = bytesToBase64(new Uint8Array(32).fill(7));
const SALT_B64 = bytesToBase64(new Uint8Array(16).fill(3));

const PREFS = {
  topics: ["plan_change", "oeb_rates", "data_available", "anomaly"],
  dailyCap: 3,
  quietStart: 22 * 60,
  quietEnd: 7 * 60,
  tzOffset: -240,
};

function sessionInfo(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    enabled: true,
    authed: false,
    pushConfigured: false,
    vapidPublicKey: null,
    prefs: PREFS,
    ...over,
  };
}

/** A controllable Notification API: permission is the state under test. */
class FakeNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => "granted");
  constructor(public title: string) {}
}

const fetchSession = vi.mocked(api.fetchSession);
const fetchPrefs = vi.mocked(api.fetchPrefs);
const putPrefs = vi.mocked(api.putPrefs);
const getSync = vi.mocked(api.getSync);
const logout = vi.mocked(api.logout);

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  FakeNotification.permission = "default";
  FakeNotification.requestPermission.mockClear();
  vi.stubGlobal("Notification", FakeNotification);
  fetchSession.mockResolvedValue(sessionInfo());
  fetchPrefs.mockResolvedValue({
    prefs: PREFS,
    subscriptionCount: 0,
    pushConfigured: false,
    vapidPublicKey: null,
  });
  getSync.mockResolvedValue({
    rev: 0,
    updatedAt: null,
    iv: null,
    data: null,
    kdfSalt: SALT_B64,
    hasRecoveryCode: false,
  });
  logout.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // `unsupported` is forced by making the origin insecure; put it back.
  Reflect.deleteProperty(window, "isSecureContext");
});

/** Feed the drawer an established, signed-in browser. */
function seedSignedIn() {
  localStorage.setItem(ACCOUNT_KEY_ITEM, KEY_B64);
  fetchSession.mockResolvedValue(
    sessionInfo({ authed: true, email: "mark@example.com", kdfSalt: SALT_B64, rev: 2, hasBlob: true }),
  );
}

/* ------------------------------------------------------------------ *
 * Mount the way `Dashboard` does: ONE `useAccount()`, handed down.
 * ------------------------------------------------------------------ */

function Harness({
  connected = true,
  backgroundSync = "registered",
  onSignIn,
}: {
  connected?: boolean;
  backgroundSync?: "registered" | "unsupported" | "denied" | "unconfigured" | "unknown";
  onSignIn?: () => void;
} = {}) {
  const account: AccountApi = useAccount();
  return (
    <NotificationToggle
      connected={connected}
      backgroundSync={backgroundSync}
      account={account}
      onSignIn={onSignIn}
    />
  );
}

/** Mount, then open the drawer (waiting for the feature probe either way). */
async function openDrawer(props: Parameters<typeof Harness>[0] = {}) {
  render(<Harness {...props} />);
  const toggle = await screen.findByTestId("notification-toggle");
  fireEvent.click(toggle);
  return screen.getByTestId("notification-drawer");
}

/* ------------------------------------------------------------------ *
 * The bell gate: `gbConnected || accountFeatureEnabled`
 * ------------------------------------------------------------------ */

describe("the bell gate", () => {
  it("renders nothing at all for a manual-upload browser on a feature-off deployment", async () => {
    fetchSession.mockRejectedValue(new api.AccountApiError(404, "not_found"));
    const { container } = render(<Harness connected={false} />);
    await vi.waitFor(() => expect(fetchSession).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("notification-toggle")).toBeNull();
  });

  it("appears for a manual-upload browser when the account feature exists", async () => {
    render(<Harness connected={false} />);
    // A manual-upload browser can already have a live anomaly push channel,
    // so hiding the bell would leave it reachable only in the account drawer.
    expect(await screen.findByTestId("notification-toggle")).toBeTruthy();
  });

  it("appears for an authorised browser even where the feature is off", async () => {
    fetchSession.mockRejectedValue(new api.AccountApiError(404, "not_found"));
    render(<Harness connected={true} />);
    expect(await screen.findByTestId("notification-toggle")).toBeTruthy();
    // …and it draws no account chrome alongside it.
    expect(screen.queryByTestId("alerts-push")).toBeNull();
  });

  it("asks for the feature exactly once, however many surfaces read it", async () => {
    render(<Harness connected={false} />);
    await screen.findByTestId("notification-toggle");
    await vi.waitFor(() => expect(fetchSession).toHaveBeenCalledTimes(1));
  });

  it("shares that one probe with the account drawer (two consumers, one GET)", async () => {
    // The shape `Dashboard` renders: one `useAccount()`, two surfaces reading
    // the flag off it. Two probes would mean two `GET /account/session` on
    // every page load — and a second `useAccount()` would be far worse than
    // that (two key derivations, two auto-push intervals).
    function Both() {
      const account: AccountApi = useAccount();
      return (
        <>
          <NotificationToggle
            connected={false}
            backgroundSync="registered"
            account={account}
            onSignIn={() => {}}
          />
          <AccountControls account={account} />
        </>
      );
    }
    render(<Both />);

    expect(await screen.findByTestId("notification-toggle")).toBeTruthy();
    expect(await screen.findByTestId("account-toggle")).toBeTruthy();
    expect(fetchSession).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ *
 * Naming + shape: one umbrella, three channels
 * ------------------------------------------------------------------ */

describe("the Alerts drawer", () => {
  it("is called Alerts everywhere — never 'alert settings'", async () => {
    await openDrawer();
    const toggle = screen.getByTestId("notification-toggle");
    expect(toggle.getAttribute("title")).toBe("Alerts");
    expect(toggle.getAttribute("aria-label")).toBe("Alerts");

    const drawer = screen.getByTestId("notification-drawer");
    expect(drawer.getAttribute("aria-label")).toBe("Alerts");
    expect(drawer.textContent).not.toMatch(/alert settings/i);
    // The two live copy bugs this card exists to fix.
    expect(drawer.textContent).not.toMatch(/closed-tab/i);
    expect(drawer.textContent).not.toMatch(/There is no account/i);
  });

  it("answers 'how will I hear about it?' once, in three ordered sections", async () => {
    const drawer = await openDrawer();
    const text = drawer.textContent ?? "";

    expect(text).toMatch(
      /One event, three places to see it\. Turning one on never turns another off\./,
    );

    const headings = [
      "In the dashboard",
      "While the app is open \u2014 on-device alerts",
      "When the app is closed \u2014 push",
    ].map((h) => text.search(new RegExp(h)));
    for (const at of headings) expect(at).toBeGreaterThan(0);
    expect([...headings].sort((a, b) => a - b)).toEqual(headings);
  });

  it("prints the banner channel as a state line, with no switch", async () => {
    const drawer = await openDrawer();
    const banner = screen.getByTestId("alerts-banner");
    expect(banner.textContent).toMatch(/plan and rate changes show a banner until you dismiss it/i);
    // The banner is not a setting: there is nothing to toggle in this drawer.
    expect(banner.querySelector("input, button")).toBeNull();
    expect(drawer.textContent).toMatch(/No email or SMS \u2014 this app never sends either\.|never sends email or SMS/i);
  });
});

/* ------------------------------------------------------------------ *
 * Channel 1 — the on-device state table (spec §4)
 * ------------------------------------------------------------------ */

describe("the on-device channel", () => {
  it("off: says what turning it on actually buys you", async () => {
    await openDrawer();
    expect(screen.getByTestId("notification-availability").textContent).toBe(
      "Off \u2014 turn on to get a system notification while this app is open.",
    );
    expect(screen.getByTestId("notification-switch").textContent).toBe(
      "Turn on on-device alerts",
    );
  });

  it("on: a system notification while the app is open — never a closed tab", async () => {
    FakeNotification.permission = "granted";
    localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, "1");
    await openDrawer();

    expect(screen.getByTestId("notification-availability").textContent).toBe(
      "On \u2014 a system notification appears while this app is open.",
    );
    expect(screen.getByTestId("notification-switch").textContent).toBe(
      "Turn off on-device alerts",
    );
  });

  it("turning it on from the click says so, and prompts nowhere else", async () => {
    await openDrawer();
    fireEvent.click(screen.getByTestId("notification-switch"));

    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("notification-status")).toHaveTextContent(
      "On \u2014 a system notification appears while the app is open.",
    );
    expect(screen.getByTestId("notification-switch").textContent).toBe(
      "Turn off on-device alerts",
    );
  });

  it("turning it off keeps saying the browser permission stays granted", async () => {
    FakeNotification.permission = "granted";
    localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, "1");
    await openDrawer();
    fireEvent.click(screen.getByTestId("notification-switch"));

    expect(await screen.findByTestId("notification-status")).toHaveTextContent(
      "Turned off. The browser permission stays granted \u2014 this app just goes quiet.",
    );
    expect(screen.getByTestId("notification-switch").textContent).toBe(
      "Turn on on-device alerts",
    );
  });

  it("blocked: inert, and points at the channel that still works", async () => {
    FakeNotification.permission = "denied";
    await openDrawer();

    expect(screen.getByTestId("notification-availability").textContent).toBe(
      "Blocked in browser settings \u2014 the dashboard banner still works.",
    );
    const control = screen.getByTestId("notification-switch");
    expect(control).toBeDisabled();
    expect(control.textContent).toBe("On-device alerts unavailable");
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("unsupported: says the browser has no notification API", async () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    await openDrawer();

    expect(screen.getByTestId("notification-availability").textContent).toBe(
      "Not available \u2014 this browser exposes no notification API here.",
    );
    expect(screen.getByTestId("notification-switch")).toBeDisabled();
  });

  it("no live sync yet: says so before any state line", async () => {
    await openDrawer({ connected: false });
    const text = screen.getByTestId("notification-drawer").textContent ?? "";
    expect(text).toMatch(
      /No live sync yet, so there is nothing to raise until you authorise Oakville Hydro\./,
    );
    // …and the switch is still usable: it is the browser's permission, not
    // the sync source, that decides this channel.
    expect(screen.getByTestId("notification-switch")).not.toBeDisabled();
    // The banner channel says why there is nothing to show yet.
    expect(screen.getByTestId("alerts-banner").textContent).toMatch(
      /nothing to show yet \u2014 live sync with Oakville Hydro/,
    );
  });

  it("keeps the background-sync precondition next to the channel it gates", async () => {
    await openDrawer({ backgroundSync: "unconfigured" });
    const sync = screen.getByTestId("notification-background-sync");
    expect(sync).toHaveAttribute("data-state", "unconfigured");
    expect(sync.textContent).toMatch(/No background loop/);
  });
});

/* ------------------------------------------------------------------ *
 * Channel 2 — the push state table: first true row, only that row
 * ------------------------------------------------------------------ */

describe("the push state table", () => {
  it("row 1 — no section at all when this deployment has no account feature", async () => {
    fetchSession.mockRejectedValue(new api.AccountApiError(404, "not_found"));
    render(<Harness connected={true} />);
    await vi.waitFor(() => expect(fetchSession).toHaveBeenCalled());
    fireEvent.click(await screen.findByTestId("notification-toggle"));
    expect(screen.queryByTestId("alerts-push")).toBeNull();
    expect(screen.queryByTestId("alerts-push-enable")).toBeNull();
  });

  it("row 2 — signed out: name it, and route to the account drawer", async () => {
    const onSignIn = vi.fn();
    await openDrawer({ onSignIn });

    await vi.waitFor(() =>
      expect(screen.getByTestId("alerts-push")).toHaveAttribute("data-push-state", "signin"),
    );
    expect((await screen.findByTestId("alerts-push")).textContent).toMatch(
      /Push needs an account on this server\./,
    );
    const button = screen.getByTestId("alerts-push-signin");
    expect(button.textContent).toBe("Sign in to use push");
    fireEvent.click(button);
    expect(onSignIn).toHaveBeenCalledTimes(1);
    // No new modal to carry the hand-off: the account drawer is the only
    // other surface in the toolbar.
    expect(screen.queryByTestId("account-drawer")).toBeNull();
  });

  it("row 3 — no VAPID keys: inert, never a button that cannot work", async () => {
    seedSignedIn();
    await openDrawer();

    await vi.waitFor(() =>
      expect(screen.getByTestId("alerts-push")).toHaveAttribute("data-push-state", "no-vapid"),
    );
    expect((await screen.findByTestId("alerts-push")).textContent).toMatch(
      /This server has no VAPID keys yet, so push cannot be delivered\./,
    );
    expect(screen.getByTestId("alerts-push-enable")).toBeDisabled();
  });

  it("row 4 — the browser blocked notifications: only the browser can undo it", async () => {
    seedSignedIn();
    fetchSession.mockResolvedValue(
      sessionInfo({
        authed: true,
        email: "mark@example.com",
        kdfSalt: SALT_B64,
        rev: 2,
        hasBlob: true,
        pushConfigured: true,
        vapidPublicKey: "test-public-key",
      }),
    );
    FakeNotification.permission = "denied";
    await openDrawer();

    await vi.waitFor(() =>
      expect(screen.getByTestId("alerts-push")).toHaveAttribute("data-push-state", "blocked"),
    );
    expect((await screen.findByTestId("alerts-push")).textContent).toMatch(
      /The browser blocked notifications for this site \u2014 allow them for this site in your browser settings\./,
    );
    expect(screen.getByTestId("alerts-push-enable")).toBeDisabled();
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("row 5 — subscribed: off switch plus the topics / cap / quiet disclosure", async () => {
    seedSignedIn();
    fetchSession.mockResolvedValue(
      sessionInfo({
        authed: true,
        email: "mark@example.com",
        kdfSalt: SALT_B64,
        rev: 2,
        hasBlob: true,
        pushConfigured: true,
        vapidPublicKey: "test-public-key",
      }),
    );
    fetchPrefs.mockResolvedValue({
      prefs: PREFS,
      subscriptionCount: 1,
      pushConfigured: true,
      vapidPublicKey: "test-public-key",
    });
    await openDrawer();

    await vi.waitFor(() =>
      expect(screen.getByTestId("alerts-push")).toHaveAttribute("data-push-state", "subscribed"),
    );
    expect(screen.getByTestId("alerts-push-toggle")).toHaveTextContent("Push on");
    expect(screen.getByTestId("alerts-push-disable")).toHaveTextContent("Turn off push");
    // The disclosure holds the preferences — nothing is hidden behind the
    // account drawer any more.
    fireEvent.click(screen.getByTestId("alerts-push-toggle"));
    expect(screen.getByTestId("alerts-topic-oeb_rates")).toBeTruthy();
    expect(screen.getByTestId("alerts-daily-cap")).toBeTruthy();
    expect(screen.getByTestId("alerts-quiet-hours")).toBeTruthy();
  });

  it("row 6 — supported and not subscribed: 'Turn on push', enabled", async () => {
    seedSignedIn();
    fetchSession.mockResolvedValue(
      sessionInfo({
        authed: true,
        email: "mark@example.com",
        kdfSalt: SALT_B64,
        rev: 2,
        hasBlob: true,
        pushConfigured: true,
        vapidPublicKey: "test-public-key",
      }),
    );
    await openDrawer();

    await vi.waitFor(() =>
      expect(screen.getByTestId("alerts-push")).toHaveAttribute("data-push-state", "ready"),
    );
    const button = screen.getByTestId("alerts-push-enable");
    expect(button).not.toBeDisabled();
    expect(button.textContent).toBe("Turn on push");
  });
});

/* ------------------------------------------------------------------ *
 * The push preferences, moved from the account drawer (behaviour intact)
 * ------------------------------------------------------------------ */

describe("push preferences", () => {
  it("corrects a stored UTC offset that does not match this device", async () => {
    localStorage.setItem(ACCOUNT_KEY_ITEM, KEY_B64);
    const deviceOffset = -new Date().getTimezoneOffset();
    fetchSession.mockResolvedValue(
      sessionInfo({ authed: true, email: "mark@example.com", kdfSalt: SALT_B64, rev: 2, hasBlob: true }),
    );
    // Quiet hours mean the READER's night: the client is the only party that
    // can supply the timezone, and it does so without being asked.
    const drifted = { ...PREFS, tzOffset: deviceOffset + 60 };
    fetchPrefs.mockResolvedValue({
      prefs: drifted,
      subscriptionCount: 0,
      pushConfigured: false,
      vapidPublicKey: null,
    });
    putPrefs.mockResolvedValue({ ok: true, prefs: drifted });

    await openDrawer();

    await vi.waitFor(() => expect(putPrefs).toHaveBeenCalledTimes(1));
    expect(putPrefs.mock.calls[0][0].tzOffset).toBe(deviceOffset);
  });

  it("stamps this device's offset on every save, so a fix cannot drift away", async () => {
    localStorage.setItem(ACCOUNT_KEY_ITEM, KEY_B64);
    const saved = { ...PREFS, tzOffset: -new Date().getTimezoneOffset() };
    fetchSession.mockResolvedValue(
      sessionInfo({
        authed: true,
        email: "mark@example.com",
        kdfSalt: SALT_B64,
        rev: 2,
        hasBlob: true,
        pushConfigured: true,
        vapidPublicKey: "test-public-key",
      }),
    );
    fetchPrefs.mockResolvedValue({
      prefs: saved,
      subscriptionCount: 1,
      pushConfigured: true,
      vapidPublicKey: "test-public-key",
    });
    putPrefs.mockResolvedValue({ ok: true, prefs: saved });

    await openDrawer();
    await vi.waitFor(() =>
      expect(screen.getByTestId("alerts-push")).toHaveAttribute("data-push-state", "subscribed"),
    );
    fireEvent.click(screen.getByTestId("alerts-push-toggle"));
    fireEvent.click(screen.getByTestId("alerts-topic-oeb_rates"));

    await vi.waitFor(() => expect(putPrefs).toHaveBeenCalledTimes(1));
    const payload = putPrefs.mock.calls[0][0];
    expect(payload.tzOffset).toBe(-new Date().getTimezoneOffset());
    expect(payload.topics).not.toContain("oeb_rates");
  });

  it("pins plan_change on and off: no producer exists yet, and it says so", async () => {
    localStorage.setItem(ACCOUNT_KEY_ITEM, KEY_B64);
    const saved = { ...PREFS, tzOffset: -new Date().getTimezoneOffset() };
    fetchSession.mockResolvedValue(
      sessionInfo({
        authed: true,
        email: "mark@example.com",
        kdfSalt: SALT_B64,
        rev: 2,
        hasBlob: true,
        pushConfigured: true,
        vapidPublicKey: "test-public-key",
      }),
    );
    fetchPrefs.mockResolvedValue({
      // Deliberately WITHOUT it: the row must still show as on, and must not
      // be able to write a preference the user cannot act on.
      prefs: { ...saved, topics: ["oeb_rates"] },
      subscriptionCount: 1,
      pushConfigured: true,
      vapidPublicKey: "test-public-key",
    });

    await openDrawer();
    await vi.waitFor(() =>
      expect(screen.getByTestId("alerts-push")).toHaveAttribute("data-push-state", "subscribed"),
    );
    fireEvent.click(screen.getByTestId("alerts-push-toggle"));

    const plan = screen.getByTestId("alerts-topic-plan_change") as HTMLInputElement;
    expect(plan).toBeDisabled();
    expect(plan).toBeChecked();
    expect(plan.parentElement?.textContent).toMatch(/at most once a day \u00b7 not connected yet/);

    // The other rows still work: they DO have emitters today.
    const rates = screen.getByTestId("alerts-topic-oeb_rates") as HTMLInputElement;
    expect(rates).not.toBeDisabled();
    expect(rates.parentElement?.textContent).toMatch(/at most once a week$/);
  });
});

/* ------------------------------------------------------------------ *
 * The bottom honesty line — first match wins (spec §4)
 * ------------------------------------------------------------------ */

describe("the honesty line", () => {
  const line = () => screen.getByText(/never sends email or SMS/i).textContent ?? "";

  it("signed out: names the reason instead of pretending there is no account", async () => {
    await openDrawer();
    expect(line()).toMatch(/no account is signed in, so there is no push/i);
    expect(line()).toMatch(/This app never sends email or SMS\./);
  });

  it("signed in with push off", async () => {
    seedSignedIn();
    await openDrawer();
    await vi.waitFor(() => expect(screen.getByTestId("alerts-push")).toBeTruthy());
    expect(line()).toMatch(/Push is off, so nothing reaches you when the app is closed/i);
  });

  it("signed in with push on: says what still stops it", async () => {
    seedSignedIn();
    fetchSession.mockResolvedValue(
      sessionInfo({
        authed: true,
        email: "mark@example.com",
        kdfSalt: SALT_B64,
        rev: 2,
        hasBlob: true,
        pushConfigured: true,
        vapidPublicKey: "test-public-key",
      }),
    );
    fetchPrefs.mockResolvedValue({
      prefs: PREFS,
      subscriptionCount: 1,
      pushConfigured: true,
      vapidPublicKey: "test-public-key",
    });
    await openDrawer();

    await vi.waitFor(() =>
      expect(screen.getByTestId("alerts-push")).toHaveAttribute("data-push-state", "subscribed"),
    );
    expect(line()).toMatch(
      /Push is on \u2014 it works when the app is closed and stops at your daily cap and quiet hours/i,
    );
  });
});
