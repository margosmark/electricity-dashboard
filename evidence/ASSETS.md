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

1. **Branch `evidence-assets`** — every screenshot ever committed, at its
   original path, one archive commit plus one commit per later wave:

   ```sh
   git show evidence-assets:evidence/wave-t-desktop-plans.png > /tmp/out.png
   # or browse: https://github.com/margosmark/electricity-dashboard/blob/evidence-assets/evidence/…
   ```

2. **Release asset `evidence-screenshots-2026-10-11`** — the same 182 files
   zipped with a `MANIFEST.sha256`, stored outside the git object store
   entirely (release assets don't count against repo size and survive any
   branch rewrite).

## Archiving a new wave's screenshots

The verify harnesses still write PNGs into `evidence/`; they are simply
ignored by `main` now. To archive them after a wave lands:

```sh
git worktree add ../evidence-assets-wt evidence-assets   # once
cp evidence/<wave>*.png evidence/<wave-dir>/*.jpg ../evidence-assets-wt/evidence/ 2>/dev/null
cd ../evidence-assets-wt
git add evidence && git commit -m "evidence: <wave> screenshots" && git push origin evidence-assets
```

and, when a batch is worth a durable external copy, refresh the release zip:

```sh
cd ../evidence-assets-wt && zip -r /tmp/evidence-screenshots.zip evidence -i '*.png' '*.jpg'
gh release upload evidence-screenshots-2026-10-11 /tmp/evidence-screenshots.zip --clobber
```

## History prune (not yet run)

Stripping the already-committed 98.8 MB out of `main`'s history is a
**force-push rewrite** of every branch, and on 2026-10-11 sibling cards had
live worktrees mid-task (dark-mode, truth-in-ui, list_dark) — a rewrite
would have stranded them on unrelated histories. The runbook (mirror clone,
`git filter-repo` on `evidence/**.png|jpg` + the `electricit2024-now.xml`
real-meter blob from the initial commit, coordinated force-push of all refs)
is on card t_1f93f985's follow-up; run it only while the board is quiet.
Note the images branch must be dropped at the same time for the GitHub repo
size to actually fall — the release zip is what keeps that lossless.
