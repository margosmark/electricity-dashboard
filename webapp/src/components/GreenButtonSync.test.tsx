/**
 * Green Button control surface (Wave K).
 *
 * These are the states the dashboard can be in when Oakville Hydro's
 * credentials do or don't exist yet — including the one that ships today,
 * where the feature must be invisible in the toolbar and explanatory in the
 * upload dialog rather than a dead button.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { GreenButtonSync } from "@/components/GreenButtonSync";
import type { GbStatus } from "@/lib/greenbutton/client";
import { setLocale } from "@/i18n";
import enJson from "@/i18n/en.json";
import frJson from "@/i18n/fr.json";

const en = enJson as Record<string, string>;
const fr = frJson as Record<string, string>;

const base: GbStatus = {
  configured: true,
  unconfiguredReason: null,
  connected: false,
  tokenPersistence: "file",
  tokenExpiresAt: null,
  lastSyncAt: null,
  lastSyncBytes: null,
  dataAvailableSince: null,
  redirectUri: "https://electricity.markarslan.ca/greenbutton/callback",
};

function props(over: Partial<Parameters<typeof GreenButtonSync>[0]> = {}) {
  return {
    status: base,
    syncing: false,
    message: null,
    onConnect: vi.fn(),
    onSync: vi.fn(),
    onDisconnect: vi.fn(),
    onDismissMessage: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLocale("en");
});

describe("GreenButtonSync", () => {
  it("renders nothing in the toolbar until the utility has issued credentials", () => {
    const p = props({ status: { ...base, configured: false } });
    const { container } = render(<GreenButtonSync {...p} variant="chip" />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("gb-connect")).toBeNull();
  });

  it("explains the not-configured state inside the upload dialog", () => {
    render(<GreenButtonSync {...props({ status: { ...base, configured: false } })} variant="modal" />);
    expect(screen.getByTestId("gb-unconfigured")).toBeTruthy();
    expect(screen.getByTestId("gb-waiting-headline").textContent).toMatch(/turned on yet/i);
    expect(screen.queryByTestId("gb-connect")).toBeNull();
  });

  it("offers Authorise when configured but not connected", () => {
    const p = props();
    render(<GreenButtonSync {...p} variant="modal" />);
    expect(screen.getByTestId("gb-connect").textContent).toBe("Authorise with Oakville Hydro");
    expect(screen.getByTestId("gb-connect-card").getAttribute("data-gb-state")).toBe("disconnected");
    fireEvent.click(screen.getByTestId("gb-connect"));
    expect(p.onConnect).toHaveBeenCalledTimes(1);
  });

  it("reports the three connection states the card specifies", () => {
    const { rerender } = render(<GreenButtonSync {...props()} variant="chip" />);
    expect(screen.getByTestId("gb-chip").getAttribute("data-gb-state")).toBe("disconnected");
    expect(screen.getByTestId("gb-connect").textContent).toBe("Authorise with Oakville Hydro");

    // Authorised: the shim holds a grant, nothing piped through yet.
    rerender(
      <GreenButtonSync {...props({ status: { ...base, connected: true } })} variant="chip" />,
    );
    expect(screen.getByTestId("gb-chip").getAttribute("data-gb-state")).toBe("authorised");
    expect(screen.getByTestId("gb-sync").textContent).toBe("Authorised");
    expect(screen.getByTestId("gb-sync").getAttribute("title")).toMatch(/Authorised/);

    // Data synced: a feed has actually been piped and ingested.
    rerender(
      <GreenButtonSync
        {...props({
          status: {
            ...base,
            connected: true,
            lastSyncAt: "2026-10-06T12:00:00.000Z",
            lastSyncBytes: 2048,
          },
        })}
        variant="chip"
      />,
    );
    expect(screen.getByTestId("gb-chip").getAttribute("data-gb-state")).toBe("synced");
    expect(screen.getByTestId("gb-sync").textContent).toBe("Live");
    expect(screen.getByTestId("gb-sync").getAttribute("title")).toMatch(/Synced/);
  });

  it("says authorised-but-never-synced rather than leaving it blank", () => {
    render(<GreenButtonSync {...props({ status: { ...base, connected: true } })} variant="modal" />);
    expect(screen.getByTestId("gb-status").textContent).toMatch(/Authorised/);
    expect(screen.getByTestId("gb-status").textContent).toMatch(/no data synced yet/i);
  });

  it("puts the connect button in the toolbar too", () => {
    const p = props();
    render(<GreenButtonSync {...p} variant="modal" />);
    fireEvent.click(screen.getByTestId("gb-connect"));
    expect(p.onConnect).toHaveBeenCalledTimes(1);
  });

  it("shows sync + disconnect once connected", () => {
    const p = props({
      status: {
        ...base,
        connected: true,
        lastSyncAt: "2026-10-06T12:00:00.000Z",
        lastSyncBytes: 2048,
      },
    });
    render(<GreenButtonSync {...p} variant="modal" />);
    expect(screen.getByTestId("gb-status").textContent).toMatch(/Synced/);
    expect(screen.getByTestId("gb-status").textContent).toMatch(/2 KB/);

    fireEvent.click(screen.getByTestId("gb-sync"));
    expect(p.onSync).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("gb-disconnect"));
    expect(window.confirm).toHaveBeenCalled();
    expect(p.onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("does not disconnect when the confirmation is declined", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const p = props({ status: { ...base, connected: true } });
    render(<GreenButtonSync {...p} variant="chip" />);
    fireEvent.click(screen.getByTestId("gb-disconnect"));
    expect(p.onDisconnect).not.toHaveBeenCalled();
  });

  it("surfaces a failure message with a dismiss affordance", () => {
    const p = props({
      message: { tone: "error", text: "Oakville Hydro disconnected us" },
    });
    render(<GreenButtonSync {...p} variant="modal" />);
    const msg = screen.getByTestId("gb-message");
    expect(msg.textContent).toContain("Oakville Hydro disconnected us");
    fireEvent.click(screen.getByText("dismiss"));
    expect(p.onDismissMessage).toHaveBeenCalledTimes(1);
  });

  it("disables sync while a pull is in flight", () => {
    const p = props({ syncing: true, status: { ...base, connected: true } });
    render(<GreenButtonSync {...p} variant="modal" />);
    expect((screen.getByTestId("gb-sync") as HTMLButtonElement).disabled).toBe(true);
  });
});

/* ========================================================================== *
 * Credential-waiting state + day-one connection journey (card t_10f231ed).
 *
 * Wave K shipped the state machine; this card owns the state the deployment
 * is actually in TODAY — the utility has not issued credentials, so the
 * journey cannot complete. What is asserted here is the promise the brief
 * makes: homeowner language (never the server's `unconfiguredReason`, which
 * names GB_CLIENT_ID/GB_CLIENT_SECRET), no dead or error-shaped control, a
 * three-step journey in the order a homeowner meets it, and the same card
 * reachable in French with the FR copy pointed at the FR button label.
 * ========================================================================== */

