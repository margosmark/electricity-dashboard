/**
 * ESPI enumerations and the ONE place unit semantics are decided.
 *
 * PROVENANCE — transcribed, never guessed. Every table below is the enumeration
 * list of the NAESB Energy Services Provider Interface (ESPI) namespace schema
 * at https://naesb.org/espi.xsd, whose machine-readable rendering
 * (https://www.greenbuttonalliance.org/usage-data) reports
 * "Schema document for namespace http://naesb.org/espi ... version 3.3.20190408".
 * Retrieved 2026-10-12. Several values are counter-intuitive and MUST NOT be
 * "corrected" by intuition:
 *
 *   - there is NO kWh unit symbol anywhere in ESPI. Kilo-watt-hours is always
 *     uom 72 ("Wh") with powerOfTenMultiplier 3. 73 is VArh (reactive), 71 is
 *     VAh (apparent).
 *   - powerOfTenMultiplier is 10**n applied to the uom, so Hydro One's
 *     `uom=72, powerOfTenMultiplier=-3` means milliwatt-hours, and a raw 3954600
 *     is 3.9546 kWh.
 *   - commodity 1 is "electricity SecondaryMetered"; 7 is natural gas and 9 is
 *     potable water. A water or gas series must never price as electricity.
 *
 * The table is data, not logic: the classification helpers under it are the only
 * code allowed to turn these codes into a quantity, and every caller that
 * normalises a reading goes through them so unit handling cannot drift.
 */

export const UnitSymbolKind = {
  61: "VA",
  38: "W",
  63: "VAr",
  71: "VAh",
  72: "Wh",
  73: "VArh",
  29: "V",
  30: "ohm",
  5: "A",
  25: "F",
  28: "H",
  23: "degC",
  27: "sec",
  159: "min",
  160: "h",
  9: "deg",
  10: "rad",
  31: "J",
  32: "n",
  53: "siemens",
  0: "none",
  33: "Hz",
  3: "g",
  39: "pa",
  2: "m",
  41: "m2",
  42: "m3",
  69: "A2",
  105: "A2h",
  70: "A2s",
  106: "Ah",
  152: "APerA",
  103: "APerM",
  68: "As",
  79: "b",
  113: "bm",
  22: "bq",
  132: "btu",
  133: "btuPerH",
  8: "cd",
  76: "char",
  75: "HzPerSec",
  114: "code",
  65: "cosTheta",
  111: "count",
  119: "ft3",
  120: "ft3compensated",
  123: "ft3compensatedPerH",
  78: "gM2",
  144: "gPerG",
  21: "gy",
  150: "HzPerHz",
  77: "charPerSec",
  130: "imperialGal",
  131: "imperialGalPerH",
  51: "jPerK",
  165: "jPerKg",
  6: "K",
  158: "kat",
  47: "kgM",
  48: "kgPerM3",
  134: "litre",
  157: "litreCompensated",
  138: "litreCompensatedPerH",
  137: "litrePerH",
  143: "litrePerLitre",
  82: "litrePerSec",
  156: "litreUncompensated",
  139: "litreUncompensatedPerH",
  35: "lm",
  34: "lx",
  49: "m2PerSec",
  167: "m3compensated",
  126: "m3compensatedPerH",
  125: "m3PerH",
  45: "m3PerSec",
  166: "m3uncompensated",
  127: "m3uncompensatedPerH",
  118: "meCode",
  7: "mol",
  147: "molPerKg",
  145: "molPerM3",
  146: "molPerMol",
  80: "money",
  148: "mPerM",
  46: "mPerM3",
  43: "mPerSec",
  44: "mPerSec2",
  102: "ohmM",
  155: "paA",
  140: "paG",
  141: "psiA",
  142: "psiG",
  100: "q",
  161: "q45",
  163: "q45h",
  162: "q60",
  164: "q60h",
  101: "qh",
  54: "radPerSec",
  154: "rev",
  4: "revPerSec",
  149: "secPerSec",
  11: "sr",
  109: "status",
  24: "sv",
  37: "t",
  169: "therm",
  108: "timeStamp",
  128: "usGal",
  129: "usGalPerH",
  67: "V2",
  104: "V2h",
  117: "VAhPerRev",
  116: "VArhPerRev",
  74: "VPerHz",
  151: "VPerV",
  66: "Vs",
  36: "wb",
  107: "WhPerM3",
  115: "WhPerRev",
  50: "wPerMK",
  81: "WPerSec",
  153: "WPerVA",
  168: "WPerW",
} as const;

