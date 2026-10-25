#!/usr/bin/env node
/**
 * Proof that this card changed NOTHING that could activate an account.
 *
 * The card's hard constraint: `ACCT_ENABLED`, `ACCT_EMAIL_VERIFICATION_ENABLED`
 * and the SMTP configuration must be byte-identical before and after. This
 * script proves it from the repository itself rather than from a claim:
 *
 *   BEFORE = the merge base this branch was cut from (`--base`, default
 *            `origin/main`) — the state of the world before any of this
 *            card's commits existed.
 *   AFTER  = the working tree as it sits right now, including uncommitted
 *            files, so a half-staged edit cannot hide from it.
 *
 * For each of the two flags it records:
 *   - every line that DEFINES the flag (a file where the value is chosen),
 *     not every line that mentions it in prose;
 *   - the sha256 of each such file at BEFORE and AFTER, so the proof is
 *     byte-level, not eyeball-level;
 *   - whether an untracked `.env` exists that could override the default
 *     (a docker-compose `${VAR:-false}` default is only the default when no
 *     `.env` supplies a value — an override file would make the line look
 *     unchanged while the effective value moved).
 *
 * SMTP is asserted the same way, without reading a single SMTP value out:
 * the script hashes the file that holds the SMTP block and reports only
 * "same"/"different". Host, port, sender, credential and mount paths are
 * never printed, per the card's no-credentials rule.
 *
 * Usage:  node evidence/account-preflight-flags-verify.cjs [--base <ref>]
 * Out:    evidence/account-preflight-flags-verification.json
 * Exit:   0 only when every value is unchanged.
 */

"use strict";

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, "account-preflight-flags-verification.json");

/** The two flags the card names, verbatim. */
const FLAGS = ["ACCT_ENABLED", "ACCT_EMAIL_VERIFICATION_ENABLED"];

/**
 * Files that can CHOOSE a value for these flags. Comments and prose are
 * excluded by requiring an assignment shape (`FLAG:`, `FLAG=`, `export FLAG=`),
 * so a doc that merely mentions `ACCT_ENABLED` is not treated as a definition.
 */
const DEFINING_FILES = [
  "docker-compose.yml",
  "ops/edge/topology-test.compose.yml",
  ".env",
  ".env.example",
  "webapp/.env",
  "webapp/.env.example",
];

/** The block that holds SMTP settings, identified but never opened. */
const SMTP_BLOCK_FILE = "docker-compose.yml";
const SMTP_LINE_RE = /^\s*ACCT_SMTP_/;

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", bufferEncoding: "utf8" });
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Lines in `text` that actually ASSIGN one of the two flags. */
function flagLines(text) {
  const out = [];
  for (const [i, line] of text.split("\n").entries()) {
    for (const flag of FLAGS) {
      const assign = new RegExp(`^\\s*-?\\s*${flag}\\s*[:=]`);
      if (assign.test(line)) out.push({ line: i + 1, flag, text: line.trimEnd() });
    }
  }
  return out;
}

