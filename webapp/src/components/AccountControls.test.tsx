/**
 * Wave N — the account control surface, driven the way a person drives it.
 *
 * The server routes are covered exhaustively in `lib/account/account.test.ts`
 * and the crypto in `lib/account/crypto.test.ts`. What those cannot see is
 * the state machine in `hooks/useAccount.ts`, and that is where the two
 * failure modes this feature could actually ship live:
 *
 *  1. **Losing data.** Wiping a browser whose changes never reached the
 *     server, or silently overwriting one device with another. Both are
 *     asserted here as *outcomes on localStorage*, not as calls to a mock.
 *  2. **Becoming an outage.** A missing account server must leave the
 *     toolbar empty rather than a dead button — asserted by rendering with a
 *     server that answers 404 and 502 and expecting nothing at all.
 *
 * The transport is mocked (`@/lib/account/client`) so the tests decide what
 * the server says; everything between the click and localStorage is real.
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

import { AccountControls } from "@/components/AccountControls";
import { useAccount } from "@/hooks/useAccount";
import * as api from "@/lib/account/client";
import type { SessionInfo } from "@/lib/account/client";
import { bytesToBase64, encryptBlob, importSessionKey } from "@/lib/account/crypto";
import { ACCOUNT_KEY_ITEM, SYNC_REV_KEY } from "@/lib/account/sync";
import { buildBackupDocument, serializeBackup, EXAMPLE_DATA_KEY } from "@/lib/backup";
import { EMPTY_EXTRA_CHARGES } from "@/lib/energy";
import { PLAN_STORAGE_KEY } from "@/hooks/useSelectedPlan";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const ROWS = [
  { timestamp: 1704067200, usage_kwh: 1.5 },
  { timestamp: 1704070800, usage_kwh: 2.25 },
];
const OTHER_ROWS = [{ timestamp: 1704153600, usage_kwh: 9.75 }];

/** A raw 256-bit AES key — importable, never derived, so tests stay fast. */
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

function seedLocal(overrides: Record<string, string> = {}) {
  localStorage.clear();
  localStorage.setItem("energy_data", JSON.stringify(ROWS));
  localStorage.setItem("billing_day", "7");
  localStorage.setItem("extra_charges", JSON.stringify({ hstPct: "13" }));
  localStorage.setItem(PLAN_STORAGE_KEY, "ULO");
  localStorage.setItem(EXAMPLE_DATA_KEY, "1");
  for (const [k, v] of Object.entries(overrides)) {
    if (v === "") localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  }
}

/** Sign this device in as far as the hook is concerned: cookie + stored key. */
function seedSignedInDevice() {
  localStorage.setItem(ACCOUNT_KEY_ITEM, KEY_B64);
}

function documentFor(rows: typeof ROWS, billingDay = 7) {
  return buildBackupDocument({
    energyData: rows,
    billingDay,
    extraCharges: { ...EMPTY_EXTRA_CHARGES, hstPct: "13" },
    selectedPlan: "ULO",
    isExample: false,
    exportedAt: new Date("2026-10-07T12:00:00Z"),
  });
}

const fetchSession = vi.mocked(api.fetchSession);
const fetchPrefs = vi.mocked(api.fetchPrefs);
const getSync = vi.mocked(api.getSync);
const putSync = vi.mocked(api.putSync);
const logout = vi.mocked(api.logout);
const login = vi.mocked(api.login);

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
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
  putSync.mockResolvedValue({ rev: 1, updatedAt: "2026-10-07T12:00:00.000Z", recoveryCode: null });
  logout.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

/**
 * `Dashboard` owns the account state machine and passes it to BOTH surfaces
 * (the Alerts drawer needs the same instance), so the tests mount it the way
 * the app does: one `useAccount()`, handed down.
 */
function TestHarness({
  defaultOpen = false,
  openSignal = 0,
}: {
  defaultOpen?: boolean;
  openSignal?: number;
}) {
  const account = useAccount();
  return <AccountControls account={account} defaultOpen={defaultOpen} openSignal={openSignal} />;
}

