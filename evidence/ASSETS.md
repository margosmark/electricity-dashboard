# Evidence screenshots: where the pixels are

Changed 2026-10-11 (card t_1f93f985). Before it, every verification wave
committed its screenshots straight to `main` — ~10 PNGs per wave, plus the
multi-megabyte full-page captures. The numbers that made that untenable:

- 182 screenshot files (PNG/JPG) were tracked on `main`, 69.7 MB of working tree.
- Across all of git history, evidence screenshots are 98.8 MB of the 130.2 MB
  of blob bytes the repo has ever held (76%). `.git` had grown to 114 MB
  locally, 94 MB on GitHub.
- The single biggest offender was one file's history: `wave-p-desktop-full.png`
  exists at 4+ MB in three separate versions.

## The rule now

`main` tracks the **records** of a wave, never the **pixels**:

| tracked on main                | never again on main          |
| ------------------------------ | ---------------------------- |
| `*-verification*.json` results | `*.png` screenshots          |
| `*-notes.md` write-ups         | `*.jpg` / `*.jpeg` captures  |
| `*-verify.cjs` harnesses       | `*.webp`                     |
| the CSV/PDF artifacts          |                              |

`.gitignore` enforces it (`evidence/**/*.png` etc.), so a verify script
writing its screenshots leaves `git status` clean — no more
"restore the PNGs before committing" dance.

## Where the pixels live

**Release asset `evidence-screenshots-2026-10-11`** — every screenshot, 197
files (the original 182 plus the 15 dark-mode-wave shots folded in during
the history prune) zipped with a `MANIFEST.sha256`, stored outside the git
object store entirely (release assets don't count against repo size and
survive branch rewrites):

```sh
gh release download evidence-screenshots-2026-10-11 -p evidence-screenshots.zip
unzip evidence-screenshots.zip -d evidence-screenshots
(cd evidence-screenshots && sha256sum -c MANIFEST.sha256)
```

The `evidence-assets` branch that used to hold the same pixels was dropped
in the history prune below — the zip is the store, and it was verified
complete (197/197 against the manifest) against the pre-prune branch before
the branch went away.

## Archiving a new wave's screenshots

The verify harnesses still write PNGs into `evidence/`; they are simply
ignored by `main` now. Never commit them — fold them into the release zip
from the working tree:

```sh
gh release download evidence-screenshots-2026-10-11 -p evidence-screenshots.zip
unzip -q evidence-screenshots.zip -d evidence-screenshots
cp evidence/<wave>*.png evidence-screenshots/evidence/          # new shots in
(cd evidence-screenshots \
  && find evidence -type f \( -name '*.png' -o -name '*.jpg' \) | LC_ALL=C sort \
     | xargs sha256sum > MANIFEST.sha256 \
  && rm -f ../evidence-screenshots.zip && zip -qr ../evidence-screenshots.zip evidence MANIFEST.sha256)
gh release upload evidence-screenshots-2026-10-11 evidence-screenshots.zip --clobber
```

When a batch deserves its own immutable copy instead, cut a dated release
(`gh release create evidence-screenshots-<date> evidence-screenshots.zip`)
and note the new `MANIFEST.sha256` in this file.

## History prune (run 2026-10-11, card t_a66aa790)

Executed as a coordinated force-push while the board was quiet (Mark's go:
the card's 19:56 unblock of the two-conditions block):

- Mirror clone + `git filter-repo --invert-paths` stripped
  `evidence/**/*.png|jpg` and the `electricit2024-now.xml` real-meter
  export from **every** ref — local branches included (each sibling
  worktree was removed first and re-added from the rewritten history, so
  no branch sits on unrelated histories).
- All 50 branch/tag refs force-pushed; `main` 635f148 → 7ba18c9 (identical
  trees — only history SHAs moved).
- Blob bytes the repo has ever held: **135.6 MB → 26.2 MB** in a fresh
  clone (−81%); `.git` in the shared checkout 114 MB → 3.6 MB.
- The `evidence-assets` branch was dropped at the same time; before it
  went, its 15 post-release dark-mode shots were folded into the release
  zip (now 197/197 verified against `MANIFEST.sha256`, re-download
  byte-identical).
- Gate re-run green on a fresh clone of the rewritten history: vitest
  1231 passed | 6 skipped (1237), eslint + tsc + `next build` clean.
- Caveat: GitHub's hidden `refs/pull/N/head` refs for the 65 merged PRs
  still pin the pre-rewrite commits (the API answers `refs/pull/* is
  read-only`), so the GitHub repo-size metric falls only after GitHub-side
  GC touches them — watch `.size`, open a support ticket if it sticks.
  Open PR #28 re-synced to the rewritten branch automatically.