export const UnitMultiplierKind = {
  '-12': "p",
  '-9': "n",
  '-6': "micro",
  '-3': "m",
  '-2': "c",
  '-1': "d",
  3: "k",
  6: "M",
  9: "G",
  12: "T",
  0: "none",
  1: "da",
  2: "h",
} as const;

export const AccumulationKind = {
  0: "none",
  1: "bulkQuantity",
  2: "continuousCumulative",
  3: "cumulative",
  4: "deltaData",
  6: "indicating",
  9: "summation",
  10: "timeDelay",
  12: "instantaneous",
  13: "latchingQuantity",
  14: "boundedQuantity",
} as const;

export const CommodityKind = {
  0: "none",
  1: "electricity SecondaryMetered",
  2: "electricity PrimaryMetered",
  3: "communication",
  4: "air",
  5: "insulativeGas",
  6: "insulativeOil",
  7: "naturalGas",
  8: "propane",
  9: "potableWater",
  10: "steam",
  11: "wasteWater",
  12: "heatingFluid",
  13: "coolingFluid",
  14: "nonpotableWater",
  15: "nox",
  16: "so2",
  17: "ch4",
  18: "co2",
  19: "carbon",
  20: "hch",
  21: "pfc",
  22: "sf6",
  23: "tvLicence",
  24: "internet",
  25: "refuse",
  26: "electricity TransmissionMetered",
} as const;

export const FlowDirectionKind = {
  0: "none",
  1: "forward",
  2: "lagging",
  3: "leading",
  4: "net",
  5: "q1plusQ2",
  7: "q1plusQ3",
  8: "q1plusQ4",
  9: "q1minusQ4",
  10: "q2plusQ3",
  11: "q2plusQ4",
  12: "q2minusQ3",
  13: "q3plusQ4",
  14: "q3minusQ2",
  15: "quadrant1",
  16: "quadrant2",
  17: "quadrant3",
  18: "quadrant4",
  19: "reverse",
  20: "total",
  21: "totalByPhase",
} as const;

export const DataQualifierKind = {
  0: "none",
  2: "average",
  4: "excess",
  5: "highThreshold",
  7: "lowThreshold",
  8: "maximum",
  9: "minimum",
  11: "nominal",
  12: "normal",
  16: "secondMaximum",
  17: "secondMinimum",
  23: "thirdMaximum",
  24: "fourthMaximum",
  25: "fifthMaximum",
  26: "sum",
} as const;

export const QualityOfReading = {
  0: "valid",
  7: "manually edited",
  8: "estimated using reference day",
  9: "estimated using linear interpolation",
  10: "questionable",
  11: "derived",
  12: "projected (forecast)",
  13: "mixed",
  14: "raw",
  15: "normalized for weather",
  16: "other",
  17: "validated",
  18: "verified",
  19: "revenue-quality",
} as const;

export const ServiceKind = {
  0: "electricity",
  1: "gas",
  2: "water",
  3: "time",
  4: "heat",
  5: "refuse",
  6: "sewerage",
  7: "rates",
  8: "tvLicence",
  9: "internet",
} as const;