/** Mount, then open the drawer (the toggle appears once the probe answers). */
async function openDrawer() {
  render(<TestHarness />);
  const toggle = await screen.findByTestId("account-toggle");
  fireEvent.click(toggle);
  return screen.getByTestId("account-drawer");
}

/* ------------------------------------------------------------------ *
 * The feature must be invisible when it does not exist
 * ------------------------------------------------------------------ */

describe("when this deployment has no account server", () => {
  it("renders nothing at all after a 404 (the app container)", async () => {
    fetchSession.mockRejectedValue(new api.AccountApiError(404, "not_found"));
    const { container } = render(<TestHarness />);
    await vi.waitFor(() => expect(fetchSession).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("account-toggle")).toBeNull();
  });

  it("renders nothing at all when the account container is down (502)", async () => {
    fetchSession.mockRejectedValue(new api.AccountApiError(502, "bad_gateway"));
    const { container } = render(<TestHarness />);
    await vi.waitFor(() => expect(fetchSession).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

/* ------------------------------------------------------------------ *
 * Sign-in surface
 * ------------------------------------------------------------------ */

describe("the sign-in drawer", () => {
  it("states the trust boundary in the words the design committed to", async () => {
    const drawer = await openDrawer();
    const text = drawer.textContent ?? "";
    expect(text).toMatch(/encrypted in this browser before they are uploaded/i);
    expect(text).toMatch(/blob it cannot open/i);
    expect(text).toMatch(/not what is in it, and not your password/i);
    // Three surfaces, no more: sign in, create account, recover. No upsell.
    expect(screen.getByTestId("account-auth-form")).toBeTruthy();
    expect(screen.queryByTestId("account-upgrade")).toBeNull();
  });

  it("keeps the password out of localStorage on a successful sign-in", async () => {
    seedLocal();
    const password = "correct horse battery staple";
    login.mockResolvedValue({
      ok: true,
      email: "mark@example.com",
      kdfSalt: SALT_B64,
      hasRecoveryCode: false,
      hasBlob: false,
      rev: 0,
      updatedAt: null,
    });
    // The probe answers "signed out", then the post-login refresh answers
    // "signed in" — exactly the two round trips a real sign-in makes.
    fetchSession
      .mockResolvedValueOnce(sessionInfo({ authed: false }))
      .mockResolvedValue(
        sessionInfo({ authed: true, email: "mark@example.com", kdfSalt: SALT_B64, rev: 0 }),
      );

    const drawer = await openDrawer();
    fireEvent.change(screen.getByTestId("account-email-input"), {
      target: { value: "mark@example.com" },
    });
    fireEvent.change(screen.getByTestId("account-password-input"), {
      target: { value: password },
    });
    fireEvent.click(screen.getByTestId("account-login"));

    await screen.findByTestId("account-migrate-prompt");

    const stored = Object.entries(localStorage);
    for (const [key, value] of stored) {
      expect(value).not.toContain(password);
      expect(key).not.toMatch(/session|token|password|cookie/i);
    }
    // What IS stored: the readings and the derived key — an
    // explicit allow-list, so a new secret sneaking into storage fails here.
    const allowed = new Set<string>([
      ACCOUNT_KEY_ITEM,
      PLAN_STORAGE_KEY,
      SYNC_REV_KEY,
      "account_upload_declined",
      "billing_day",
      "energy_data",
      "extra_charges",
      EXAMPLE_DATA_KEY,
    ]);
    for (const key of stored.map(([k]) => k)) expect(allowed.has(key)).toBe(true);
    expect(localStorage.getItem(ACCOUNT_KEY_ITEM)).toBeTruthy();
    expect(drawer.textContent).not.toContain(password);
  });
});

/* ------------------------------------------------------------------ *
 * First-login migration (PM ruling: "never silent")
 * ------------------------------------------------------------------ */

describe("a device with data and an empty account", () => {
  it("asks before uploading anything, and 'Not now' really means not now", async () => {
    seedLocal();
    seedSignedInDevice();
    fetchSession.mockResolvedValue(
      sessionInfo({ authed: true, email: "mark@example.com", kdfSalt: SALT_B64, rev: 0, hasBlob: false }),
    );
    await openDrawer();

    const prompt = await screen.findByTestId("account-migrate-prompt");
    expect(prompt.textContent).toMatch(/This browser has data and your new account has none/i);

    fireEvent.click(screen.getByTestId("account-upload-decline"));

    expect(screen.queryByTestId("account-migrate-prompt")).toBeNull();
    expect(localStorage.getItem("account_upload_declined")).toBe("1");
    expect(putSync).not.toHaveBeenCalled();
    // Nothing was removed, nothing was uploaded.
    expect(JSON.parse(localStorage.getItem("energy_data") ?? "[]")).toEqual(ROWS);
  });

  it("uploads ciphertext only — the readings never leave this browser readable", async () => {
    seedLocal();
    seedSignedInDevice();
    fetchSession.mockResolvedValue(
      sessionInfo({ authed: true, email: "mark@example.com", kdfSalt: SALT_B64, rev: 0, hasBlob: false }),
    );
    putSync.mockResolvedValue({
      rev: 1,
      updatedAt: "2026-10-07T12:00:00.000Z",
      recoveryCode: "AAAAA-BBBBB-CCCCC-DDDDD",
    });
    await openDrawer();

    await screen.findByTestId("account-migrate-prompt");
    fireEvent.click(screen.getByTestId("account-upload-accept"));

    await vi.waitFor(() => expect(putSync).toHaveBeenCalledTimes(1));
    const payload = putSync.mock.calls[0][0];
    expect(payload.baseRev).toBe(0);

    const plaintext = Buffer.from(payload.data, "base64").toString("utf8");
    expect(plaintext).not.toContain("energy_data");
    expect(plaintext).not.toContain("1704067200");
    expect(payload.data).not.toContain("1704067200");

    // The device records the revision it is in step with, and the one-time
    // recovery code is shown, because there is no e-mail reset.
    await vi.waitFor(() => expect(localStorage.getItem(SYNC_REV_KEY)).toBe("1"));
    const code = await screen.findByTestId("account-recovery-code-value");
    expect(code.textContent).toBe("AAAAA-BBBBB-CCCCC-DDDDD");
  });
});

/* ------------------------------------------------------------------ *
 * Conflicts: an explicit choice, never a silent overwrite
 * ------------------------------------------------------------------ */

describe("two devices have moved the same data", () => {
  async function renderConflict() {
    seedLocal();
    seedSignedInDevice();
    // Mocks first: the probe fires during render, so what the server "says"
    // has to be decided before the component is mounted.
    fetchSession.mockResolvedValue(
      sessionInfo({
        authed: true,
        email: "mark@example.com",
        kdfSalt: SALT_B64,
        rev: 3,
        hasBlob: true,
        updatedAt: "2026-10-07T11:00:00.000Z",
      }),
    );
    await openDrawer();
    return screen.findByTestId("account-conflict-prompt");
  }

  it("stops and asks instead of overwriting either side", async () => {
    const prompt = await renderConflict();
    expect(prompt.textContent).toMatch(/revision 3/);
    expect(putSync).not.toHaveBeenCalled();
    expect(getSync).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("energy_data") ?? "[]")).toEqual(ROWS);
  });

  it("'This device' wins by uploading against the server's revision", async () => {
    await renderConflict();
    putSync.mockResolvedValue({ rev: 4, updatedAt: "2026-10-07T12:00:00.000Z", recoveryCode: null });
    fireEvent.click(screen.getByTestId("account-conflict-keep-local"));

    await vi.waitFor(() => expect(putSync).toHaveBeenCalledTimes(1));
    expect(putSync.mock.calls[0][0].baseRev).toBe(3);
    await vi.waitFor(() => expect(localStorage.getItem(SYNC_REV_KEY)).toBe("4"));
    expect(screen.queryByTestId("account-conflict-prompt")).toBeNull();
    expect(JSON.parse(localStorage.getItem("energy_data") ?? "[]")).toEqual(ROWS);
  });

  it("'Account copy' replaces what is in this browser, after decrypting it", async () => {
    await renderConflict();
    const key = await importSessionKey(KEY_B64);
    const blob = await encryptBlob(key, serializeBackup(documentFor(OTHER_ROWS, 13)));

    getSync.mockResolvedValue({
      rev: 3,
      updatedAt: "2026-10-07T11:00:00.000Z",
      iv: blob.iv,
      data: blob.data,
      kdfSalt: SALT_B64,
      hasRecoveryCode: true,
    });

    fireEvent.click(screen.getByTestId("account-conflict-use-server"));

    await vi.waitFor(() => expect(getSync).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(JSON.parse(localStorage.getItem("energy_data") ?? "[]")).toEqual(OTHER_ROWS),
    );
    expect(localStorage.getItem("billing_day")).toBe("13");
    expect(localStorage.getItem(SYNC_REV_KEY)).toBe("3");
    expect(screen.queryByTestId("account-conflict-prompt")).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Logout — the one unacceptable failure mode is losing unsynced data
 * ------------------------------------------------------------------ */

describe("signing out", () => {
  async function renderInStep() {
    seedLocal();
    seedSignedInDevice();
    localStorage.setItem(SYNC_REV_KEY, "2");
    fetchSession.mockResolvedValue(
      sessionInfo({
        authed: true,
        email: "mark@example.com",
        kdfSalt: SALT_B64,
        rev: 2,
        hasBlob: true,
        updatedAt: "2026-10-07T11:00:00.000Z",
      }),
    );
    // The drawer only renders the sign-out button once we are signed in.
    return openDrawer();
  }

  it("wipes this browser and leaves the server copy alone when everything is synced", async () => {
    await renderInStep();
    expect(screen.getByTestId("account-signed-in")).toBeTruthy();

    fireEvent.click(screen.getByTestId("account-signout"));

    await vi.waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(putSync).not.toHaveBeenCalled(); // nothing dirty, so nothing re-uploaded
    expect(localStorage.getItem("energy_data")).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY_ITEM)).toBeNull();
    expect(localStorage.getItem(SYNC_REV_KEY)).toBeNull();
    const message = await screen.findByTestId("account-message");
    expect(message.textContent).toMatch(/server copy was kept/i);
  });

  it("refuses to wipe when the upload of unsynced changes fails", async () => {
    await renderInStep();
    // A change this device has never sent: the fingerprint no longer matches.
    localStorage.setItem("billing_day", "13");
    putSync.mockRejectedValue(new api.AccountApiError(0, "network", "connection refused"));

    fireEvent.click(screen.getByTestId("account-signout"));

    await vi.waitFor(() => expect(putSync).toHaveBeenCalledTimes(1));
    await screen.findByTestId("account-message");
    const message = screen.getByTestId("account-message").textContent ?? "";
    expect(message).toMatch(/left in the browser/i);

    // The data survived. This is the assertion the whole card rests on.
    expect(JSON.parse(localStorage.getItem("energy_data") ?? "[]")).toEqual(ROWS);
    expect(localStorage.getItem("billing_day")).toBe("13");
    expect(localStorage.getItem(ACCOUNT_KEY_ITEM)).toBe(KEY_B64);
  });

  it("reports an unreachable account server without touching a byte of local data", async () => {
    await renderInStep();
    logout.mockRejectedValue(new api.AccountApiError(0, "network", "connection refused"));

    fireEvent.click(screen.getByTestId("account-signout"));

    await vi.waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    const message = await screen.findByTestId("account-message");
    expect(message.textContent).toMatch(/still signed in on this device/i);
    expect(JSON.parse(localStorage.getItem("energy_data") ?? "[]")).toEqual(ROWS);
    expect(localStorage.getItem(ACCOUNT_KEY_ITEM)).toBe(KEY_B64);
  });
});

/* ------------------------------------------------------------------ *
 * "Back up now" — the explicit path a person can see working
 * ------------------------------------------------------------------ */

describe("the explicit backup button", () => {
  it("uploads without being asked and says so", async () => {
    seedLocal();
    seedSignedInDevice();
    localStorage.setItem(SYNC_REV_KEY, "2");
    fetchSession.mockResolvedValue(
      sessionInfo({
        authed: true,
        email: "mark@example.com",
        kdfSalt: SALT_B64,
        rev: 2,
        hasBlob: true,
      }),
    );
    putSync.mockResolvedValue({ rev: 3, updatedAt: "2026-10-07T12:00:00.000Z", recoveryCode: null });

    const drawer = await openDrawer();
    fireEvent.click(screen.getByTestId("account-sync-now"));

    await vi.waitFor(() => expect(putSync).toHaveBeenCalledTimes(1));
    expect(putSync.mock.calls[0][0].baseRev).toBe(2);
    const message = await screen.findByTestId("account-message");
    expect(message.textContent).toMatch(/backed up to your account/i);
    expect(localStorage.getItem(SYNC_REV_KEY)).toBe("3");
    expect(drawer.getAttribute("data-account-state")).toBe("signed_in");
  });

  it("says there is nothing to back up on an empty device instead of uploading noise", async () => {
    seedLocal({ energy_data: "", billing_day: "", extra_charges: "" });
    seedSignedInDevice();
    localStorage.setItem(SYNC_REV_KEY, "2");
    fetchSession.mockResolvedValue(
      sessionInfo({ authed: true, email: "mark@example.com", kdfSalt: SALT_B64, rev: 2, hasBlob: true }),
    );

    await openDrawer();
    fireEvent.click(screen.getByTestId("account-sync-now"));

    const message = await screen.findByTestId("account-message");
    expect(message.textContent).toMatch(/nothing to back up/i);
    expect(putSync).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * The push panel moved out — and the hand-off back in
 * ------------------------------------------------------------------ */

describe("after the push panel moved to the Alerts drawer", () => {
  it("keeps sign-in / backup / sync and shows no notification settings", async () => {
    seedLocal();
    seedSignedInDevice();
    fetchSession.mockResolvedValue(
      sessionInfo({ authed: true, email: "mark@example.com", kdfSalt: SALT_B64, rev: 2, hasBlob: true }),
    );
    const drawer = await openDrawer();

    expect(screen.getByTestId("account-signed-in")).toBeTruthy();
    expect(screen.getByTestId("account-sync-now")).toBeTruthy();
    expect(screen.getByTestId("account-signout")).toBeTruthy();
    // One entry point is the point: no second bell, no second vocabulary,
    // and no "alerts live in the bell" pointer line either.
    expect(screen.queryByTestId("account-notifications")).toBeNull();
    expect(screen.queryByTestId("account-notifications-toggle")).toBeNull();
    expect(drawer.textContent).not.toMatch(/notifications (on|off)/i);
    expect(drawer.textContent).not.toMatch(/alerts? live in/i);
  });

  it("opens when the Alerts drawer asks it to ('Sign in to use push')", async () => {
    const { rerender } = render(<TestHarness />);
    await screen.findByTestId("account-toggle");
    expect(screen.queryByTestId("account-drawer")).toBeNull();

    // Dashboard bumps the counter; the drawer stays uncontrolled.
    rerender(<TestHarness openSignal={1} />);
    expect(screen.getByTestId("account-drawer")).toBeTruthy();
  });
});
