# Test fixtures — real-world Green Button documents

Parser fixtures for `webapp/src/lib/utilitySamples.test.ts` and the Wave L
bill parser. The root
`.gitignore` ignores `*.xml` globally (**user meter exports must never enter
this repo**) with an explicit exception for this directory — everything here
is either a *publicly published* sample or generated in-repo; none of it is
the app owner's own data.

| File | What it is | Provenance |
|---|---|---|
| `utility-hydro-one.xml` | **Genuine Hydro One "Download My Data" export.** Atom feed with DEFAULT namespaces (no `espi:` prefix), 4 MeterReading/IntervalBlock entries, hourly readings, Ontario TOU tier tags, `powerOfTenMultiplier -3`. | Published by its owner in `github.com/ryanmaule/greenbutton-to-homeassistant-sql` (`import/hourly-weekday.xml`); meter/UsagePoint id `J2648788` matches that author's Hydro One export set. |
| `utility-toronto-hydro.xml` | **Genuine Toronto Hydro Download My Data export** from Toronto Hydro's Itron EE PowerLens portal. 96 readings at 15-minute (900 s) interval inside an IntervalBlock with an 86 400 s block interval; `ReadingType uom 72` (Wh). No `espi:` prefix (`espi.xsd` appears only via `xsi:schemaLocation`). | Pasted verbatim by a customer in `github.com/vqvu/home-assistant-green-button/issues/77` (extracted from a single XML code fence; CRLF→LF only). The UsagePoint entry title was redacted by the poster as `***REMOVEH***`. |
| `utility-espi-prefixed-standin.xml` | **Representative stand-in — NOT Alectra data.** A real Green Button Connect feed ("External Energy Usage Green Button Feed") that uses explicit `espi:` namespace prefixes throughout (`espi:IntervalReading` ×514), giving the parser prefix-variant coverage the two Ontario files above do not provide. | `github.com/jgkramer/hummingbird` (`usage_data/lindahl.xml`). **No genuine Alectra export is publicly reachable** — Alectra's DMD lives behind a customer login at `alectrautilitiesgbportal.savagedata.com`. Do not treat this file as Alectra ground truth. |
| `utility-alectra-fragment.xml` | **The only genuine Alectra content found publicly**: a single `<IntervalReading>` element exported by an Alectra customer (Savage Data CMD feed) showing Alectra's real child ordering — `cost`, `ReadingQuality/quality`, `timePeriod`, `value 2290000`, `tou 2`. It is a fragment, not an Atom feed, so it documents Alectra structure rather than feed layout. | `github.com/rocketraman/open-green-button-homeassistant/issues/4`. |
| `utility-enbridge-gas.xml` | **Enbridge Gas (Ontario) Green Button feed with an itemized bill**: one `UsageSummary`, 37 `costAdditionalDetailLastPeriod` lines (`Amount Due` → `Transportation to Enbridge (LVB)`), `espi:` prefixes, `ServiceCategory kind 1`, API paths on `api.enbridgegas.com`. The only committed document besides the two synthetic bills that states a PROVIDER's line names, so it is what `billNote.test.tsx`'s coverage ratchet and `PROVIDER_BILL_NOTE_KEYS` read. **No name, address or account field appears in the file**; treat it as a published sample rather than an attested customer export. | Published as `fetch_data/enbridge_sample.xml` in `github.com/huntertran/homeassistant-canada-greenbutton` (MIT), added 2026-07-29 alongside that repo's Enbridge fetcher/parser as "sample XML data … for testing and validation purposes". |
| `green-button-alliance-sample.xml` | Canonical **Green Button Alliance** published sample ("Test GB Data Hourly Nine Days Binned Daily", 216 IntervalReadings) including the `xml-stylesheet` PI, banner comment, and `ElectricPowerUsageSummary`. | `s3-us-west-2.amazonaws.com/technical.greenbuttonalliance.org/library/sample-data/TestGBDataHourlyNineDaysBinnedDaily.xml` (linked from the GBA samples index). |
| `synthetic.xml` | Small synthetic feed generated for the e2e smoke test (no real meter readings). | Created in-repo by earlier waves. |
| `usage-summary-open-tail.xml` | **Hand-generated fixture — not any utility's export.** The Wave L synthetic bills (same audited figures, copied verbatim) PLUS hourly meter readings that run a month PAST the last bill — the mid-period shape of a real export, and the one thing no other committed fixture had: the accrual curve could only ever draw its empty state in the browser check. Readings are raw Wh with no `ReadingType` multiplier (the parser's `raw / 1000` fallback, same as `example-usage.xml`), generated from a fixed hourly load shape so the file is byte-stable. Regenerate: `node webapp/scripts/generate-open-tail-fixture.mjs`. | Created in-repo for slice 7 (`webapp/src/components/OpenPeriod.test.tsx`, `evidence/bill-pace-verify.cjs`). |
| `usage-summary-synthetic.xml` | **Hand-generated fixture — not any utility's export.** Three 29-day `UsageSummary` bills (2026-05-25 / 06-23 / 07-22) plus a `LocalTimeParameters` entry, built so the per-period lines are self-consistent (total = commodity + delivery + regulatory; HST 13%; rebate −23.5%) and their sums are exactly the figures the 2026-10-07 data audit published: **$1,365.03 total · $311.61 delivery · $177.46 HST · −$320.78 rebate · $45.15 regulatory · $530.74 / $218.71 / $258.82 off/mid/on**. Delivery is laid out as $35.88 fixed + $0.0252/kWh so the amortized split the "actual bill" panel shows is really fitted. | Created in-repo for Wave L (`webapp/src/lib/usageSummary.test.ts`, `webapp/src/components/WaveL.test.tsx`). The app owner's own Oakville Hydro export is used only for the deployed browser check and is **never committed** (last rule below). |

## What these fixtures caught

Two real scaling bugs, both fixed and pinned by `utilitySamples.test.ts`:

- **Hydro One ignores the multiplier? It used to.** ESPI puts the scale on a
  *separate* `ReadingType` entry linked by href; `powerOfTenMultiplier -3` means
  the raw value is in Wh. Reading `value / 1000` alone turned a 3.95 kWh hour
  into 3 954 kWh. The parser now resolves the multiplier through the
  ReadingType link, falls back to an inline ReadingType, then to a single
  document-wide ReadingType value.
- **The inverse trap: summary scalers.** The app owner's own Oakville Hydro
  export stamps `powerOfTenMultiplier -6` on `<measurement>` elements inside
  `ElectricPowerUsageSummary`. Applying *that* to interval readings turns
  3.5 kWh into 0.0000035 kWh. Only scalers found under a `ReadingType` count.

## When you add a fixture

- Keep it out of git unless it is genuinely public: the root `.gitignore`
  rule is the privacy guard, do not weaken it.
- If a fixture is generated, commit the generator beside it and say so in
  the table above — a fixture nobody can rebuild is a fixture nobody can
  trust after the first edit.
- Record provenance above, and say plainly when a file is a stand-in rather
  than the real utility's export.
- Never put your own Oakville Hydro export here.
