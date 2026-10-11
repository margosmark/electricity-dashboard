/**
 * Dark mode — the FOUC guard (spec §3.1).
 *
 * This file lives in `public/` and is served VERBATIM, so it runs as plain
 * ES5 with no build step and no React. It must decide the theme before first
 * paint, which rules out any React effect: by the time hydration runs, a
 * dark-mode user has already seen a white page.
 *
 * Why an external file rather than the spec's inline `<script>` in <head>:
 * two things the spec could not have known when it was written.
 *
 *  1. Next's app router does not render a user-authored <head>. The inline
 *     script the spec asks for is silently dropped — measured against the
 *     real build output, it never reached the served HTML at all.
 *  2. `src/lib/security.test.tsx` forbids `dangerouslySetInnerHTML` in every
 *     source file. That gate is correct and this change must not weaken it.
 *
 * A static file in `public/` sidesteps both: layout.tsx renders it with a
 * plain `<script src async>` inside the app router's own <head>, which Next
 * hoists into the real <head> of the served document (measured at offset
 * ~1258, well before <body> at ~2330), and it contains no JSX sink to trip
 * the gate. `async` is load-bearing — see the note in layout.tsx.
 *
 * It must stay dependency-free ES5: no imports, no optional chaining, no
 * `const`. It runs before the bundle on every cold load, including the PWA
 * relaunch path where the shell comes from cache and React mounts late.
 *
 * Resolution rule — identical to `lib/theme.ts`, which owns the same logic
 * for the live subscription:
 *   - an explicit 'light' or 'dark' in localStorage wins outright;
 *   - anything else ('system', the DEFAULT, or a storage failure) defers to
 *     `prefers-color-scheme`.
 *
 * Only two things are written: `data-theme` (the single switch the CSS reads)
 * and `style.colorScheme` (which the OS chrome and form controls follow). No
 * colour is computed here — it only picks a name.
 */
(function () {
  var mode = null;
  try {
    // Private mode and quota failures land here: stay on the OS preference
    // rather than failing the whole page over a colour.
    mode = window.localStorage.getItem('theme');
    // The binding is named (and then ignored) because optional catch binding
    // is ES2019 and this file is committed as ES5 — see the header.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (e) {
    mode = null;
  }

  var dark =
    mode === 'dark' ||
    (mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  var resolved = dark ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.style.colorScheme = resolved;
})();
