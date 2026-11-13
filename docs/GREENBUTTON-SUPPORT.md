# Green Button support: bounded evidence and implementation roadmap

Checked 2026-10-12; present-tense code claims refreshed 2026-11-13 against `origin/main` **8dcec0f41f6269d882518b7e5eeae7f3be39eaed** (original read-only baseline **988ea57a7cc283f7edac7da350fc3931635662c1**). Claims below reflect the pinned refresh commit; later waves may supersede them without updating this document, so re-verify against the pin before relying on an “Impact today” line. This is a third-party electricity consumer interoperability programme, **not certification or a claim of supporting every normative requirement**. No production parser, runtime dependency, existing test or portal registration was changed.

## TL;DR

- “All” must be an edition + schema + role/profile inventory, not an OAuth scope wish list. NAESB now lists **retail MBPs v4.1, May 15, 2026**, including REQ.21 and dated usage/customer schemas. Those documents are membership-gated. Its public ESPI landing page still offers **v4.0** schemas behind a copyright acknowledgement. We did not accept terms, buy anything, sign forms or log in. Public schemas are Apache-2.0; the full MBPs are not.

- The reproducible baseline here is GBA’s public **v4.0.20231213 usage/customer mirror**, with v3.3 compatibility and a separately flagged v4.1 customer draft. The v4.1 mirror says **“Published Pending”** and root `version="4.0"`; it is NOT verified as the May 2026 final edition. No v4.1 usage schema exists at that pinned mirror path.

- The current browser accepts readings by local element name and inspects their ReadingType metadata: `webapp/src/lib/greenbutton/series.ts` `classifySeries` (wired into the main parser in `webapp/src/lib/energy.ts`) reads commodity/uom/kind/accumulation/flow and refuses what must not be converted — non-electricity commodities, register and spot accumulations, non-energy quantities, reverse/combined flow, unconvertible power — with explicit reasons surfaced as series notes (`SeriesNotesNotice` + `i18n/seriesNote.ts`); `webapp/src/lib/commodity.ts` keeps gas volume in m³ and never kWh. Readings with no ReadingType at all take an announced legacy Wh assumption (a `legacy-assumption` note), never a silent label. It implements a useful unit subset (Wh/multiplier, uom 72, joules, W×interval duration), bill subset, one feed clock and a narrow OAuth shim. It does **not** put interval duration on data points or fully resolve the Atom graph. Consumer electricity correctness and explicit non-electricity diagnostics come first.

- **Do not request PII, gas/water or other services for “full coverage”.** Keep `FB=1_3_4_5` as the current configured default; capability/profile review may refine needed usage/security terms, but never add unrelated consent scopes. Gas/water/temperature must remain distinct typed resources or explicit unsupported diagnostics, never kWh/Ontario tariffs. No new non-electric dashboard inferred.

- Supported claims below are deliberately **feature-scoped**. No complete schema class or whole function block is claimed fully implemented. “Explicitly unsupported” in this document means an explicit exclusion; it does **not** mean current runtime already emits a diagnostic. Silent drop/coercion is a tracked defect, not support.

## Source hierarchy, pinning and access limits

