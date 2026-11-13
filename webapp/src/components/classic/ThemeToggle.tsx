/**
 * Dark mode — the Light / Dark / System control (spec §3.1).
 *
 * A `role="radiogroup"` of three `role="radio"` buttons, NOT a cycling
 * single button. Three states behind one button is an ARIA anti-pattern: it
 * offers no direct access to each state and nothing per-option to announce,
 * and this codebase already treats toggle-state honesty as a standing gate
 * (the plan switcher drops its aria-label for the same reason — see
 * Dashboard.tsx:690). Here each option IS a real radio with `aria-checked`,
 * so a screen reader hears "Dark, radio, 2 of 3" instead of a button whose
 * label cannot describe three states.
 *
 * Sits in toolbar row 2 immediately after `LocaleToggle`, because the
 * language of the answer and the appearance of the answer both belong with
 * the answer — the "preferences" cluster. It is a sibling of LocaleToggle in
 * the same flex row, so if Wave U ever moves the language toggle this moves
 * with it for free.
 *
 * Styling reuses the row's existing chip grammar — `border-edge`,
 * `shadow-hard-4`, `rounded-xl` — and lucide icons at strokeWidth 4 like the
 * tab icons. No new iconography dialect: ☀ Light / ☾ Dark / 🖥 System.
 */

'use client';

import React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useTheme, type ThemeMode } from '@/lib/theme';

/** The three options, in the order they are rendered. */
const OPTIONS: readonly { mode: ThemeMode; icon: typeof Sun; labelKey: string }[] = [
  { mode: 'light', icon: Sun, labelKey: 'theme.light' },
  { mode: 'dark', icon: Moon, labelKey: 'theme.dark' },
  { mode: 'system', icon: Monitor, labelKey: 'theme.system' },
];

export default function ThemeToggle() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();

  /**
   * Roving focus: the active radio is the tab stop, arrows move between
   * options. `Home`/`End` jump to the ends — the standard radiogroup
   * contract, and the reason this is a group rather than three unrelated
   * buttons in the tab order.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = OPTIONS.findIndex((o) => o.mode === theme);
    let next = index;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % OPTIONS.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + OPTIONS.length) % OPTIONS.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = OPTIONS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = OPTIONS[next].mode;
    // Arrow keys in a radiogroup MOVE SELECTION (and focus with it) — that is
    // the pattern, and it is why this is a group rather than three unrelated
    // buttons in the tab order. Only one radio is ever the tab stop.
    setTheme(target);
    event.currentTarget
      .querySelectorAll<HTMLButtonElement>('[role="radio"]')
      [next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={t('theme.group')}
      data-testid="theme-toggle"
      data-theme-mode={theme}
      onKeyDown={onKeyDown}
      className="no-print inline-flex items-center border-4 border-edge rounded-xl md:rounded-2xl overflow-hidden shadow-hard-4 bg-card"
    >
      {OPTIONS.map(({ mode, icon: Icon, labelKey }) => {
        const active = theme === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            data-theme-option={mode}
            // Roving tabindex: the group is ONE tab stop and arrows move the
            // selection, which is how a radiogroup is meant to behave. Three
            // stops would make keyboard users tab past three controls that
            // all do the same thing.
            tabIndex={active ? 0 : -1}
            // min-h-11/min-w-11 = 44px — the standing hit-box floor.
            onClick={() => setTheme(mode)}
            className={
              'inline-flex min-h-11 min-w-11 items-center justify-center gap-1 px-2 md:px-2.5 py-2 font-black uppercase text-[10px] transition-colors ' +
              (active
                ? 'bg-accent text-accent-ink'
                : 'bg-card text-ink-2 hover:bg-hover')
            }
          >
            <Icon size={16} strokeWidth={4} aria-hidden="true" />
            {/* The label is ALWAYS visible, on every segment, in both
                themes — it is the option's name, and a radio group reads
                best when each option names itself. It also happens to be the
                narrower row: hiding the inactive labels made the ACTIVE one
                carry its word while the group shrank, and the resulting
                191px chip pushed row 2 past the toolbar gate's 1px
                sideways-scroll budget at 1024 (see the gate's own comment —
                1024 is the width that decides whether row 2 wraps).
                The chip's WIDTH is a real budget item: row 2 is
                billing-day + plan switcher + locale + theme + the floor
                button, and the gate fails if the floor button has to wrap
                (a 45,000px² dead band opens on its left). Labels at 10px
                with 8px side padding keep the group at ~230px, which is what
                lets all five fit on one line from 1279px up. */}
            <span>{t(labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Exported for the tests that assert the option list matches the store. */
export { OPTIONS as THEME_OPTIONS };
