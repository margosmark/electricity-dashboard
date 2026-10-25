/**
 * AccountPreflight — the rendered preflight, in both languages and in both
 * states.
 *
 * Four things are pinned here, each for a reason the card named:
 *   1. all three prerequisites are VISIBLE with a pass/pending state
 *      (never a silent failure),
 *   2. the fail-closed sentence is on the page while a gate is outstanding,
 *   3. the activation checklist is complete,
 *   4. nothing SMTP-shaped reaches the DOM — the component is handed
 *      booleans, and this asserts it stays that way.
 *
 * Run: cd webapp && npx vitest run src/components/AccountPreflight.test.tsx
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AccountPreflight from "./AccountPreflight";
import { setLocale, t } from "@/i18n";
import en from "@/i18n/en.json";
import fr from "@/i18n/fr.json";
import type { PreflightSnapshot } from "@/lib/account/preflight";

const ALL_PENDING: PreflightSnapshot = {
  checks: [
    { id: "smtp", state: "pending" },
    { id: "accountEnabled", state: "pending" },
    { id: "emailVerification", state: "pending" },
  ],
  ready: false,
};

const ALL_PASS: PreflightSnapshot = {
  checks: [
    { id: "smtp", state: "pass" },
    { id: "accountEnabled", state: "pass" },
    { id: "emailVerification", state: "pass" },
  ],
  ready: true,
};

function text(): string {
  return document.body.textContent ?? "";
}

afterEach(() => {
  cleanup();
  setLocale("en");
});

describe("AccountPreflight", () => {
  it("shows every prerequisite as pass/pending with its label and detail (en)", () => {
    render(<AccountPreflight snapshot={ALL_PENDING} />);

    for (const id of ["smtp", "accountEnabled", "emailVerification"] as const) {
      const row = screen.getByTestId(`preflight-check-${id}`);
      expect(row.getAttribute("data-state"), `${id} must state a status, not vanish`).toBe("pending");
      expect(screen.getByTestId(`preflight-state-${id}`).textContent?.trim()).toBe("pending");
    }
    expect(screen.getByText(/SMTP provisioning \(ACCT_SMTP_\*\)/)).toBeTruthy();
    expect(screen.getByText(/Account feature \(ACCT_ENABLED\)/)).toBeTruthy();
    expect(
      screen.getByText(/Email verification \(ACCT_EMAIL_VERIFICATION_ENABLED\)/),
    ).toBeTruthy();
    expect(
      document.querySelectorAll('[data-testid^="preflight-check-"][data-state]'),
    ).toHaveLength(3);
  });

  it("states the fail-closed reason plainly while a gate is outstanding (en)", () => {
    render(<AccountPreflight snapshot={ALL_PENDING} />);

    const verdict = screen.getByTestId("preflight-verdict");
    expect(verdict.getAttribute("role")).toBe("status");
    expect(verdict.getAttribute("data-ready")).toBe("false");
    expect(verdict.textContent).toMatch(/Account activation stays fail-closed until SMTP is live/);
    expect(verdict.textContent).toMatch(/Nothing is broken here/);
  });

  it("carries the full activation checklist", () => {
    render(<AccountPreflight snapshot={ALL_PENDING} />);

    const items = document.querySelectorAll('[data-testid^="preflight-item-"]');
    expect(items).toHaveLength(7);
    expect(screen.getByTestId("preflight-item-1").textContent).toMatch(
      /SMTP is provisioned end to end/,
    );
    expect(screen.getByTestId("preflight-item-7").textContent).toMatch(
      /Explicit, recorded authorization to activate/,
    );
    expect(screen.getByTestId("preflight-readonly").textContent).toMatch(
      /Read-only: this page reads configuration and changes no flag/,
    );
  });

  it("says activation still needs its own authorization when every gate is satisfied", () => {
    render(<AccountPreflight snapshot={ALL_PASS} />);

    const verdict = screen.getByTestId("preflight-verdict");
    expect(verdict.getAttribute("data-ready")).toBe("true");
    expect(verdict.textContent).toMatch(/Activation is still a separate, explicit decision/);

    for (const id of ["smtp", "accountEnabled", "emailVerification"] as const) {
      expect(screen.getByTestId(`preflight-check-${id}`).getAttribute("data-state")).toBe("pass");
      expect(screen.getByTestId(`preflight-state-${id}`).textContent?.trim()).toBe("pass");
    }
  });

  it("renders the whole page in French, with no English leaking into it", () => {
    setLocale("fr");
    render(<AccountPreflight snapshot={ALL_PENDING} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Préparation de l'activation du compte",
    );
    expect(screen.getByTestId("preflight-verdict").textContent).toMatch(
      /L'activation du compte reste bloquée tant que le courriel SMTP n'est pas en service/,
    );
    expect(screen.getByTestId("preflight-state-smtp").textContent?.trim()).toBe("en attente");
    expect(screen.getByTestId("preflight-item-2").textContent).toMatch(
      /Un message réel a été livré dans une vraie boîte de réception/,
    );
    expect(document.querySelectorAll('[data-testid^="preflight-item-"]')).toHaveLength(7);

    // The English verdict must not survive the locale flip, and no rendered
    // node may still be a raw catalog key.
    expect(text()).not.toContain("Account activation stays fail-closed");
    expect(text()).not.toMatch(/preflight\./);
  });

  it("never prints a raw catalog key in either language", () => {
    for (const locale of ["en", "fr"] as const) {
      setLocale(locale);
      const { container } = render(<AccountPreflight snapshot={ALL_PENDING} />);
      expect(container.textContent ?? "", `${locale} rendered an unresolved key`).not.toMatch(
        /preflight\./,
      );
      cleanup();
    }
  });

  it("never lets an SMTP detail, address or connection string reach the DOM", () => {
    for (const snapshot of [ALL_PENDING, ALL_PASS]) {
      const { container } = render(<AccountPreflight snapshot={snapshot} />);
      const dom = container.textContent ?? "";
      expect(dom).not.toMatch(/@/);
      expect(dom).not.toMatch(/:\/\//);
      expect(dom).not.toMatch(/smtp\.[a-z]/i);
      expect(dom).not.toMatch(/ACCT_SMTP_(HOST|PORT|FROM|REPLY_TO|HELO|USERNAME|PASSWORD)/);
      cleanup();
    }
  });

  it("has a French value for every preflight key, and none of them is the English string", () => {
    const enKeys = Object.keys(en).filter((k) => k.startsWith("preflight."));
    const frKeys = Object.keys(fr).filter((k) => k.startsWith("preflight."));

    expect(enKeys.length).toBeGreaterThan(20);
    expect(frKeys.sort()).toEqual(enKeys.sort());
    for (const key of enKeys) {
      expect(fr[key as keyof typeof fr], `${key} is untranslated`).toBeTruthy();
      expect(fr[key as keyof typeof fr], `${key} is still English`).not.toBe(
        en[key as keyof typeof en],
      );
      expect(t(key)).not.toBe(key);
    }
  });
});