| Evidence | Exact reference / version | What it proves and does not prove |
|---|---|---|
| Normative publisher | [NAESB retail standards](https://www.naesb.org/retail_standards.asp): v4.1, 2026-05-15, `retail_bk21_051526.pdf`, `espi_051526.xsd`, `espi_customer_051526.xsd` | Latest listed retail publication containing REQ.21. [Full REQ.21 link](https://www.naesb.org/member_login_check.asp?doc=retail_bk21_051526.pdf) returned member login. We cannot verify normative text, correction status or complete v4.1 delta. |
| Public schema licence / old release | [NAESB ESPI](https://www.naesb.org/espi_standards.asp), [v4 usage acknowledgement](https://www.naesb.org/termsofuse_form.asp?doc=espi_v4.xsd), [v4 customer acknowledgement](https://www.naesb.org/termsofuse_form.asp?doc=customer_v4.xsd) | Apache-2.0 exception applies to schemas only. Forms were read, not submitted. v4.0 is not thereby proved latest. |
| v4.0 public mirror | [GBA usage](greenbutton/espi-v4.0.xsd), [customer](greenbutton/customer-v4.0.xsd); GBA OpenESPI-GreenButton-Java commit `06666dc82396b53ed14e7a5c45266ed54015c1ce` (2026-06-09) | Both header/root version `4.0.20231213`; bounded implementation inventory, not licensed MBPs or verified equality to gated final schemas. Individual remote URLs/SHA256s in inventory. |
| Legacy public mirror | GBA OpenESPI-Common-java commit `51d5ea54edace246678ce412da6020ad468fcb28` (2022-12-08): [usage](greenbutton/usage-v3.3.xsd) `3.3.20200320`, [customer](greenbutton/retailcustomer-v3.3.xsd) `3.3.20200130` | Usage notices also say GBA extension `3.3.2.20201019`. Do not mistake mirror extensions for normative requirements. Original suggested `master/etc/usage.xsd` is now 404; files moved then later disappeared from current tree. Current Common-java tip audited: `a180429421117ba04e7378d1b4fa298997d74cb8` (2025-07-01). |
| v4.1 mirror delta only | [customer_4.1](greenbutton/customer-v4.1.xsd), same new-Java pin | Header Pending/root 4.0; removes AssetContainer/OrganisationRole/WorkLocation relative to v4.0. This is a review candidate, not final release provenance. |
| Atom | [legacy atom](greenbutton/atom-v3.3.xsd), [draft atom](greenbutton/atom-v4.1.xsd); [RFC4287](https://www.rfc-editor.org/rfc/rfc4287), [RFC3986](https://www.rfc-editor.org/rfc/rfc3986) | Imported `atom.xsd` has no edition version. New mirror’s v4.0 directory does not include Atom. These snapshots support envelope inventory, NOT a demonstrated complete v4.0 validation bundle. |
| Public profiles and function blocks | [GBA full catalog](https://www.greenbuttonalliance.org/function-blocks), [CMD catalog](https://www.greenbuttonalliance.org/cmd-function-blocks), [GBA Java FB enum](https://raw.githubusercontent.com/GreenButtonAlliance/OpenESPI-GreenButton-Java/06666dc82396b53ed14e7a5c45266ed54015c1ce/openespi-common/src/main/java/org/greenbuttonalliance/espi/common/scope/FunctionBlock.java) | GBA public catalog marks common/interval and DMD/CMD mandatory blocks; FB4 requires one of electricity/gas/water/temperature. These are custodian certification profiles, not an instruction that this third party collect all services. Java enum claims ESPI4 §REQ.21.4.2.1.3.1, but we have NOT independently read that gated section. |
| Historical definitions | [legacy function-block table](https://raw.githubusercontent.com/green-button/green-button.github.io/9e51bf67c91bf92dcb74e9fbbcb3c52ac9f477c4/espi/connect_function_blocks.md), [scope grammar](https://green-button.github.io/espi/authorization_scope/) at green-button site pin `9e51bf67c91bf92dcb74e9fbbcb3c52ac9f477c4`; [API docs](https://greenbuttonalliance.github.io/OpenESPI-GreenButton-API-Documentation/API/) pin `5896d39e2bf0d77b5a65774db2d903c2487e9ddf` | Historical material, not current normative authority. Old FB41/44 labels reversed versus current GBA catalog; old FB31 is crossed-out Core REST. Current CMD page mislabels Manage Authorization FB40; full catalog says FB44. CMD page calls FB68 RESERVED; Java says retail query parameters. Do not silently “repair” a utility’s wire scopes. |
| Official illustrations | [GBA overview](https://dev.greenbuttonalliance.org/overview.html), [developer resources](https://green-button.github.io/developers/), [reference samples](https://green-button.github.io/samples/) | Explain data-custodian/third-party/customer roles and Atom resources. Sample docs are illustrative, not automatically schema-valid or genuine utility exports. |
| Certification limits | [GBA certification](https://www.greenbuttonalliance.org/certification) | GBA’s page advertises custodian testing, v4 TLS1.3 and bill-image enhancement. Its third-party verification notice is dated; do not infer programme availability. DMD validator explicitly does not check everything. No certification marks/claims/paid services used here. |

Official mutable-page retrieval receipts are in [source-receipts.json](greenbutton/source-receipts.json). Schema snapshots retain their original Apache notices; the full MBPs are not included. **P0 exit gate:** PM obtains lawful access and confirms exact REQ.21 edition/corrections + final usage/customer/Atom bundle and third-party PICS before making any full-spec claim. This access gap does not prevent the bounded implementation backlog below.

## Current code: supported feature slices and executable tests

| ID / classification | Verified scope | Executable test (exact title) | Remaining gap |
|---|---|---|
| F01 — fully parsed+used | Wh integer scaling: Linked/inline/single-distinct ReadingType exponent, raw Wh divided by 1000; no other units claimed | `webapp/src/lib/utilitySamples.test.ts` — uses the multiplier linked from the IntervalBlock entry (−3 → /1000 again)<br>`webapp/src/lib/utilitySamples.test.ts` — ignores multipliers declared on summary measurements (Oakville-shaped feed) | [G01](#g01) |
| F02 — fully parsed+used | UsagePoint href grouping: self before up before related; path-shaped links only; no URI graph claimed | `webapp/src/lib/utilitySamples.test.ts` — groups readings under the same UsagePoint regardless of link/entry position | [G02](#g02) |
| F03 — fully parsed+used | Namespace-prefix/entry-order tolerance: Prefix removal and reordering accepted; namespace URI collision protection NOT claimed | `webapp/src/lib/utilitySamples.test.ts` — yields identical readings with and without espi: prefixes<br>`webapp/src/lib/utilitySamples.test.ts` — does not depend on the order entries appear in the feed | [G02](#g02) |
| F04 — fully parsed+used | Summary money and bill periods: billLastPeriod/billToDate/costAdditionalLastPeriod /100000; billingPeriod; both element variants | `webapp/src/lib/usageSummary.test.ts` — reads CAD and the money scale the schema defines (÷100,000)<br>`webapp/src/lib/usageSummary.test.ts` — reads ElectricPowerUsageSummary under its schema name too | [G05](#g05) |
| F05 — parsed+preserved | Line item/measurement subset: note, rawAmount, itemKind, unitCost, measurement value/multiplier/uom; not rounding/dateTime/itemPeriod | `webapp/src/lib/usageSummary.test.ts` — keeps every line item with its note verbatim and its raw itemKind | [G05](#g05) |
| F06 — fully parsed+used | LocalTimeParameters single clock: tzOffset/dstOffset/hex rules; one feed-wide clock, not per-UsagePoint linked clocks | `webapp/src/lib/localTimeParameters.test.ts` — flips the offset exactly at the transitions<br>`webapp/src/lib/localTimeParameters.test.ts` — gives the 23-hour and 25-hour days the calendar has<br>`webapp/src/lib/localTimeParameters.test.ts` — parses tzOffset alone and never invents a DST regime | [G03](#g03) |
| F07 — fully parsed+used | Incomplete billing comparison guard: Existing inferred cadence/coverage guard, NOT explicit ESPI duration coverage | `webapp/src/lib/usageSummary.test.ts` — refuses to compare a half-covered period (missing data is not a rate miss) | [G03](#g03) |
| F08 — fully parsed+used | Authorization-code OAuth: State/cookie binding, minimal configured scope, code exchange; PKCE optional | `webapp/src/lib/greenbutton/oauthFlow.test.ts` — sends the narrow scope and the registered redirect_uri to the custodian<br>`webapp/src/lib/greenbutton/oauthFlow.test.ts` — rejects a callback whose state does not match the cookie | [G08](#g08) |
| F09 — fully parsed+used | Refresh rotation/rejection: Persist rotated refresh; invalid_grant or fresh-token rejection clears locally; no remote revoke claimed | `webapp/src/lib/greenbutton/oauthFlow.test.ts` — persists the rotated refresh token before returning<br>`webapp/src/lib/greenbutton/oauthFlow.test.ts` — survives rotation plus a one-shot resource 401 (retry uses the rotated refresh token)<br>`webapp/src/lib/greenbutton/oauthFlow.test.ts` — clears the stored tokens and reports grant_revoked when the utility says no | [G10](#g10) |
| F10 — fully parsed+used | Authorization resource pointer: resourceURI extraction and URI-base resolution ONLY; other Authorization XML fields ignored | `webapp/src/lib/greenbutton/oauthFlow.test.ts` — resolves the relative resourceURI the Authorization resource advertises and pipes the feed | [G08](#g08) |
| F11 — fully parsed+used | CMD bounded notification / 202: Notification change-marker only; 202 reports data_pending; no BatchList item semantics/polling claimed | `webapp/src/lib/greenbutton/oauthFlow.test.ts` — accepts a BatchList at the registered token path and only records a timestamp<br>`webapp/src/lib/greenbutton/oauthFlow.test.ts` — surfaces an async 202 batch as data_pending instead of hanging | [G09](#g09) |
| F12 — fully parsed+used | XML diagnostics: Malformed/empty/HTML/entity/missing-readings diagnostics (`parseDiagnostic`); refused series — unsupported commodity, register/spot, quantity, flow — reach the user as series notes (`SeriesNotesNotice` + `i18n/seriesNote.ts`) | `webapp/src/lib/parseDiagnostic.test.ts` — names external entities instead of repeating the parser error<br>`webapp/src/lib/parseDiagnostic.test.ts` — explains a feed with entries but no readings<br>`webapp/src/lib/greenbutton/series.test.ts` — refuses natural gas (commodity 7) and potable water (commodity 9)<br>`webapp/src/components/SeriesNotesNotice.test.tsx` — prints every refusal, in order, when the feed carried several | [G07](#g07) |

Local command (executed, not hypothetical):

```sh
cd webapp
npm ci --ignore-scripts --no-audit --no-fund
npm run test -- src/lib/utilitySamples.test.ts src/lib/usageSummary.test.ts src/lib/localTimeParameters.test.ts src/lib/parseDiagnostic.test.ts src/lib/greenbutton/shim.test.ts src/lib/greenbutton/oauthFlow.test.ts
```

**Result: 6 files / 152 tests passed** on the refreshed baseline (141 at the 2026-10-12 audit). Twenty-four exact test titles are mapped to twelve supported feature slices. These tests prove those assertions only. The Alectra fragment test currently asserts raw `value/1000` without ReadingType; it is **not** a verified kWh interpretation. Existing bill-test titles say “real Oakville” but their committed inputs are reconstructed synthetics; not new real XML evidence. No real utility end-to-end CMD run was performed.

Code evidence: [energy.ts](../webapp/src/lib/energy.ts) `parseGreenButtonFeed` / `parseGreenButtonUsagePoints` (grouping) and `parseUsageSummaryNodes` / `parseLocalTimeNode` (bill subset/first clock); [series.ts](../webapp/src/lib/greenbutton/series.ts) `classifySeries` (per-reading unit conversion and refusal classification); [parseDiagnostic.ts](../webapp/src/lib/parseDiagnostic.ts); [config.ts](../webapp/src/lib/greenbutton/config.ts) 60–71 (scope); [oauth.ts](../webapp/src/lib/greenbutton/oauth.ts); [sync.ts](../webapp/src/lib/greenbutton/sync.ts); [espi.ts](../webapp/src/lib/greenbutton/espi.ts); [notification](../webapp/src/app/greenbutton/notify/%5Btoken%5D/route.ts). [Legacy Python parser](../parser.py) 125–205 assumes W × duration and Toronto; it is not the browser parser and is NOT ESPI-wide. `tests/test_parser.py` tests that legacy model, not arbitrary ESPI quantities.

## Complete resource inventory (bounded v4.0 baseline)

Global declarations include both standalone resources and embedded helper types; they are deliberately all inventoried, not all described as API endpoints. The matrix also covers every complex type, declared field/attribute, inheritance base, simple-type enum and cardinality through [schema-inventory.json](greenbutton/schema-inventory.json). Resource-status rows are conservative whole-object classifications: implemented subsets do not promote the full object to “supported”.

| Namespace / global element | Current whole-object classification | Existing subset | Phase / acceptance gap |
|---|---|---|
| `espi:ApplicationInformation` (ApplicationInformation) | explicitly unsupported | None | P2 / [G08](#g08) |
| `espi:Authorization` (Authorization) | explicitly unsupported | F10 | P2 / [G08](#g08) |
| `espi:IntervalBlock` (IntervalBlock) | explicitly unsupported | F01 | P1 / [G03](#g03) |
| `espi:IntervalReading` (IntervalReading) | explicitly unsupported | F01 | P1 / [G01](#g01) |
| `espi:MeterReading` (MeterReading) | explicitly unsupported | None | P1 / [G01](#g01) |
| `espi:ReadingQuality` (ReadingQuality) | explicitly unsupported | None | P1 / [G04](#g04) |
| `espi:ReadingType` (ReadingType) | explicitly unsupported | F01 | P1 / [G01](#g01) |
| `espi:IdentifiedObject` (IdentifiedObject) | explicitly unsupported | None | P1 / [G02](#g02) |
| `espi:UsagePoint` (UsagePoint) | explicitly unsupported | None | P1 / [G02](#g02) |
| `espi:ElectricPowerQualitySummary` (ElectricPowerQualitySummary) | explicitly unsupported | None | P3 / [G06](#g06) |
| `espi:ElectricPowerUsageSummary` (ElectricPowerUsageSummary) | explicitly unsupported | F04, F05 | P2 / [G05](#g05) |
| `espi:UsageSummary` (UsageSummary) | explicitly unsupported | F04, F05 | P2 / [G05](#g05) |
| `espi:DateTimeInterval` (DateTimeInterval) | explicitly unsupported | F04 | P1 / [G03](#g03) |
| `espi:SummaryMeasurement` (SummaryMeasurement) | explicitly unsupported | F05 | P2 / [G05](#g05) |
| `espi:BatchItemInfo` (BatchItemInfo) | explicitly unsupported | None | P2 / [G09](#g09) |
| `espi:Object` (Object) | explicitly unsupported | None | P1 / [G02](#g02) |
| `espi:ServiceStatus` (ServiceStatus) | explicitly unsupported | None | P3 / [G06](#g06) |
| `espi:LocalTimeParameters` (TimeConfiguration) | explicitly unsupported | F06 | P1 / [G03](#g03) |
| `espi:ProgramIdMappings` (ProgramIdMappings) | explicitly unsupported | None | P3 / [G06](#g06) |
| `espi:BatchList` (BatchListType) | explicitly unsupported | None | P2 / [G09](#g09) |
| `cust:AcceptanceTest` (AcceptanceTest) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:AccountNotification` (AccountNotification) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:Agreement` (Agreement) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:Asset` (Asset) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:AssetContainer` (AssetContainer) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:BatchItemInfo` (BatchItemInfo) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:BatchList` (BatchListType) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:Customer` (Customer) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:CustomerAccount` (CustomerAccount) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:CustomerAgreement` (CustomerAgreement) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:DateTimeInterval` (DateTimeInterval) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:DemandResponseProgram` (DemandResponseProgram) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:Document` (Document) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:ElectronicAddress` (ElectronicAddress) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:EndDevice` (EndDevice) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:IdentifiedObject` (IdentifiedObject) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:LifecycleDate` (LifecycleDate) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:LocalTimeParameters` (TimeConfiguration) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:Location` (Location) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:Meter` (Meter) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:MeterMultiplier` (MeterMultiplier) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:Object` (Object) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:Organisation` (Organisation) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:OrganisationRole` (OrganisationRole) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:PositionPoint` (PositionPoint) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:PricingStructure` (PricingStructure) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:Priority` (Priority) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:ProgramDate` (ProgramDate) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:ProgramDateIdMapping` (ProgramDateIdMapping) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:ProgramDateIdMappings` (ProgramDateIdMappings) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:ServiceLocation` (ServiceLocation) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:ServiceSupplier` (ServiceSupplier) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:Statement` (Statement) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:StatementRef` (StatementRef) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:Status` (Status) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:StreetAddress` (StreetAddress) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:StreetDetail` (StreetDetail) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:SummaryMeasurement` (SummaryMeasurement) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:TelephoneNumber` (TelephoneNumber) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:TimeConfiguration` (TimeConfiguration) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:TownDetail` (TownDetail) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:UsagePoint` (UsagePoint) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:UsagePoints` (UsagePoints) | explicitly unsupported | None | P3 / [G11](#g11) |
| `cust:WorkLocation` (WorkLocation) | explicitly unsupported | None | P3 / [G11](#g11) |

`cust:UsagePoint`, `cust:LocalTimeParameters`, `cust:SummaryMeasurement` etc are **not** energy-namespace objects even when the local names match. `Customer`, `CustomerAccount`, `CustomerAgreement`, address/contact/demographic structures, meter/end-device, supplier/location and ProgramDateIdMappings are PII-family resources. `Statement`/`StatementRef` include bill-image functionality: inventory only, no image fetching/collection. RetailCustomer, Subscription and Batch are API aggregates/paths/actors, not invented XSD classes; see protocol inventory below.

Complete legacy/draft/Atom declarations and all nested structures (ServiceCategory, ServiceDeliveryPoint, LineItem, RationalNumber, ReadingInterharmonic, node/rider refs, BillingChargeSource, TimeConfiguration and more) are individually reconciled in [support-matrix.json](greenbutton/support-matrix.json). Every unsupported row has a phase and named test/fixture in gaps.json. Declared field support carries a context: e.g. DateTimeInterval billingPeriod handling does NOT imply interval duration handling, and compound fields with only decoded subsets remain unsupported as a whole.

### Protocol inventory (not additional schema entities)

| Surface | Current classification / behaviour | Required gap |
|---|---|---|
| Atom feed/entry ID, published/updated, self/up/related/xml:base and canonical joins | Explicitly unsupported as a complete envelope/graph; F02/F03 partial href/prefix handling. IDs/timestamps/foreign namespaces not retained; suffix regex is not link resolution. | G02 / G07 |
| RetailCustomer/Subscription/Batch aggregate identity and scope | Explicitly unsupported as complete API object; F10 resolved resourceURI is fetched once. A byte-stream pass-through is NOT a parsed+preserved client model. | G08 / G09 |
| ApplicationInformation/capability scopes | Explicitly unsupported resource parser/negotiation; env-config URLs/minimal scope only. Requested and granted scope strings retained in token metadata, not parsed FB capabilities. | G08 |
| Authorization XML status, authorised/published periods, expiry, customerResourceURI | Explicitly unsupported except F10 resourceURI; JSON token exchange != whole Authorization XML model. | G08 / G10 |
| Refresh/rotation/rejection/local disconnect | F09 fully parsed+used for tested serial token behaviour; remote revoke/concurrency not supported. | G10 |
| Pagination/BatchItemInfo item errors/async polling and continuation | Explicitly unsupported; F11 reports 202 pending and bounded notification change-marker only. | G09 |
| Query scope/filter completeness | Explicitly unsupported full profile; published-min/max built/clamped, other ESPI filters not implemented. | G09 |
| Producer APIs: utility DMD portal, utility authorisation UI/server, meter-upload/admin service, certification identity | Not applicable to our third-party role. Receiving DMD XML/CMD usage still applicable; provider credentials/sandbox contract remains separate. | G12 |
| SFTP/offline authorisation/dynamic registration/admin mutation | Explicitly unsupported optional receiver interfaces (do not request/enable by default); out-of-role producer/admin services N/A. | G12 |

## Every published/pinned function-block identifier

Inventory is the union of the live GBA full catalog, pinned GBA Java active/deprecated IDs, and pinned historical table. It does not assume every number 1–70 was allocated. IDs absent from all sources remain **unknown**, not invented blocks. Website/API-version conflicts are retained in JSON with separate current/legacy titles and URLs. Java deprecation is repository evidence, not independently verified MBP text. Block classification is whole-block; feature IDs show only existing slices.

| FB | Primary title / source state | Current whole-block classification | Existing subset | Phase / gap |
|---|---|---|
| 01 | Common (Energy Usage) (active) | explicitly unsupported | F02, F06 | P1 / [G02](#g02) |
| 02 | Download My Data (Energy Usage) (active) | explicitly unsupported | F03 | P4 / [G12](#g12) |
| 03 | Connect My Data (Energy Usage) (active; see source-label differences) | explicitly unsupported | F08, F09, F10, F11 | P2 / [G08](#g08) |
| 04 | Interval Metering (active) | explicitly unsupported | F01 | P1 / [G02](#g02) |
| 05 | Interval Electricity Metering (active) | explicitly unsupported | F01 | P1 / [G01](#g01) |
| 06 | Demand Electricity Metering (active) | explicitly unsupported | None | P1 / [G01](#g01) |
| 07 | Net Metering (active) | explicitly unsupported | None | P1 / [G01](#g01) |
| 08 | Forward and Reverse Metering (active) | explicitly unsupported | None | P1 / [G01](#g01) |
| 09 | Register Values (active) | explicitly unsupported | None | P1 / [G01](#g01) |
| 10 | Gas Interval Metering (active) | explicitly unsupported | None | P1 / [G01](#g01) |
| 11 | Water Interval Metering (active) | explicitly unsupported | None | P1 / [G01](#g01) |
| 12 | Cost of Interval Data (active) | explicitly unsupported | None | P2 / [G05](#g05) |
| 13 | Security and Privacy Classes (Energy Usage) (active; see source-label differences) | explicitly unsupported | F08 | P2 / [G08](#g08) |
| 14 | Authorization and Authentication (OAuth) (deprecated) | explicitly unsupported | F08 | P2 / [G08](#g08) |
| 15 | Usage Summary (active) | explicitly unsupported | F04 | P2 / [G05](#g05) |
| 16 | Usage Summary with Cost (active) | explicitly unsupported | F04, F05 | P2 / [G05](#g05) |
| 17 | Power Quality Summary (active) | explicitly unsupported | None | P3 / [G06](#g06) |
| 18 | Deprecated ID; title not independently verified (deprecated) | explicitly unsupported | None | P4 / [G12](#g12) |
| 19 | Partial update data (deprecated) | explicitly unsupported | None | P2 / [G09](#g09) |
| 27 | Usage Summary with Demands and Previous Day Attributes (active) | explicitly unsupported | None | P2 / [G05](#g05) |
| 28 | Usage Summary Costs for Current Billing Period (active) | explicitly unsupported | F04 | P2 / [G05](#g05) |
| 29 | Temperature Interval Metering (active) | explicitly unsupported | None | P1 / [G01](#g01) |
| 30 | Common User Experience (active) | not applicable to our third-party role | None | P4 / [G12](#g12) |
| 31 | Authorization and Authentication w/o Pre-Negotiated Scope (active; see source-label differences) | explicitly unsupported | F08 | P2 / [G08](#g08) |
| 32 | Resource Level REST (deprecated) | explicitly unsupported | None | P4 / [G12](#g12) |
| 33 | Management REST Interfaces (deprecated) | not applicable to our third-party role | None | P4 / [G12](#g12) |
| 34 | FB_34] SFTP for Usage Data Bulk (deprecated; see source-label differences) | explicitly unsupported | None | P4 / [G12](#g12) |
| 35 | REST for Energy Usage Bulk (active; see source-label differences) | explicitly unsupported | F10 | P2 / [G09](#g09) |
| 36 | Third Party (Client) Dynamic Registration (deprecated) | explicitly unsupported | None | P4 / [G12](#g12) |
| 37 | Query Parameters (Energy Usage) (active; see source-label differences) | explicitly unsupported | F11 | P2 / [G09](#g09) |
| 38 | On Demand Requests (deprecated) | explicitly unsupported | F10 | P2 / [G09](#g09) |
| 39 | PUSH Model (Energy Usage) (active; see source-label differences) | explicitly unsupported | F11 | P2 / [G09](#g09) |
| 40 | Offline Authorization (Energy Usage) (active; see source-label differences) | explicitly unsupported | None | P4 / [G12](#g12) |
| 41 | Manage ApplicationInformation Resource (active; see source-label differences) | explicitly unsupported | None | P4 / [G12](#g12) |
| 42 | Third Party Core REST Services (not enumerated) | explicitly unsupported | None | P4 / [G12](#g12) |
| 43 | Third Party Management REST Services (not enumerated; applicability unverified pending P0) | explicitly unsupported | None | P4 / [G12](#g12) |
| 44 | Manage Authorization Resource (active; see source-label differences) | explicitly unsupported | None | P4 / [G12](#g12) |
| 46 | Deprecated ID; title not independently verified (deprecated; applicability unverified pending P0) | explicitly unsupported | None | P4 / [G12](#g12) |
| 47 | Deprecated ID; title not independently verified (deprecated; applicability unverified pending P0) | explicitly unsupported | None | P4 / [G12](#g12) |
| 48 | Deprecated ID; title not independently verified (deprecated; applicability unverified pending P0) | explicitly unsupported | None | P4 / [G12](#g12) |
| 49 | Deprecated ID; title not independently verified (deprecated; applicability unverified pending P0) | explicitly unsupported | None | P4 / [G12](#g12) |
| 50 | Deprecated ID; title not independently verified (deprecated; applicability unverified pending P0) | explicitly unsupported | None | P4 / [G12](#g12) |
| 51 | Common (Retail Customer) (active) | explicitly unsupported | None | P3 / [G11](#g11) |
| 52 | Download My Data (Retail Customer) (active) | explicitly unsupported | None | P3 / [G11](#g11) |
| 53 | Connect My Data (Retail Customer) (active) | explicitly unsupported | None | P3 / [G11](#g11) |
| 54 | Basic Retail Customer Information (active) | explicitly unsupported | None | P3 / [G11](#g11) |
| 55 | Retail Customer Address Information (active) | explicitly unsupported | None | P3 / [G11](#g11) |
| 56 | Retail Customer Billing Information (active) | explicitly unsupported | None | P3 / [G11](#g11) |
| 57 | Retail Customer AccountAgreement Information (active) | explicitly unsupported | None | P3 / [G11](#g11) |
| 58 | Retail Customer ServiceLocation Information (active) | explicitly unsupported | None | P3 / [G11](#g11) |
| 59 | Retail Customer ServiceSupplier Information (active) | explicitly unsupported | None | P3 / [G11](#g11) |
| 60 | Retail Customer Meter Information (active) | explicitly unsupported | None | P3 / [G11](#g11) |
| 61 | Retail Customer EndDevice Information (active) | explicitly unsupported | None | P3 / [G11](#g11) |
| 62 | Retail Customer ProgramDateIdMapping Information (active) | explicitly unsupported | None | P3 / [G11](#g11) |
| 63 | Common User Experience (Retail Customer) (active) | not applicable to our third-party role | None | P3 / [G11](#g11) |
| 64 | Security and Privacy Classes (Retail Customer) (active) | explicitly unsupported | None | P3 / [G11](#g11) |
| 65 | Authorization and Authentication w/o Pre-Negotiated Scope (Retail Customer) (active) | explicitly unsupported | None | P3 / [G11](#g11) |
| 66 | FB_66] SFTP for Retail Customer Bulk (deprecated) | explicitly unsupported | None | P3 / [G11](#g11) |
| 67 | REST for Retail Customer Bulk (active) | explicitly unsupported | None | P3 / [G11](#g11) |
| 68 | Query Parameters (Retail Customer) (active) | explicitly unsupported | None | P3 / [G11](#g11) |
| 69 | PUSH Model (Retail Customer) (active) | explicitly unsupported | None | P3 / [G11](#g11) |
| 70 | Offline Authorization (Retail Customer) (active) | explicitly unsupported | None | P3 / [G11](#g11) |

Current public GBA profile: usage FB01 + FB04 common; DMD adds FB02/30; CMD adds FB03/13/31/37/39. FB04 additionally needs at least one of FB05/10/11/29. Retail-customer profiles are separate: FB51 common; DMD FB52/63; CMD FB53/64/65/69, plus selected customer data blocks. These lists describe GBA’s public custodian testing page, **not independently reviewed v4.1 normative obligations for this application**. Many individual FB pages are placeholders (“Markup”); FB41/44 returned 404. Empty content is not a complete acceptance specification.

**Applicability evidence boundary:** FB43's pinned historical title is *Third Party Management REST Services*, but its description is empty and the Java catalog does not enumerate it. FB46–50 appear only in Java's `DEPRECATED_IDS`, with no titles, definitions or role restrictions. These six blocks are **explicitly unsupported, applicability unverified pending P0**, retained at **G12/P4**; neither an unknown meaning nor deprecation proves a custodian/admin-only role. Their source limitations are recorded in [function-block-sources.json](greenbutton/function-block-sources.json). This conservative exclusion does not authorize optional administration implementation, buying gated specifications or widening OAuth scopes. Custodian-side producer exclusions remain separate from these unresolved blocks.

## Scope-ready phased backlog (PM decomposes build tasks)

P0 establishes normative boundaries. P1 prevents incorrect consumer numbers and silently dropped data. P2 completes electricity billing and consented CMD reliability. P3 covers typed auxiliary and retail-schema isolation, without expanding collection or adding a gas/water dashboard. P4 records role exclusions and optional/deprecated interfaces. The phase for gas/water means **diagnostic/safe typing**, not acquisition. Customer namespace collision protection is required in P1 (G02/G07); P3 is broader optional schema handling. No task IDs or build cards invented.

<a id="g00"></a>
### G00 / P0 — Normative edition and profile lock

Impact today: Latest NAESB retail publication is 4.1 (2026-05-15); full REQ.21 and authoritative new schemas are gated. Mirror 4.1 customer says Published Pending and root version 4.0. Unverified normative differences cannot be called complete.

Acceptance test to implement (NOT present yet): `edition-pin-reviewed`. Fixture recipe: `standards-delta-review` in [fixture-manifest.json](greenbutton/fixture-manifest.json).

Pass criteria: Review legally obtained full MBPs and exact dated XSDs; record SHA256, minor corrections and third-party PICS; no purchases/signing in this task.

Evidence: NAESB retail index; public ESPI landing; mirror headers — [source 1](https://www.naesb.org/retail_standards.asp), [source 2](https://www.naesb.org/espi_standards.asp). Checked 2026-10-12.

<a id="g01"></a>
### G01 / P1 — Typed quantity and unit gate

Impact today: The browser no longer labels every IntervalReading as kWh — `series.ts` `classifySeries` (wired into the main parser in `energy.ts`) reads commodity, uom, kind, accumulationBehaviour and flowDirection and refuses non-electricity commodities, register and spot accumulations, non-energy quantities, reverse/combined flow and unconvertible power with explicit reasons surfaced as series notes, while `commodity.ts` routes gas to `energy_gas_v2` as m³ (gas priced as electricity is unrepresentable in the data model). The Python parser still assumes W and integrates a guessed/default duration, and the full enum-combination matrix remains unimplemented.

Acceptance test to implement (NOT present yet): `typed-quantities`. Fixture recipe: `quantity-matrix` in [fixture-manifest.json](greenbutton/fixture-manifest.json).

Pass criteria: For each enum combination accept dimensional conversion only with documented semantics: Wh energy versus W average power times own duration; demand stays power; var/varh/VA/VAh stay distinct; gas/water/temperature never kWh or OEB rates. Registers need deltas/reset/rollover rules; reverse/export/net remain separate, not clamped consumption. Explicit diagnostics for all unhandled combinations, missing metadata, extreme multiplier, unsafe integers and lexical junk.

Evidence: espi.xsd ReadingType/IntervalReading/ServiceCategory enumerations — [source 1](https://github.com/GreenButtonAlliance/OpenESPI-GreenButton-Java/blob/06666dc82396b53ed14e7a5c45266ed54015c1ce/openespi-common/src/main/resources/schema/ESPI_4.0/espi.xsd). Checked 2026-10-12.

<a id="g02"></a>
### G02 / P1 — Atom identities and graph

Impact today: Regex href suffix matching is not ID/self/up/related graph resolution. Same suffix under two origins collides; MeterReading-only ReadingType links can lose per-channel scale; namespace stripping can interpret foreign elements.

Acceptance test to implement (NOT present yet): `atom-resource-graph`. Fixture recipe: `graph-adversarial` in [fixture-manifest.json](greenbutton/fixture-manifest.json).

Pass criteria: Index canonical self URIs and atom IDs; respect xml:base and link relation; join UsagePoint→MeterReading→ReadingType→IntervalBlock independent of order; diagnose missing/duplicate/conflicting refs and same suffix different authorities. Keep data provenance; never fetch arbitrary imported links; any CMD fetch must be consented, origin-allowlisted and SSRF-safe.

Evidence: RFC4287/RFC3986; espi.xsd IdentifiedObject/MeterReading/UsagePoint — [source 1](https://www.rfc-editor.org/rfc/rfc4287), [source 2](https://www.rfc-editor.org/rfc/rfc3986), [source 3](https://green-button.github.io/developers/). Checked 2026-10-12.

<a id="g03"></a>
### G03 / P1 — Durations and per-meter clocks

Impact today: DataPoint still carries only timestamp and usage — no per-point duration — and cadence is not interval occupancy. The browser now reads the reading's own duration, the IntervalBlock's interval and ReadingType.intervalLength in `series.ts` (own duration wins, single-reading block interval next, intervalLength as the ReadingType fallback), but a single feed-wide LocalTimeParameters is still the only clock and gap/occupancy windows remain unimplemented.

Acceptance test to implement (NOT present yet): `interval-duration-dst`. Fixture recipe: `duration-dst` in [fixture-manifest.json](greenbutton/fixture-manifest.json).

Pass criteria: Own timePeriod duration wins; ReadingType intervalLength fallback with explicit provenance; block.interval describes block extent NOT a per-reading duration fallback. Retain UTC start/end, split billing/rate boundaries by interval overlap; missing/gap/duplicate/overlap/mixed-cadence incomplete windows stay incomplete. Resolve clocks per meter and test 23/25-hour days, fixed offset and southern-hemisphere rules; no guessing from browser zone.

Evidence: espi.xsd DateTimeInterval/TimeConfiguration — [source 1](https://github.com/GreenButtonAlliance/OpenESPI-GreenButton-Java/blob/06666dc82396b53ed14e7a5c45266ed54015c1ce/openespi-common/src/main/resources/schema/ESPI_4.0/espi.xsd). Checked 2026-10-12.

<a id="g04"></a>
### G04 / P1 — Quality, accumulation and channel qualifiers

Impact today: ReadingQuality/defaultQuality, consumptionTier, tou, cpp, phase and timeAttribute discarded (dataQualifier is now retained in series metadata); estimated or cumulative values look measured and independent.

Acceptance test to implement (NOT present yet): `reading-quality-channel`. Fixture recipe: `quality-channel` in [fixture-manifest.json](greenbutton/fixture-manifest.json).

Pass criteria: Preserve quality code including unknown values; distinguish measured/estimated/substituted with schema-backed policies; never remove quality silently. Preserve tariff/phase/channel qualifiers to prevent double counting parallel register/TOU streams; each accumulation kind either typed implementation with tests or diagnostic.

Evidence: espi.xsd ReadingQuality/ReadingType/IntervalReading — [source 1](https://github.com/GreenButtonAlliance/OpenESPI-GreenButton-Java/blob/06666dc82396b53ed14e7a5c45266ed54015c1ce/openespi-common/src/main/resources/schema/ESPI_4.0/espi.xsd). Checked 2026-10-12.

<a id="g05"></a>
### G05 / P2 — Complete summaries and itemisation

Impact today: Both summary names parse subset; demands/current/previous-day/current-period consumption, statusTimeStamp, quality, commodity, tariffProfile/readCycle/riders/source missing. LineItem rounding/dateTime/itemPeriod omitted; measurement timestamp omitted.

Acceptance test to implement (NOT present yet): `summary-all-fields`. Fixture recipe: `summary-complete` in [fixture-manifest.json](greenbutton/fixture-manifest.json).

Pass criteria: Preserve every field with units/currency/raw scale; fees/negative credits/unknown notes retained without speculative itemKind meaning. Never infer utility-language patterns from synthetics. No cross-meter/cross-currency merging; unknown currency label is unknown, no currency conversion. Deprecated ElectricPowerUsageSummary remains explicit compatibility path. Non-electric summaries cannot enter Ontario tariff model.

Evidence: espi.xsd UsageSummary/ElectricPowerUsageSummary/LineItem/SummaryMeasurement; GBA FB15 — [source 1](https://github.com/GreenButtonAlliance/OpenESPI-GreenButton-Java/blob/06666dc82396b53ed14e7a5c45266ed54015c1ce/openespi-common/src/main/resources/schema/ESPI_4.0/espi.xsd), [source 2](https://www.greenbuttonalliance.org/fb15). Checked 2026-10-12.

<a id="g06"></a>
### G06 / P3 — Power quality and auxiliary typed resources

Impact today: ElectricPowerQualitySummary, ServiceStatus, ProgramIdMappings, node refs and auxiliary types ignored.

Acceptance test to implement (NOT present yet): `auxiliary-resource-roundtrip`. Fixture recipe: `auxiliary-all-resources` in [fixture-manifest.json](greenbutton/fixture-manifest.json).

Pass criteria: Parse+preserve distinct typed objects (no new dashboard inferred) or return explicit resource diagnostics for each pinned class/field. Power quality remains power-quality units, not kWh; retain measurement protocol/summaryInterval.

Evidence: espi.xsd global elements and complex types — [source 1](https://github.com/GreenButtonAlliance/OpenESPI-GreenButton-Java/blob/06666dc82396b53ed14e7a5c45266ed54015c1ce/openespi-common/src/main/resources/schema/ESPI_4.0/espi.xsd). Checked 2026-10-12.

<a id="g07"></a>
### G07 / P1 — Unknown extensions and safe reporting

Impact today: Output is groups/summaries/one clock plus `feed.notes`. Unsupported resources and unknown extensions still vanish without QName-aware counts, but refusals are no longer silent: `classifySeries` refusals reach the dashboard as series notes.

Acceptance test to implement (NOT present yet): `unknown-extension-report`. Fixture recipe: `extensions-safe` in [fixture-manifest.json](greenbutton/fixture-manifest.json).

Pass criteria: Return known/unknown/unsupported counts and QName-aware diagnostics. Preserve safe opaque foreign fields with size/depth limits client-side, never execute markup/PI/DTD or follow URLs. Redact secrets/PII from exports/logs; unsolicited customer data needs opt-in quarantine/drop diagnostic, NOT blanket preservation.

Evidence: RFC4287 foreign markup; espi.xsd Object; parseDiagnostic.ts — [source 1](https://www.rfc-editor.org/rfc/rfc4287), [source 2](https://github.com/GreenButtonAlliance/OpenESPI-GreenButton-Java/blob/06666dc82396b53ed14e7a5c45266ed54015c1ce/openespi-common/src/main/resources/schema/ESPI_4.0/espi.xsd). Checked 2026-10-12.

<a id="g08"></a>
### G08 / P2 — CMD capabilities and least-privilege scope

Impact today: ApplicationInformation is env-config, not resource ingestion. Scope opaque string; no FB/IntervalDuration/BlockDuration/HistoryLength capability negotiation. Authorization only pointer parsed; Subscription is URI aggregate, not schema entity.

Acceptance test to implement (NOT present yet): `cmd-capabilities-scope`. Fixture recipe: `cmd-capabilities` in [fixture-manifest.json](greenbutton/fixture-manifest.json).

Pass criteria: Negotiate only consumed, consented electricity usage capabilities, record granted/requested delta. No automatic PII/gas/water scopes for completeness. Parse authorised/published periods/status/expiry and allowlisted pointers; ApplicationInformation safe metadata only, never store client_secret in client dataset. Third-party scope UI distinct from custodian authorization server.

Evidence: GBA function-blocks; pinned FunctionBlock.java; Authorization/ApplicationInformation schema; OAuth RFC6749 — [source 1](https://www.greenbuttonalliance.org/function-blocks), [source 2](https://www.rfc-editor.org/rfc/rfc6749), [source 3](https://green-button.github.io/espi/authorization_scope/). Checked 2026-10-12.

<a id="g09"></a>
### G09 / P2 — Pagination, batch and async completion

Impact today: One stream fetch; Atom next ignored; BatchList only URL count/change marker; 202 classified without Location/Retry-After continuation or per-item errors.

Acceptance test to implement (NOT present yet): `cmd-pagination-batch-async`. Fixture recipe: `cmd-transfer` in [fixture-manifest.json](greenbutton/fixture-manifest.json).

Pass criteria: Bounded same-origin next-page traversal with cycle/count/byte/time limits and exact dedupe; partial page failure stays partial. Validate authorised BatchItemInfo resources/status; robust idempotent notification→GET. Bounded 202 continuation/backoff supports documented completion mechanism; never trust arbitrary notification URL as authenticated fetch destination; no SFTP absent explicit integration decision.

Evidence: developer API batch docs; espi.xsd BatchListType/BatchItemInfo; espi.ts — [source 1](https://greenbuttonalliance.github.io/OpenESPI-GreenButton-API-Documentation/API/), [source 2](https://github.com/GreenButtonAlliance/OpenESPI-GreenButton-Java/blob/06666dc82396b53ed14e7a5c45266ed54015c1ce/openespi-common/src/main/resources/schema/ESPI_4.0/espi.xsd). Checked 2026-10-12.

<a id="g10"></a>
### G10 / P2 — Remote revoke, rotation concurrency and transport

Impact today: Local disconnect deletes token file but does not revoke at custodian. Existing rotation test is serial; full provider concurrency/TLS policy not proved.

Acceptance test to implement (NOT present yet): `cmd-revoke-concurrent`. Fixture recipe: `cmd-lifecycle` in [fixture-manifest.json](greenbutton/fixture-manifest.json).

Pass criteria: Serialize refresh per grant, atomically persist rotated tokens; one-time-token concurrent request/restart tests. Handle revocation notification/status/invalid_grant; remote revocation only with documented consented provider endpoint; local disconnect honest about scope. Verify TLS1.3 capability/policy and certificate checks locally, no claim from generic fetch.

Evidence: OAuth RFC6749/RFC7009; GBA certification TLS1.3 note; sync.ts — [source 1](https://www.rfc-editor.org/rfc/rfc6749), [source 2](https://www.rfc-editor.org/rfc/rfc7009), [source 3](https://www.greenbuttonalliance.org/certification). Checked 2026-10-12.

<a id="g11"></a>
### G11 / P3 — Retail customer schema / PII isolation

Impact today: All customer-namespace classes unsupported, except namespace-erasing parser may mistakenly treat customer LocalTimeParameters/UsagePoint as energy names. Statement bill-image refs unsupported.

Acceptance test to implement (NOT present yet): `customer-isolation-inventory`. Fixture recipe: `customer-all-resources` in [fixture-manifest.json](greenbutton/fixture-manifest.json).

Pass criteria: Explicit namespace-aware unsupported diagnostics by default. If a later separately approved service needs PII, minimal opt-in scope, separate typed feed/storage boundary, TTL/delete/export/redaction tests. Test each customer global/complex class, Statement/StatementRef/bill-image reference without network download or PII in logs. Inventory NOT an instruction to collect data.

Evidence: customer.xsd resources and namespace annotation; GBA FB51–70 — [source 1](https://github.com/GreenButtonAlliance/OpenESPI-GreenButton-Java/blob/06666dc82396b53ed14e7a5c45266ed54015c1ce/openespi-common/src/main/resources/schema/ESPI_4.0/customer.xsd), [source 2](https://www.greenbuttonalliance.org/function-blocks). Checked 2026-10-12.

<a id="g12"></a>
### G12 / P4 — Administration/offline/deprecated interfaces

Impact today: No dynamic registration/SFTP/offline authorization/admin REST implementation; historic FB labels conflict with current GBA/Java.

Acceptance test to implement (NOT present yet): `profile-role-exclusions`. Fixture recipe: `profile-role` in [fixture-manifest.json](greenbutton/fixture-manifest.json).

Pass criteria: Record third-party receive role versus custodian/authorization-server/admin producer role in PICS. Deprecated/reserved ids diagnostic only; do not request automatically. Out-of-role producer APIs remain N/A; optional receiver transports require explicit PM scope and provider evidence. FB43 and FB46–50 remain explicitly unsupported with applicability unverified pending P0; absence of definitions or deprecation alone cannot justify a role exclusion.

Evidence: GBA catalog; pinned legacy connect_function_blocks.md; FunctionBlock.java — [source 1](https://raw.githubusercontent.com/GreenButtonAlliance/OpenESPI-GreenButton-Java/06666dc82396b53ed14e7a5c45266ed54015c1ce/openespi-common/src/main/java/org/greenbuttonalliance/espi/common/scope/FunctionBlock.java), [source 2](https://raw.githubusercontent.com/green-button/green-button.github.io/9e51bf67c91bf92dcb74e9fbbcb3c52ac9f477c4/espi/connect_function_blocks.md), [source 3](https://www.greenbuttonalliance.org/function-blocks). Checked 2026-10-12.

## Fixture corpus, provenance and privacy

[fixture-manifest.json](greenbutton/fixture-manifest.json) is the cited corpus contract. Public reference URLs are pinned by Git commit or SHA256/retrieval date. Official illustration != real utility sample != synthetic. New synthetic adversarial cases are **specified recipes**, not implemented/passing production tests; this docs-only task does not modify another worker’s test corpus.

| Fixture | Provenance class | Pin / availability |
|---|---|---|
| [ApplicationInformation-Entry-Anonymized.xml](https://raw.githubusercontent.com/GreenButtonAlliance/OpenESPI-GreenButton-Java/06666dc82396b53ed14e7a5c45266ed54015c1ce/openespi-common/src/test/resources/sample-xml/ApplicationInformation-Entry-Anonymized.xml) | GBA-repository-anonymized-reference | SHA256 34f6a0b370f5300f…; official reference fetched |
| [Authorization-Entry-Anonymized.xml](https://raw.githubusercontent.com/GreenButtonAlliance/OpenESPI-GreenButton-Java/06666dc82396b53ed14e7a5c45266ed54015c1ce/openespi-common/src/test/resources/sample-xml/Authorization-Entry-Anonymized.xml) | GBA-repository-anonymized-reference | SHA256 553e61d045fa624b…; official reference fetched |
| [Customer-Subscription-Feed-Anonymized.xml](https://raw.githubusercontent.com/GreenButtonAlliance/OpenESPI-GreenButton-Java/06666dc82396b53ed14e7a5c45266ed54015c1ce/openespi-common/src/test/resources/sample-xml/Customer-Subscription-Feed-Anonymized.xml) | GBA-repository-anonymized-reference | SHA256 ed5efb9046ec9858…; official reference fetched |
| [Multiple-Authorization-Feed-Anonymized.xml](https://raw.githubusercontent.com/GreenButtonAlliance/OpenESPI-GreenButton-Java/06666dc82396b53ed14e7a5c45266ed54015c1ce/openespi-common/src/test/resources/sample-xml/Multiple-Authorization-Feed-Anonymized.xml) | GBA-repository-anonymized-reference | SHA256 4398a690d03362e3…; official reference fetched |
| [Usage-Subscription-Feed-Anonymized.xml](https://raw.githubusercontent.com/GreenButtonAlliance/OpenESPI-GreenButton-Java/06666dc82396b53ed14e7a5c45266ed54015c1ce/openespi-common/src/test/resources/sample-xml/Usage-Subscription-Feed-Anonymized.xml) | GBA-repository-anonymized-reference | SHA256 58ca69ff5c1878aa…; official reference fetched |
| [testdata.xml](https://raw.githubusercontent.com/GreenButtonAlliance/OpenESPI-GreenButton-Java/06666dc82396b53ed14e7a5c45266ed54015c1ce/openespi-common/src/test/resources/sample-xml/testdata.xml) | GBA-repository-anonymized-reference | SHA256 4343c5a073b38172…; official reference fetched |
| [gba-hourly.xml](https://s3-us-west-2.amazonaws.com/technical.greenbuttonalliance.org/library/sample-data/TestGBDataHourlyNineDaysBinnedDaily.xml) | official-public-reference | SHA256 18e54b8b1ebdfa2f…; official reference fetched |
| [utility-hydro-one.xml](https://raw.githubusercontent.com/ryanmaule/greenbutton-to-homeassistant-sql/86fd37e99e8d81c32a72e1baf825ae9a7163b59b/import/hourly-weekday.xml) | public-utility-customer-sample | 86fd37e99e8d81c32a72e1baf825ae9a7163b59b; public source retrieved |
| [utility-toronto-hydro.xml](https://github.com/vqvu/home-assistant-green-button/issues/77) | public-utility-customer-sample | SHA256 a439c43af5552f92…; public source retrieved |
| [utility-alectra-fragment.xml](https://github.com/rocketraman/open-green-button-homeassistant/issues/4) | public-utility-fragment | SHA256 47d25bc5deb95034…; public source retrieved |
| [utility-espi-prefixed-standin.xml](https://raw.githubusercontent.com/jgkramer/hummingbird/c55ff29ee11d5b649fdd37c00031ff95170044a2/usage_data/lindahl.xml) | public-non-Ontario-standin | c55ff29ee11d5b649fdd37c00031ff95170044a2; public source retrieved |
| `webapp/tests/fixtures/usage-summary-synthetic.xml` | existing-synthetic | SHA256 0eab336ebb4b3eed…; existing synthetic bytes pinned |
| `webapp/tests/fixtures/usage-summary-open-tail.xml` | existing-synthetic | SHA256 324a0297c84daba8…; existing synthetic bytes pinned |
| `webapp/tests/fixtures/synthetic.xml` | existing-synthetic | SHA256 595fe364736590dd…; existing synthetic bytes pinned |

- GBA hourly sample is linked by the official samples page; upstream bytes match the existing fixture SHA256. GBA anonymized ApplicationInformation/Authorization/customer/usage test feeds are repository reference inputs; some contain example token/secret-shaped fields and are deliberately **URL-only**, never credentials we use. Usage-Subscription has no IntervalReadings: do not claim it tests a complete import.

- Existing Hydro One/Toronto Hydro/Alectra fragment files are public customer-posted data, not utility-issued schema references. Local SHA256 plus upstream commit/issue-response receipt separates provenance from a mutable URL. The prefixed “stand-in” is not Alectra. Do not commit additional identifiers from those sources.

- Existing bill synthetics reconstruct prior audit totals; new proposed variants must be built from scratch with unrelated arbitrary numbers and example-domain identities. Do not copy Mark’s XML, account/meter IDs, name, real invoice values, secrets or identifying details into a new fixture. No French/other-language utility pattern is invented: preserve unknown notes and test opaque labels as labelled synthetics only.

- Synthetic recipes cover every gap, all pinned enums/classes, mixed commodity/channel/namespace/units, contradictory/missing links, unsafe numeric syntax/multipliers, export and cumulative readings, mixed cadence/gaps/DST, fee credits/unknown labels, power quality, PII isolation, safe unknown extensions and transport paging/202/rotation/revocation. Schema-valid positive cases and deliberately invalid adversarial cases must be labelled separately; a reference fixture is not automatically schema-valid.

## Reconciliation and verification

```sh
python3 docs/greenbutton/verify.py --self-test
```

This offline command re-extracts global declarations, complex/simple types, fields, attributes, bases, cardinalities and enum values directly from **hash-pinned XSD bytes**, and rejects missing/duplicate resource/type/field rows. It checks the function-block union against the pinned enum + source catalogs, each supported feature’s exact executable test title, unsupported phases/acceptance-fixture links, and existing local fixture hashes. It also rejects unknown/unverified FB meanings as role exclusions and reconciles all Markdown FB classifications, subsets, phases and gap IDs against JSON. Its fourteen self-tests cover the original schema mutations/namespace/draft checks plus applicability and Markdown drift regressions. It is **inventory reconciliation**, not schema validation, a fuzz suite or MBP/certification testing; checking source limitations is not a substitute for P0's role/profile review.

Counts include compatibility/draft/Atom rows per snapshot, so the same QName across different versions is counted more than once; do not call them distinct endpoints. Per-schema counts and complete machine inventory are committed. **No Actions billing work is needed or claimed**; only local verification was run. See [verification.json](greenbutton/verification.json) for execution results.

## Decision boundary

PM can assign the gap IDs as build scopes after P0 review, preserving the pinned inventory and acceptance names. No “fully compliant”, “certified” or full-spec support claim is justified by current parser tests, public schema mirrors or this roadmap. Unknown extensions must be reported/preserved where safe; unknown PII/secrets must be quarantined/redacted or explicitly rejected, not indiscriminately saved.

**Verdict: useful electricity subset, substantial typed-resource/CMD gaps; implement P1 correctness and diagnostics before expanding feature coverage, and resolve the gated v4.1 normative delta before any full-spec claim.**
