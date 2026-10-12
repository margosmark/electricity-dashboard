/**
 * The display layer for a UsagePoint group's HEADING — the row label a French
 * reader sees in the picker and in the multi-file merge review.
 *
 * WHY THIS EXISTS
 * `lib/energy.ts` composes each group's label in English, because the parser
 * has no locale:
 *
 *     label: id ? `UsagePoint ${id.slice(0, 8)}` : 'Meter',
 *
 * Both render sites painted it verbatim — `UsagePointPicker`'s
 * `<span>{group.label}</span>` and `MultiFileMerge`'s meter radio row — so on
 * the French page a point the file never identified read as the English word
 * `Meter`, and the identified one read as `UsagePoint <id>` with no French
 * frame (t_203c6445). It is defect class 2 in I18N.md's runtime-gate list: a
 * canonical constant printed where a translated label belongs.
 *
 * The fix keeps both ends honest, the same way `@/i18n/seriesNote` does for the
 * sentences the parser composes:
 *
 *   • the LIB keeps `UsagePointGroup.label` — the English value tests assert
 *     and the value the picker printed until now;
 *   • this module maps the group onto the catalog key its label belongs to.
 *     `group.id` is the whole discriminator: '' means the document identified
 *     no UsagePoint, which is its own sentence ("Meter" · "Compteur"), and a
 *     non-empty id is the canonical ESPI resource name plus the file's own id
 *     — data, per I18N.md's canonical list — shortened exactly as the English
 *     label shortens it (`POINT_LABEL_ID_LENGTH`, imported from the lib so the
 *     two compositions cannot drift).
 *
 * `usagePointLabel()` is the ONE place a group becomes a heading. It falls back
 * to `group.label` when the catalog lacks the key, so a group can never reach
 * the screen as a raw catalog key — and `usagePointLabel.test.ts` pins the
 * English rendering byte for byte against `group.label`, so the English page
 * cannot quietly change wording while the fallback silently goes stale.
 */

import { POINT_LABEL_ID_LENGTH, type UsagePointGroup } from '@/lib/energy';
import { catalogHas, type Translate } from './seriesNote';

/** A point the file identified: canonical resource name + its own id. */
export const POINT_LABEL_KEY = 'gbseries.point.label';

/**
 * A point the file never identified — the picker's word for "a meter with no
 * id in the feed".
 *
 * NOT `gbseries.pointUnidentified`: that key is the `(unidentified)`
 * parenthetical a `SeriesNote` prints in its `{point}` slot mid-sentence, not a
 * heading. Same situation, two different registers, so two keys.
 */
export const POINT_LABEL_UNIDENTIFIED_KEY = 'gbseries.point.unidentified';

/** Everything this module needs of a group: what the lib composed. */
export type LabelledPoint = Pick<UsagePointGroup, 'id' | 'label'>;

/**
 * The group's heading, in the reader's language — or its canonical English
 * `label` when the catalog defines no key for it. Never a raw key.
 */
export function usagePointLabel(group: LabelledPoint, t: Translate): string {
  const key = group.id ? POINT_LABEL_KEY : POINT_LABEL_UNIDENTIFIED_KEY;
  if (!catalogHas(key)) return group.label;
  return group.id
    ? t(key, { id: group.id.slice(0, POINT_LABEL_ID_LENGTH) })
    : t(key);
}