/** Contents of `file` at a ref, or null when the ref has no such file. */
function showAt(ref, file) {
  try {
    // stderr is silenced: "path does not exist in <ref>" is the normal answer
    // for every optional file here, not a failure worth printing.
    return execFileSync("git", ["show", `${ref}:${file}`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Contents of `file` in the working tree, or null when it does not exist. */
function working(file) {
  const abs = path.join(ROOT, file);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
}

function main() {
  const argv = process.argv.slice(2);
  const baseIdx = argv.indexOf("--base");
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : "origin/main";

  const head = git("rev-parse", "HEAD").trim();
  const baseSha = git("rev-parse", base).trim();
  const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();

  /**
   * "dirty" should mean *some other* drift, not the presence of this very
   * report and its sibling preflight evidence — those are always uncommitted
   * at the moment this runs, so counting them would make the flag meaningless.
   */
  const status = git("status", "--porcelain")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^[A-Z?! ]+\s+/, ""))
    .filter((p) => !/evidence\/account-preflight-/.test(p));

  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail });

  const files = {};
  for (const file of DEFINING_FILES) {
    const before = showAt(base, file);
    const after = working(file);
    if (before === null && after === null) continue;

    const beforeFlags = before === null ? [] : flagLines(before);
    const afterFlags = after === null ? [] : flagLines(after);
    files[file] = {
      existsBefore: before !== null,
      existsAfter: after !== null,
      sha256Before: before === null ? null : sha256(before),
      sha256After: after === null ? null : sha256(after),
      flagLinesBefore: beforeFlags,
      flagLinesAfter: afterFlags,
    };

    record(
      `${file}: byte-identical ${before === null ? "(file absent before)" : "(before)"}`,
      files[file].sha256Before === files[file].sha256After,
      `${files[file].sha256Before} → ${files[file].sha256After}`,
    );

    const beforeText = beforeFlags.map((f) => f.text).join("\n");
    const afterText = afterFlags.map((f) => f.text).join("\n");
    if (beforeFlags.length || afterFlags.length) {
      record(
        `${file}: the flag assignment lines are unchanged`,
        beforeText === afterText,
        `${beforeFlags.length} line(s) before, ${afterFlags.length} after`,
      );
    }
  }

  // Every flag the card names must be witnessed by at least one definition.
  const allAfter = Object.values(files)
    .flatMap((f) => f.flagLinesAfter)
    .map((l) => l.flag);
  for (const flag of FLAGS) {
    record(
      `${flag}: a definition exists in the working tree`,
      allAfter.includes(flag),
      allAfter.includes(flag) ? "witnessed" : "NOT WITNESSED",
    );
    const beforeText = Object.values(files)
      .flatMap((f) => f.flagLinesBefore)
      .filter((l) => l.flag === flag)
      .map((l) => l.text)
      .join("\n");
    const afterText = Object.values(files)
      .flatMap((f) => f.flagLinesAfter)
      .filter((l) => l.flag === flag)
      .map((l) => l.text)
      .join("\n");
    record(
      `${flag}: before/after assignment identical`,
      beforeText === afterText && beforeText.length > 0,
      beforeText === afterText ? "identical" : "DIFFERENT",
    );
  }

  // An untracked .env would override a `${VAR:-false}` default while leaving
  // the line untouched — the one way this proof could lie.
  const envPresent = [".env", "webapp/.env"].filter((f) => fs.existsSync(path.join(ROOT, f)));
  record(
    "no untracked .env can override the defaults",
    envPresent.length === 0,
    envPresent.length === 0 ? "no .env present in this worktree" : `present: ${envPresent.join(", ")}`,
  );

  // SMTP: identified and hashed, never read out.
  const smtpBefore = showAt(base, SMTP_BLOCK_FILE) || "";
  const smtpAfter = working(SMTP_BLOCK_FILE) || "";
  const smtpLines = (text) =>
    text.split("\n").filter((l) => SMTP_LINE_RE.test(l)).length;
  record(
    `SMTP configuration (${SMTP_BLOCK_FILE}) untouched`,
    sha256(smtpBefore) === sha256(smtpAfter),
    `sha256 ${sha256(smtpBefore).slice(0, 16)}… → ${sha256(smtpAfter).slice(0, 16)}…; ` +
      `${smtpLines(smtpBefore)} ACCT_SMTP_* line(s) before, ${smtpLines(smtpAfter)} after ` +
      "(values not read out)",
  );

  // The fence: everything this run changed must live under this card's own
  // evidence. An edit to a rate, a calculation, Green Button or storage would
  // show up here as drift the card never declared.
  record(
    "worktree drift is confined to this card's own evidence files",
    status.length === 0,
    status.length === 0 ? "no undeclared drift" : status.join(", "),
  );

  // And nothing in this card's own diff chooses a flag value.
  const diff = git("diff", `${base}..HEAD`);
  const diffAssign = diff
    .split("\n")
    .filter((l) => /^[+-]/.test(l))
    .filter((l) => FLAGS.some((f) => new RegExp(`^\\s*[+-]\\s*-?\\s*${f}\\s*[:=]`).test(l)));
  record(
    "this branch's own diff adds or removes no flag assignment",
    diffAssign.length === 0,
    diffAssign.length === 0 ? "0 assignment lines touched" : diffAssign.join(" | "),
  );

  const failures = checks.filter((c) => !c.ok);
  const report = {
    base: { ref: base, sha: baseSha },
    after: { branch, head, dirty: status.length > 0, driftOutsideEvidence: status },
    flags: FLAGS,
    files,
    counts: { checks: checks.length, failures: failures.length },
    checks,
    verdict:
      failures.length === 0
        ? "UNCHANGED — both ACCT_* flags and the SMTP configuration are byte-identical before and after."
        : `CHANGED — ${failures.length} of ${checks.length} check(s) failed.`,
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");

  for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name} — ${c.detail}`);
  console.log(`\n${checks.length - failures.length}/${checks.length} checks passed — ${report.verdict}`);
  console.log(`report: ${OUT}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