export const MeasurementKind = {
  0: "none",
  2: "apparentPowerFactor",
  3: "currency",
  4: "current",
  5: "currentAngle",
  6: "currentImbalance",
  7: "date",
  8: "demand",
  9: "distance",
  10: "distortionVoltAmperes",
  11: "energization",
  12: "energy",
  13: "energizationLoadSide",
  14: "fan",
  15: "frequency",
  16: "Funds",
  17: "ieee1366ASAI",
  18: "ieee1366ASIDI",
  19: "ieee1366ASIFI",
  20: "ieee1366CAIDI",
  21: "ieee1366CAIFI",
  22: "ieee1366CEMIn",
  23: "ieee1366CEMSMIn",
  24: "ieee1366CTAIDI",
  25: "ieee1366MAIFI",
  26: "ieee1366MAIFIe",
  27: "ieee1366SAIDI",
  28: "ieee1366SAIFI",
  31: "lineLosses",
  32: "losses",
  33: "negativeSequence",
  34: "phasorPowerFactor",
  35: "phasorReactivePower",
  36: "positiveSequence",
  37: "power",
  38: "powerFactor",
  40: "quantityPower",
  41: "sag",
  42: "swell",
  43: "switchPosition",
  44: "tapPosition",
  45: "tariffRate",
  46: "temperature",
  47: "totalHarmonicDistortion",
  48: "transformerLosses",
  49: "unipedeVoltageDip10to15",
  50: "unipedeVoltageDip15to30",
  51: "unipedeVoltageDip30to60",
  52: "unipedeVoltageDip60to90",
  53: "unipedeVoltageDip90to100",
  54: "voltage",
  55: "voltageAngle",
  56: "voltageExcursion",
  57: "voltageImbalance",
  58: "volume",
  59: "zeroFlowDuration",
  60: "zeroSequence",
  64: "distortionPowerFactor",
  81: "frequencyExcursion",
  90: "applicationContext",
  91: "apTitle",
  92: "assetNumber",
  93: "bandwidth",
  94: "batteryVoltage",
  95: "broadcastAddress",
  96: "deviceAddressType1",
  97: "deviceAddressType2",
  98: "deviceAddressType3",
  99: "deviceAddressType4",
  100: "deviceClass",
  101: "electronicSerialNumber",
  102: "endDeviceID",
  103: "groupAddressType1",
  104: "groupAddressType2",
  105: "groupAddressType3",
  106: "groupAddressType4",
  107: "ipAddress",
  108: "macAddress",
  109: "mfgAssignedConfigurationID",
  110: "mfgAssignedPhysicalSerialNumber",
  111: "mfgAssignedProductNumber",
  112: "mfgAssignedUniqueCommunicationAddress",
  113: "multiCastAddress",
  114: "oneWayAddress",
  115: "signalStrength",
  116: "twoWayAddress",
  117: "signaltoNoiseRatio",
  118: "alarm",
  119: "batteryCarryover",
  120: "dataOverflowAlarm",
  121: "demandLimit",
  122: "demandReset",
  123: "diagnostic",
  124: "emergencyLimit",
  125: "encoderTamper",
  126: "ieee1366MomentaryInterruption",
  127: "ieee1366MomentaryInterruptionEvent",
  128: "ieee1366SustainedInterruption",
  129: "interruptionBehaviour",
  130: "inversionTamper",
  131: "loadInterrupt",
  132: "loadShed",
  133: "maintenance",
  134: "physicalTamper",
  135: "powerLossTamper",
  136: "powerOutage",
  137: "powerQuality",
  138: "powerRestoration",
  139: "programmed",
  140: "pushbutton",
  141: "relayActivation",
  142: "relayCycle",
  143: "removalTamper",
  144: "reprogrammingTamper",
  145: "reverseRotationTamper",
  146: "switchArmed",
  147: "switchDisabled",
  148: "tamper",
  149: "watchdogTimeout",
  150: "billLastPeriod",
  151: "billToDate",
  152: "billCarryover",
  153: "connectionFee",
  154: "audibleVolume",
  155: "volumetricFlow",
} as const;


/* ==========================================================================
 * Classification — the only code that turns a code into a quantity
 *
 * Everything a reading needs to become kWh is decided here from the ReadingType
 * fields alone, so a units bug has exactly one place to live and one place to
 * be pinned by a test. Callers pass `null` for an absent field and get an
 * honest "unspecified"/"unknown" answer instead of a silent default.
 * ========================================================================== */

