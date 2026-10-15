/**
 * The RECOVERY-MESSAGE contract: one implementation of what the app tells a
 * user whose Green Button document it will not import.
 *
 * WHY THIS EXISTS
 * Three surfaces turn a failed ingestion into text — `/import`'s error box,
 * the Link Data upload modal, and the live-sync toolbar — and each one had
 * its own catch block. Owning the conversion in one place is what makes the
 * guarantees below testable for EVERY document at once (see
 * `hostileCorpus.ts`, which runs this over a hostile-XML corpus in both
 * locales):
 *
 *  1. It is always a message. There is no input for which the app shrugs:
 *     the result carries a headline, a detail and at least one hint.
 *  2. It is always OURS. Every part is composed from the i18n catalog at
 *     call time, so the fr page shows French and a library string —
 *     `readTagExp returned undefined at position 276`, the validator's
 *     `Invalid '[    "feed"]' found.`, fast-xml-parser's `Maximum nested
 *     tags exceeded` — can never be the thing the user reads. The sync
 *     toolbar used to show the bare token `unparseable` for exactly this
 *     case (describeGbError's default branch echoes its code).
 *  3. A refusal shows ITSELF. A `GreenButtonRefusal` already carries
 *     copy translated where it was raised, including the numbers it judged;
 *     re-explaining it as "could not read this file" would throw away the
 *     one message that names the actual reason.
 *  4. It says what to do next: `hints` is never empty, because a refusal
 *     that leaves the reader with no action is just bad news.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: echo the failure. `error.message` is
 * written by the parser, in English, for a developer — the raw-text
 * diagnosis in `parseDiagnostic.ts` can usually explain the SAME document
 * better, and when it cannot (the file is well-formed and still failed) the
 * generic sentence above is more honest than a stack trace.
 */

import { t } from '@/i18n';
import { diagnoseGreenButtonDocument, type ParseDiagnostic } from '@/lib/parseDiagnostic';
import { isGreenButtonRefusal } from './limits';

/** What every surface renders: the failure half of a `ParseDiagnostic`. */
export type RecoveryMessage = Extract<ParseDiagnostic, { ok: false }>;

export type RecoveryInput = {
  /** The exact document that failed — the diagnosis inspects it raw. */
  text: string;
  /** The failure the surface caught, when anything was thrown. */
  error?: unknown;
  /** Rows the parser produced before failing (0 when it produced none). */
  readings?: number;
  /** Name of the file the text came from, when it came from one. */
  fileName?: string;
};

/**
 * Explain a failed ingestion. Pure with respect to its input, but locale-
 * dependent by design: the copy is read through `t()` at call time, so a
 * message built after a language switch is in the new language (and a
 * `useMemo` holding one must list `t` in its deps — see I18N.md).
 */
export function recoveryMessage({ text, error, readings = 0, fileName }: RecoveryInput): RecoveryMessage {
  if (isGreenButtonRefusal(error)) {
    return { ok: false, headline: error.headline, detail: error.detail, hints: error.hints };
  }

  const diag = diagnoseGreenButtonDocument(text, readings);
  if (!diag.ok) return diag;

  // The document is structurally sound and the app still could not use it —
  // the one case the raw-text diagnosis cannot explain, because nothing is
  // wrong with the TEXT. There is no honest narrower sentence to reach for
  // (claiming "no readings" when rows exist, or quoting the exception, would
  // both be wrong), so the generic one says what happened and the only action
  // that helps. Unreachable from today's three call sites — every one of them
  // passes `readings: 0`, which the diagnosis already explains — and kept
  // honest by construction for whoever calls it next.
  return {
    ok: false,
    headline: fileName ? t('upload.couldNotRead', { name: fileName }) : t('upload.couldNotReadPlain'),
    detail: t('upload.parserFailedDetail'),
    hints: [t('upload.redownloadHint')],
  };
}
