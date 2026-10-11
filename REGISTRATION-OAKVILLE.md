# Oakville Hydro registration — Mark's step-by-step

**TL;DR** — This is the one part of Green Button that only you can do by hand:
Oakville Hydro's own self-serve form for the **legally sanctioned *Connect My
Data* (OAuth2) channel**. The utility publishes and operates this form
precisely so machine-to-machine data sharing is allowed — what we are doing is
using the sanctioned API, not scraping their portal. What we get out of it is
the credential pair (`client_id` / `client_secret`) that makes the dashboard
auto-refresh your readings instead of you re-exporting the XML by hand.
**It is a binding legal agreement: your legal name, a "power to enter binding
agreements" answer and a Terms & Conditions tick — the agent will not accept
these on your behalf.** Everything you have to type is below, copy-paste
ready; ~10 minutes on a phone or a laptop.

https://www.oakvillehydro.com/green-button-third-party-registration-form

Field labels, limits and required/optional markers below were read from the
**live Drupal form on 2026-10-06** and are quoted exactly as printed.

---

## Before you start (2 minutes)

1. **Have the logo file on the device you are filling the form from.** The
   *Application Logo or Icon File* field is a **file upload only** — there is
   no URL field — so the PNG has to exist locally: `webapp/public/icons/icon-512.png`
   (repo path). On a phone: send yourself that file first.
2. **Read the agreement** (5 min, it is short) — you are about to sign it:
   <https://oakvillehydro.com/sites/oakvillehydro/files/2024-08/Green%20Button%20sharing%20Third%20Party%20agreement%20-%20Oakville%20Hydro.pdf>
3. **Sanity-check the notification URI** you are about to paste is the one the
   deployment actually uses (it is pinned — do not regenerate it):

   ```bash
   curl -s https://electricity.markarslan.ca/greenbutton/status | jq -r .notificationUri
   # → https://electricity.markarslan.ca/greenbutton/notify/96a1eb36f68816b9606848aa7c628a71
   ```

---

## Field-by-field (form order, exact labels)

`*` = the live form marks it required.