/** The physical quantity a uom denotes, ignoring scale. */
export type QuantityKind =
  /** Wh, J: billable active energy. */
  | 'active-energy'
  /** VAh — apparent, not billable as consumption. */
  | 'apparent-energy'
  /** VArh — reactive, not billable as consumption. */
  | 'reactive-energy'
  /** W — interval-average real power, convertible with a duration. */
  | 'active-power'
  /** VA — apparent power. */
  | 'apparent-power'
  /** VAr — reactive power. */
  | 'reactive-power'
  /** sec, code, money, count, status … a value that is simply not an amount of energy. */
  | 'non-quantity'
  /** A defined unit this app has no conversion for (btu, therm, ft3, litre …). */
  | 'other-quantity'
  /** Not in the schema (or absent). Never guessed at. */
  | 'unknown';

const ACTIVE_ENERGY_UOM = new Set<number>([72 /* Wh */, 31 /* J */]);
const APPARENT_ENERGY_UOM = new Set<number>([71 /* VAh */]);
const REACTIVE_ENERGY_UOM = new Set<number>([73 /* VArh */]);
const ACTIVE_POWER_UOM = new Set<number>([38 /* W */]);
const APPARENT_POWER_UOM = new Set<number>([61 /* VA */]);
const REACTIVE_POWER_UOM = new Set<number>([63 /* VAr */]);

/**
 * uom 80 — ESPI's "money". A bill line's `<measurement>` naming this unit is
 * the file stating the power of ten it scales its OWN figures by (Enbridge Gas
 * sends milli-dollars: `powerOfTenMultiplier -3`), which is why energy.ts
 * derives a bill amount's scale from the line instead of assuming the
 * schema's hundred-thousandths default.
 */
export const MONEY_UOM = 80;

/**
 * Non-quantity units: they carry a measurement but never an amount of energy,
 * so a series declaring one is a summary/telemetry series, not usage.
 */
const NON_QUANTITY_UOM = new Set<number>([
  0, // none
  27, // sec
  114, // code
  109, // status
  108, // timeStamp
  MONEY_UOM, // money
  111, // count
  76, // char
  77, // charPerSec
  118, // meCode
]);

export function quantityKindOf(uom: number | null | undefined): QuantityKind {
  if (uom === null || uom === undefined || !Number.isFinite(uom)) return 'unknown';
  const code = Math.trunc(uom);
  if (ACTIVE_ENERGY_UOM.has(code)) return 'active-energy';
  if (APPARENT_ENERGY_UOM.has(code)) return 'apparent-energy';
  if (REACTIVE_ENERGY_UOM.has(code)) return 'reactive-energy';
  if (ACTIVE_POWER_UOM.has(code)) return 'active-power';
  if (APPARENT_POWER_UOM.has(code)) return 'apparent-power';
  if (REACTIVE_POWER_UOM.has(code)) return 'reactive-power';
  if (NON_QUANTITY_UOM.has(code)) return 'non-quantity';
  // A defined unit this app does not convert (or a value the schema does not
  // define). The two cases are distinguished for the diagnostic text only.
  return (UnitSymbolKind as Record<number, string>)[code] !== undefined
    ? 'other-quantity'
    : 'unknown';
}

export function uomName(uom: number | null | undefined): string {
  if (uom === null || uom === undefined) return 'no uom';
  const name = (UnitSymbolKind as Record<number, string>)[Math.trunc(uom)];
  return name ? `${name} (uom ${Math.trunc(uom)})` : `uom ${Math.trunc(uom)} (undefined by the schema)`;
}

/* ==========================================================================
 * Magnitude bounds — what ONE interval reading can physically be
 * ========================================================================== */