const WAITING_KEYS = [
  "gb.waiting.headline",
  "gb.waiting.pending",
  "gb.waiting.worksToday",
  "gb.journey.title",
] as const;

const JOURNEY_KEYS = [
  "gb.journey.need.label",
  "gb.journey.need.body",
  "gb.journey.do.label",
  "gb.journey.do.body",
  "gb.journey.after.label",
  "gb.journey.after.body",
] as const;

const waitingProps = () => props({ status: { ...base, configured: false } });

describe("GreenButtonSync credential-waiting state", () => {
  it("says what is pending in homeowner language, never configuration jargon", () => {
    render(<GreenButtonSync {...waitingProps()} variant="modal" />);
    const copy = screen.getByTestId("gb-unconfigured").textContent ?? "";
    expect(copy).toContain(en["gb.waiting.headline"]);
    expect(copy).toContain(en["gb.waiting.pending"]);
    // The technical reason is server-side (`unconfiguredReason` literally
    // names GB_CLIENT_ID / GB_CLIENT_SECRET) and must not reach this surface.
    expect(copy).not.toMatch(/credential|client_id|client_secret|oauth|\btoken\b|shim|GB_/i);
    // It names who has to act — the utility — and that the homeowner does not.
    expect(copy).toContain("Oakville Hydro");
    expect(copy).toMatch(/nothing you need to do/i);
  });

  it("keeps the wait from reading as a broken feature", () => {
    render(<GreenButtonSync {...waitingProps()} variant="modal" />);
    // no dead link, no error surface, no control that would fail on press
    expect(screen.queryByTestId("gb-connect")).toBeNull();
    expect(screen.queryByTestId("gb-sync")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // and it says out loud what still works today
    expect(screen.getByTestId("gb-waiting-works").textContent).toMatch(
      /works exactly as it always has/i,
    );
  });

  it("hides the toolbar chip entirely rather than parking an empty control there", () => {
    const { container } = render(<GreenButtonSync {...waitingProps()} variant="chip" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lays the day-one journey out as three ordered steps", () => {
    render(<GreenButtonSync {...waitingProps()} variant="modal" />);
    expect(screen.getByTestId("gb-journey").textContent).toContain(en["gb.journey.title"]);

    const steps = [1, 2, 3].map((n) => screen.getByTestId(`gb-journey-step-${n}`));
    const list = steps[0].closest("ol");
    expect(list, "the journey is an ordered list — the sequence is the point").not.toBeNull();
    expect(list!.tagName).toBe("OL");
    expect(Array.from(list!.children)).toEqual(steps);

    expect(steps[0].textContent).toContain(en["gb.journey.need.label"]);
    expect(steps[0].textContent).toContain(en["gb.journey.need.body"]);
    expect(steps[1].textContent).toContain(en["gb.journey.do.label"]);
    expect(steps[1].textContent).toContain(en["gb.journey.do.body"]);
    expect(steps[2].textContent).toContain(en["gb.journey.after.label"]);
    expect(steps[2].textContent).toContain(en["gb.journey.after.body"]);

    // The journey must point at the control the app really renders and the
    // behaviour the app really has — a step that names a button that does not
    // exist would be its own broken-feature reading.
    expect(en["gb.journey.do.body"]).toContain(en["gb.authorise"]);
    expect(en["gb.journey.after.body"]).toContain("browser");
  });

  it("reaches the same state in French, with French copy and the French button label", () => {
    setLocale("fr");
    render(<GreenButtonSync {...waitingProps()} variant="modal" />);
    const copy = screen.getByTestId("gb-unconfigured").textContent ?? "";

    for (const key of [...WAITING_KEYS, ...JOURNEY_KEYS]) {
      expect(copy, `fr value missing for ${key}`).toContain(fr[key]);
      expect(fr[key], `${key} is identical in both catalogs`).not.toBe(en[key]);
      expect(copy, `English leaked through ${key}`).not.toContain(en[key]);
    }
    // The French journey quotes the button the French UI actually shows.
    expect(fr["gb.journey.do.body"]).toContain(fr["gb.authorise"]);
    expect(screen.getByTestId("gb-waiting-headline").textContent).toBe(fr["gb.waiting.headline"]);
    expect(screen.queryByTestId("gb-connect")).toBeNull();
  });
});