| # | Form field (exact label) | Type / limit | Enter or select |
| --- | --- | --- | --- |
| 1 | Legal Company Name * | text, 255 | `Mark Arslan` — your own full legal name, **not a company**: the open-green-button precedent registers an *individual*. Use the name your Oakville Hydro account is under (see the name note in the checklist). |
| 2 | Third Party Application Name * | text, 255 | `Ontario Energy Optimizer` |
| 3 | Description/Purpose of Application: * | textarea, no published cap | **Block A** below |
| 4 | Third Party Application Contact Information: | *section heading only — no input renders* | — |
| 5 | First Name * | text, 255 | `Mark` |
| 6 | Last Name * | text, 255 | your surname (as on your Oakville Hydro account) |
| 7 | Email * | email, 254 | `me@markarslan.ca` — Oakville's Green Button support team replies here |
| 8 | Phone Number | tel, 128 — **not required** (no asterisk) | your mobile; recommended in case technical review needs a human |
| 9 | Third Party Application Description * — *"This will appear in the Green Button site for customers to review prior to authorization"*, *Max 255 characters* | textarea, **maxlength 255** | **Block B** below (179 chars) — this one is **public** |
| 10 | Application Logo or Icon File * | **file upload** — *One file only. 150 MB limit. Allowed types: gif jpg png pdf.* | `icon-512.png` from `webapp/public/icons/` — see "Before you start" |
| 11 | Third Party Green Button® Login URL(s) | *label only — no input renders (verified 2026-10-06); it is the heading for rows 13–15* | nothing to type |
| 12 | Type of application: * | radio: Mobile App † / Web App | **Web App** — choosing it makes the iOS/Android URL rows appear-or-hide correctly |
| 13 | iOS Application Login URL (if applicable): | url, 255 — only visible/required when *Mobile App* is chosen | leave alone (hidden for Web App) |
| 14 | Android Application Login URL (if applicable): | url, 255 — same condition | leave alone (hidden for Web App) |
| 15 | Application/Portal Login Page URL: | url, 255 — visible + required when *Web App* is chosen | `https://electricity.markarslan.ca/` |
| 16 | Third Party Green Button® oAuth2 redirect URL * | text, 255 | `https://electricity.markarslan.ca/greenbutton/callback` |
| 17 | Notification URI | url, 255 — *the form does not require it, but we do: without it Oakville has no "data changed" webhook* | `https://electricity.markarslan.ca/greenbutton/notify/96a1eb36f68816b9606848aa7c628a71` |
| 18 | Third Party Data Sharing Scope requirement (… select ALL that apply) * | checkboxes: Billing Information / Usage Information / Account Information | tick **Usage Information only** — nothing else (agreement §1: use the data only for the customer's services) |
| 19 | *Do you have the power to enter your company into a legally binding agreement with Oakville Hydro?* * | radio Yes / No | **Yes** |
| 20 | *Please read the Terms & Conditions and hit the checkbox to accept in order to proceed with the registration* * | checkbox (links the agreement PDF) | tick **after** reading it |
| 21 | CAPTCHA * | reCAPTCHA image challenge ("I'm not a robot") | solve it |
| 22 | Submit | button | — |

### The three URLs in one block

```
https://electricity.markarslan.ca/
https://electricity.markarslan.ca/greenbutton/callback
https://electricity.markarslan.ca/greenbutton/notify/96a1eb36f68816b9606848aa7c628a71
```

### Block A — Description/Purpose of Application (row 3, 249 chars)

```text
Personal energy-usage analysis for the customer's own household: it imports Green Button interval data into a local dashboard that runs in the customer's own browser. No data leaves the customer's machine; nothing is stored on any server we operate.
```

### Block B — Third Party Application Description (row 9, 179 of 255 chars)

```text
A privacy-first Ontario energy dashboard. Interval usage is read once through Connect My Data and analysed entirely in your own browser — readings are never stored on our servers.
```

---

## Walkthrough

1. Open the form URL at the top.
2. Rows 1–2: name fields.
3. Row 3: paste **Block A**.
4. Rows 5–8: contact details.
5. Row 9: paste **Block B** (watch the *Max 255 characters* counter — Block B
   is 179).
6. Row 10: choose `icon-512.png`. The widget uploads as soon as you pick the
   file (the *Upload* button is hidden when JS is on); if an **Upload** button
   *is* visible, click it and wait for the filename to appear before moving on.
   The field is required — submitting with no file attached fails validation.
7. Row 12: select **Web App**. iOS/Android URL fields stay hidden; the
   *Application/Portal Login Page URL* field appears.
8. Rows 15–17: paste the three URLs (block above). Exact characters — a typo
   in the redirect URI only surfaces later, as a failed OAuth callback.
9. Row 18: tick **Usage Information** only.
10. Row 19: **Yes**. Row 20: tick Terms. Row 21: CAPTCHA. Row 22: **Submit**.

---

## Pre-submission checklist

- [ ] **Logo attached** — filename visible under *Application Logo or Icon
      File* (file-upload-only field; local path `webapp/public/icons/icon-512.png`).
- [ ] **Notification URI pasted verbatim**, including the fixed token
      `96a1eb36f68816b9606848aa7c628a71`. It is pinned in `docker-compose.yml`
      as `GB_NOTIFY_TOKEN` and **must not be regenerated** — the form records it
      before Oakville issues the client secret, so it cannot be derived from a
      secret that does not exist yet. Cross-check against `/greenbutton/status`
      (command above).
- [ ] **Redirect URI verbatim** = `https://electricity.markarslan.ca/greenbutton/callback`.
- [ ] **Scope = Usage Information only** (Billing and Account unticked).
- [ ] **Web App** selected (otherwise the iOS/Android login URLs become
      required fields).
- [ ] **Block B ≤ 255 chars** and both descriptions pasted from this doc.
- [ ] **Name note:** rows 1/5/6 use *your* legal name — this doc's surname is
      inferred from your own domain (`markarslan.ca`), and I cannot verify it
      against your Oakville Hydro account. Use whatever name your account is
      registered under.
- [ ] **You read the agreement PDF** — your name + the T&C tick is a binding
      signature; it also puts your description (row 9) in Oakville's public
      Green Button marketplace and your email in front their support team.
- [ ] CAPTCHA solved.

---

## After you hit Submit

**Oakville's own process** (stated on the form page): technical review of what
you submitted including a *3rd Party Application URL Test* → they ask you to
confirm a final task on our side → they schedule a demo where you show a
successful **authorization and revocation** → they review and promote the app
to Green Button production.

**Then, the hand-off:**

1. You get their confirmation email with `client_id` / `client_secret` →
   **forward it to soft-dev**, or put it yourself in `docker-compose.yml` on
   .110 as `GB_CLIENT_ID` / `GB_CLIENT_SECRET` (an `.env` next to it works too —
   compose reads it automatically), then:

   ```bash
   docker compose up -d        # env-only change — NO rebuild
   ```

2. **Connectivity Testing must be completed within 90 days of acceptance**
   (agreement §6) or the registration is terminated. That is soft-dev's job
   the moment the credentials exist: connect a real Oakville account, confirm
   readings land in `localStorage`, revoke in Oakville's UI, confirm the shim
   reports `grant_revoked` and wipes its token file
   (`webapp/scripts/e2e-greenbutton-loop.sh` is the smoke test).
3. If Oakville asks for a **sandbox first**, only `GB_AUTHORIZE_URL` /
   `GB_TOKEN_URL` change.
4. Scope at authorize time is `GB_SCOPE=FB=1_3_4_5`; if the platform rejects a
   scope that narrow, the known-good fallback string is in
   [GREENBUTTON-CMD.md](GREENBUTTON-CMD.md) §6 (env-only change too).

---

## What you are agreeing to

- **Use the data only to provide the customer's services**, under Ontario
  privacy law — no sharing, no other purpose (agreement §1). Here that is
  literal: readings are parsed in the browser and stored in that browser;
  the server keeps only the OAuth token set.
- **Serve the redirect and notification endpoints over TLS with unexpired,
  unrevoked RSA ≥2048-bit certificates** (agreement §2(c)(d)), and make no
  representations on Oakville Hydro's behalf (§2(a)).
- **Complete Connectivity Testing within 90 days or be terminated** (§6), and
  **notify Oakville immediately of any security incident** (§3).

Full agreement (read before ticking):
<https://oakvillehydro.com/sites/oakvillehydro/files/2024-08/Green%20Button%20sharing%20Third%20Party%20agreement%20-%20Oakville%20Hydro.pdf>

---

## Full technical detail

Field-by-field payload, hosting decision, security model and the OAuth flow
itself live in [GREENBUTTON-CMD.md](GREENBUTTON-CMD.md) **§6** (and §4–§5).
This doc is the form-filling view of the same values; nothing here changes the
deployment.
