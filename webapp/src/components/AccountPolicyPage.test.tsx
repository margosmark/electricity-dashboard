import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AccountPolicyPage from "./AccountPolicyPage";
import { setLocale } from "@/i18n";

describe("public account policy pages", () => {
  afterEach(() => {
    cleanup();
    setLocale("en");
  });

  it("renders the complete English privacy disclosure without an account probe", () => {
    render(<AccountPolicyPage kind="privacy" />);
    expect(screen.getByTestId("privacy-policy")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: "Account Terms" })).toHaveAttribute("href", "/terms");
    expect(screen.getByText(/Usage backups are encrypted in your browser/i)).toBeTruthy();
    expect(screen.getByText(/The concrete retention policy is not yet available/i)).toBeTruthy();
  });

  it("keeps the terms acknowledgement and links in French", () => {
    setLocale("fr");
    render(<AccountPolicyPage kind="terms" />);
    expect(screen.getByTestId("account-terms")).toBeTruthy();
    expect(screen.getByText(/Avant qu'une inscription vérifiée puisse devenir un compte utilisable/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Confidentialité" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: "Conditions du compte" })).toHaveAttribute("href", "/terms");
  });
});
