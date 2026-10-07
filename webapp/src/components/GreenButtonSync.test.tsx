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
  notificationUri: "https://electricity.markarslan.ca/greenbutton/notify/abc",
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
    expect(screen.getByText(/Not switched on yet/i)).toBeTruthy();
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