/**
 * The most energy ONE interval reading can carry, in kWh.
 *
 * A 15-minute household interval is ~0.1 kWh and a large industrial site's
 * hourly interval is ~10^4 kWh, so 10^6 kWh — a gigawatt-hour inside a single
 * interval — sits ~5 orders of magnitude above anything a meter can publish.
 *
 * Why a bound at all, when the arithmetic is already checked: a huge but
 * FINITE value is not a `NaN` that trips a guard, it is a plausible-looking
 * number that poisons everything downstream. 2000 × `<value>1e308</value>` (a
 * 210 099-byte document) sums to `Infinity`, so every total, every `fmtKwh`
 * and every average on the page is lost; and each individual 1e305 passes
 * `Number.isFinite` in `storage.ts`/`backup.ts`, so the poison is persisted
 * and re-validated as legitimate. The ingest gate refuses it here.
 */
export const MAX_INTERVAL_KWH = 1e6;

/**
 * The longest span ONE interval reading can describe, in seconds (366 days).
 * Anything longer is not an interval: it is a mis-parsed register span or a
 * hostile number that scales a power reading into nonsense (a 1e150 W reading
 * over 1e150 s is 2.78e293 kWh).
 */
export const MAX_INTERVAL_SECONDS = 366 * 24 * 3600;

/**
 * `10 ** n` for a multiplier that yields a usable factor, else `null`.
 *
 * Not stated (null/undefined) is 10^0 = 1. A multiplier that IS stated but
 * whose power of ten overflows to `Infinity` (309 upwards) or underflows to
 * `0` (-400) is not a factor at all, and is refused here rather than at each
 * caller: `0 * Infinity` is `NaN`, and a zero factor would silently zero a
 * whole series' usage.
 */
