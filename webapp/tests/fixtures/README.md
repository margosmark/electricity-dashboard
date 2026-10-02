# Test fixtures — real-world Green Button documents

Parser fixtures for `webapp/src/lib/utilitySamples.test.ts`. The root
`.gitignore` ignores `*.xml` globally (**user meter exports must never enter
this repo**) with an explicit exception for this directory — everything here
is a *publicly published* sample, not the app owner's own data.

| File | What it is | Provenance |
|---|---|---|
| `utility-hydro-one.xml` | **Genuine Hydro One "Download My Data" export.** Atom feed with DEFAULT namespaces (no `espi:` prefix), 4 MeterReading/IntervalBlock entries, hourly readings, Ontario TOU tier tags, `powerOfTenMultiplier -3`. | Published by its owner in `github.com/ryanmaule/greenbutton-to-homeassistant-sql` (`import/hourly-weekday.xml`); meter/UsagePoint id `J2648788` matches that author's Hydro One export set. |
| `utility-toronto-hydro.xml` | **Genuine Toronto Hydro Download My Data export** from Toronto Hydro's Itron EE PowerLens portal. 96 readings at 15-minute (900 s) interval inside an IntervalBlock with an 86 400 s block interval; `ReadingType uom 72` (Wh). No `espi:` prefix (`espi.xsd` appears only via `xsi:schemaLocation`). | Pasted verbatim by a customer in `github.com/vqvu/home-assistant-green-button/issues/77` (extracted from a single XML code fence; CRLF→LF only). The UsagePoint entry title was redacted by the poster as `***REMOVEH***`. |
| `utility-espi-prefixed-standin.xml` | **Representative stand-in — NOT Alectra data.** A real Green Button Connect feed ("External Energy Usage Green Button Feed") that uses explicit `espi:` namespace prefixes throughout (`espi:IntervalReading` ×514), giving the parser prefix-variant coverage the two Ontario files above do not provide. | `github.com/jgkramer/hummingbird` (`usage_data/lindahl.xml`). **No genuine Alectra export is publicly reachable** — Alectra's DMD lives behind a customer login at `alectrautilitiesgbportal.savagedata.com`. Do not treat this file as Alectra ground truth. |
| `utility-alectra-fragment.xml` | **The only genuine Alectra content found publicly**: a single `<IntervalReading>` element exported by an Alectra customer (Savage Data CMD feed) showing Alectra's real child ordering — `cost`, `ReadingQuality/quality`, `timePeriod`, `value 2290000`, `tou 2`. It is a fragment, not an Atom feed, so it documents Alectra structure rather than feed layout. | `github.com/rocketraman/open-green-button-homeassistant/issues/4`. |
| `green-button-alliance-sample.xml` | Canonical **Green Button Alliance** published sample ("Test GB Data Hourly Nine Days Binned Daily", 216 IntervalReadings) including the `xml-stylesheet` PI, banner comment, and `ElectricPowerUsageSummary`. | `s3-us-west-2.amazonaws.com/technical.greenbuttonalliance.org/library/sample-data/TestGBDataHourlyNineDaysBinnedDaily.xml` (linked from the GBA samples index). |
| `synthetic.xml` | Small synthetic feed generated for the e2e smoke test (no real meter readings). | Created in-repo by earlier waves. |

## When you add a fixture

- Keep it out of git unless it is genuinely public: the root `.gitignore`
  rule is the privacy guard, do not weaken it.
- Record provenance above, and say plainly when a file is a stand-in rather
  than the real utility's export.
- Never put your own Oakville Hydro export here.