export function multiplierFactor(multiplier: number | null | undefined): number | null {
  if (multiplier === null || multiplier === undefined) return 1;
  if (!Number.isFinite(multiplier)) return null;
  const factor = 10 ** Math.trunc(multiplier);
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

export function multiplierName(multiplier: number | null | undefined): string {
  if (multiplier === null || multiplier === undefined) return 'unspecified multiplier';
  const name = (UnitMultiplierKind as Record<number, string>)[Math.trunc(multiplier)];
  return name && name !== 'none'
    ? `${name} (10^${Math.trunc(multiplier)})`
    : `10^${Math.trunc(multiplier)}`;
}

/**
 * Raw reading → kWh for an ACTIVE ENERGY series (Wh, J). Returns null for every
 * other quantity: an apparent/reactive/power value is not an amount of energy
 * and must be refused here rather than silently priced.
 *
 * Finiteness only: whether the resulting number is physically possible is the
 * ingest gate's decision ({@link MAX_INTERVAL_KWH}), so the physical bound
 * lives in exactly one place.
 */
export function energyKwhFromRaw(
  raw: number,
  uom: number | null | undefined,
  multiplier: number | null | undefined,
): number | null {
  if (!Number.isFinite(raw)) return null;
  const kind = quantityKindOf(uom);
  if (kind !== 'active-energy') return null;
  const factor = multiplierFactor(multiplier);
  if (factor === null) return null;
  const perKwh = Math.trunc(uom as number) === 31 ? 3_600_000 : 1000; // J vs Wh
  const kwh = (raw * factor) / perKwh;
  return Number.isFinite(kwh) ? kwh : null;
}

/**
 * The LEGACY compatibility conversion: a document that declares no ReadingType
 * at all. Its values are read as watt-hours scaled by one document-wide
 * multiplier, which is an assumption the caller must announce — never a
 * declaration the feed made. Kept here so even the compatibility path's
 * arithmetic lives in the units module.
 */
export function legacyWhKwhFromRaw(
  raw: number,
  multiplier: number | null | undefined,
): number | null {
  if (!Number.isFinite(raw)) return null;
  const factor = multiplierFactor(multiplier);
  if (factor === null) return null;
  const kwh = (raw * factor) / 1000;
  return Number.isFinite(kwh) ? kwh : null;
}

/**
 * Wh a reading of an interval-average ACTIVE POWER series stands for, given the
 * interval it was measured over. `uom=38` with a watt value is real power; the
 * energy it represents is P × Δt because the meter reports the average over the
 * interval. Without a positive duration there is no answer, so this returns null
 * (the caller then reports the series as unsupported rather than inventing one).
 *
 * A duration beyond {@link MAX_INTERVAL_SECONDS} is not an interval either, and
 * is refused rather than allowed to scale a power reading into nonsense.
 */
export function energyKwhFromIntervalPower(
  raw: number,
  uom: number | null | undefined,
  multiplier: number | null | undefined,
  durationSeconds: number | null | undefined,
): number | null {
  if (!Number.isFinite(raw)) return null;
  if (quantityKindOf(uom) !== 'active-power') return null;
  if (durationSeconds === null || durationSeconds === undefined) return null;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  if (durationSeconds > MAX_INTERVAL_SECONDS) return null;
  const factor = multiplierFactor(multiplier);
  if (factor === null) return null;
  const kwh = (raw * factor * durationSeconds) / 3600 / 1000;
  return Number.isFinite(kwh) ? kwh : null;
}

/**
 * How a series' values accumulate over time (ESPI AccumulationKind).
 *
 * `summation` (9) is deliberately classified with the registers, NOT as an
 * interval increment. ESPI v4.0 (`naesb.org/espi.xsd`, 4.0.20231213, REQ.21)
 * defines it as "A form of accumulation which is selective with respect to
 * time", and its own note places it in the register family by inheritance:
 * "'Summation' could be considered a specialization of 'Bulk Quantity'
 * according to the rules of inheritance where 'Summation' selectively
 * accumulates pulses over a timing pattern, and 'BulkQuantity' accumulates
 * pulses all of the time." BulkQuantity (1) is a dial-reading register and is
 * refused, so a cumulative pulse register carrying 9 must be refused too:
 * pricing it as a per-interval increment is exactly the register-summing
 * failure this resolver exists to make impossible. Refusing is announced as an
 * `unsupported-series` diagnostic, never a silent drop. Every feed in evidence
 * uses 4 deltaData (both owner exports and the Hydro One fixture), so this
 * costs nothing observed; a real 9-valued interval feed must prove the interval
 * reading before 9 may move into INTERVAL_ACCUMULATION.
 */
export type AccumulationClass =
  /** An increment for this interval: 0/absent (implied by the uom), 4 deltaData. */
  | 'interval'
  /** A register reading (1/2/3/9/13/14): adding them up produces nonsense, not consumption. */
  | 'register'
  /** A spot value with no interval meaning (indicating / instantaneous / timeDelay). */
  | 'spot'
  | 'unknown';

const INTERVAL_ACCUMULATION = new Set<number>([0, 4]);
// 9 summation joins the register class on purpose — see the type doc above.
const REGISTER_ACCUMULATION = new Set<number>([1, 2, 3, 9, 13, 14]);
const SPOT_ACCUMULATION = new Set<number>([6, 10, 12]);

export function accumulationClassOf(ab: number | null | undefined): AccumulationClass {
  if (ab === null || ab === undefined) return 'interval'; // ESPI: "Not Applicable or implied by the unit of measure"
  const code = Math.trunc(ab);
  if (INTERVAL_ACCUMULATION.has(code)) return 'interval';
  if (REGISTER_ACCUMULATION.has(code)) return 'register';
  if (SPOT_ACCUMULATION.has(code)) return 'spot';
  return 'unknown';
}

export function accumulationName(ab: number | null | undefined): string {
  if (ab === null || ab === undefined) return 'unspecified accumulationBehaviour';
  const name = (AccumulationKind as Record<number, string>)[Math.trunc(ab)];
  return name ? `${name} (${Math.trunc(ab)})` : `accumulationBehaviour ${Math.trunc(ab)}`;
}

/** Which way the energy flowed (ESPI FlowDirectionKind), coarsely. */
export type FlowClass = 'forward' | 'reverse' | 'net' | 'total' | 'quadrant' | 'unspecified';

/**
 * 1 forward is "delivered/imported"; 19 reverse is "received/exported". Every
 * quadrant/aggregate code (4 net, 20 total, 5-18, 21) combines directions and
 * cannot be added to a consumption total at all.
 */
export function flowClassOf(fd: number | null | undefined): FlowClass {
  if (fd === null || fd === undefined) return 'unspecified';
  const code = Math.trunc(fd);
  if (code === 1) return 'forward';
  if (code === 19) return 'reverse';
  if (code === 4) return 'net';
  if (code === 20 || code === 21) return 'total';
  if (code >= 5 && code <= 18) return 'quadrant';
  return 'unspecified';
}

export function flowName(fd: number | null | undefined): string {
  if (fd === null || fd === undefined) return 'unspecified flowDirection';
  const name = (FlowDirectionKind as Record<number, string>)[Math.trunc(fd)];
  return name ? `${name} (${Math.trunc(fd)})` : `flowDirection ${Math.trunc(fd)}`;
}

/** Which commodity a series measures (ESPI CommodityKind). */
export type CommodityClass = 'electricity' | 'gas' | 'water' | 'steam' | 'other' | 'unspecified';

const ELECTRICITY_COMMODITY = new Set<number>([1 /* electricity SecondaryMetered */, 2 /* electricity PrimaryMetered */, 26 /* electricity TransmissionMetered */]);
const GAS_COMMODITY = new Set<number>([5, 6, 7, 8, /* insulativeGas, insulativeOil, naturalGas, propane */]);
const WATER_COMMODITY = new Set<number>([9, 11, 14 /* potableWater, wasteWater, nonpotableWater */]);

export function commodityClassOf(commodity: number | null | undefined): CommodityClass {
  if (commodity === null || commodity === undefined) return 'unspecified';
  const code = Math.trunc(commodity);
  if (code === 0) return 'unspecified'; // "none" — the feed did not say
  if (ELECTRICITY_COMMODITY.has(code)) return 'electricity';
  if (GAS_COMMODITY.has(code)) return 'gas';
  if (WATER_COMMODITY.has(code)) return 'water';
  if (code === 10) return 'steam';
  return 'other';
}

export function commodityName(commodity: number | null | undefined): string {
  if (commodity === null || commodity === undefined) return 'unspecified commodity';
  const name = (CommodityKind as Record<number, string>)[Math.trunc(commodity)];
  return name ? `${name} (${Math.trunc(commodity)})` : `commodity ${Math.trunc(commodity)}`;
}

/** ESPI `kind` (MeasurementKind) 12 is energy, 8 demand, 37 power, 38 power factor. */
export function measurementName(kind: number | null | undefined): string {
  if (kind === null || kind === undefined) return 'unspecified kind';
  const name = (MeasurementKind as Record<number, string>)[Math.trunc(kind)];
  return name ? `${name} (${Math.trunc(kind)})` : `kind ${Math.trunc(kind)} (undefined by the schema)`;
}

export const ENERGY_MEASUREMENT_KIND = 12;
export const DEMAND_MEASUREMENT_KIND = 8;
export const POWER_MEASUREMENT_KIND = 37;

export function qualityName(quality: number | null | undefined): string {
  if (quality === null || quality === undefined) return 'unspecified quality';
  const name = (QualityOfReading as Record<number, string>)[Math.trunc(quality)];
  return name ? `${name} (${Math.trunc(quality)})` : `quality ${Math.trunc(quality)}`;
}

/** ESPI `dataQualifier` (DataQualifierKind) — a separate enumeration from QualityOfReading. */
export function dataQualifierName(qualifier: number | null | undefined): string {
  if (qualifier === null || qualifier === undefined) return 'unspecified dataQualifier';
  const name = (DataQualifierKind as Record<number, string>)[Math.trunc(qualifier)];
  return name ? `${name} (${Math.trunc(qualifier)})` : `dataQualifier ${Math.trunc(qualifier)}`;
}
