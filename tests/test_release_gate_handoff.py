"""Release-gate handoff invariants over the kanban board's own task linkage.

Run (from the repo root)::

    .venv/bin/pytest tests/test_release_gate_handoff.py -v

Why this exists
---------------
A release card can reach ``done`` while its post-deploy QA child is never
claimed: the board reports a shipped release and verification never ran.  Two
causes have been observed on this board:

* **tardy link** - a child linked to a parent *after* that parent already went
  ``ready -> running`` receives no recorded re-gate, so nothing re-evaluates the
  child against the new parent.
* **``done`` == ``passed``** - the dispatcher gates children on the parent's
  task *status* alone.  A gate card whose run finishes with a ``GATE-FAIL``
  verdict (run ``outcome = completed``, summary ``GATE-FAIL ...``) is still
  ``done``, so its children are promoted and dispatched: t_02068d63 promoted
  t_f7e7ad6f in the same second it completed (2026-10-24 13:15:13), and again
  after t_2cfdb8b3's GATE-FAIL (Gate 4).

This suite asserts those conditions against the board's REAL schema
(``tasks``, ``task_runs``, ``task_links``, ``task_events``, ``task_comments``)
read-only, and it is **expected to be RED today**: the failures are the captured
defects, not test bugs.  Two controls prove the read path and the predicates
work, and one invariant that already holds is asserted green.

Where the data comes from
-------------------------
``~/.hermes/kanban/boards/electricity/kanban.db`` (override with
``KANBAN_BOARD_DB``), opened ``mode=ro`` inside one transaction so every test
sees the same snapshot of a board the dispatcher is writing to concurrently.
The suite skips when the board DB is absent (any other machine).

Title vocabulary (documented so a reviewer can argue with it, not guess it)
---------------------------------------------------------------------------
Board cards name their steps in the title; nothing in the schema marks a card
as "the deploy step", so the predicates read titles:

``DEPLOY_NODE``
    a card that *performs* a deploy: starts with ``Deploy ...`` or carries
    ``+ deploy`` / ``and deploy`` / ``: deploy`` (``Wave N: deploy to .110``,
    ``... (merge + deploy)``).  A mention in prose (``... before EV-server
    deploy``, ``so a deploy card can verify ...``) and ``post-deploy`` are NOT
    deploy nodes.
``POSTDEPLOY_VERIFY``
    ``Verify ... post-deploy ...`` or ``Post-deploy signature: ...`` - the leg
    that proves the deployed SHA is live.
``POSTDEPLOY_QA``
    ``Post-deploy QA: ...`` - the acceptance leg.
``FAIL_VERDICT``
    a run summary that LEADS with a failure verdict (``GATE-FAIL``,
    ``Verdict: FAIL``, ``BLOCKED/FAIL``, ``NO-GO``, ``FAIL``).  Leading-token
    matching is deliberate: free text later in a summary routinely says
    "0 failures" or "fixed the FAIL", and verdicts like ``CHANGES`` mean the
    fix child *should* be dispatched.

Non-goals (see the card)
------------------------
This suite only captures the defects.  Fixing the ``done==passed`` dispatcher
behaviour, re-gating tardy links, and attaching post-deploy cards to deploy
cards each belong to their own card - do not fold a scheduler change into this
one.
"""

from __future__ import annotations

import collections
import json
import os
import re
import sqlite3
from datetime import datetime
from pathlib import Path

import pytest

BOARD_DB = Path(
    os.environ.get("KANBAN_BOARD_DB")
    or Path.home() / ".hermes/kanban/boards/electricity/kanban.db"
)

#: Tables every invariant in this module reads (the card names them explicitly).
REQUIRED_TABLES = ("tasks", "task_runs", "task_links", "task_events", "task_comments")

#: Columns each invariant depends on, per table.
REQUIRED_COLUMNS = {
    "tasks": ("id", "title", "status", "created_at", "started_at", "completed_at"),
    "task_runs": ("id", "task_id", "status", "outcome", "summary", "started_at", "ended_at"),
    "task_links": ("parent_id", "child_id"),
    "task_events": ("task_id", "kind", "payload", "created_at"),
    "task_comments": ("task_id", "author", "body", "created_at"),
}

# --- title vocabulary (rationale in the module docstring) ------------------
DEPLOY_NODE = re.compile(r"(?i)(?:^deploy\b)|(?:\+\s*|and\s+|:\s*)(?<!post-)deploy\b")
POSTDEPLOY_VERIFY = re.compile(r"(?i)(?:^verify\b[^\n]*post-deploy|post-deploy signature\b)")
POSTDEPLOY_QA = re.compile(r"(?i)^post-deploy qa\b")
FAIL_VERDICT = re.compile(
    r"(?i)^(?:gate-?fail\b|verdict:\s*fail\b|blocked\s*/\s*fail\b|no-?go\b|fail\b)"
)

#: Event kinds that record a dependency-gate decision for a child.
GATE_EVENTS = ("dependency_wait", "promoted")
#: Event kinds that mean "the dispatcher put this child to work".
DISPATCH_EVENTS = ("promoted", "claimed", "spawned")

#: Terminal statuses that count as "done" for dependency gating (matches the
#: dispatcher's own _parents_satisfied contract).
TERMINAL_STATUSES = ("done", "archived")

#: Known-good chains used as a positive control for the test-1 predicate:
#: both must satisfy deploy -> post-deploy verify -> post-deploy QA.
KNOWN_GOOD_DEPLOY_NODES = ("t_59512d13", "t_f0bc0dba")


class Board:
    """One read-only snapshot of the kanban board."""

    def __init__(self, con: sqlite3.Connection) -> None:
        self.con = con
        self.tables = {
            row[0]
            for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        self.columns = {
            table: {row[1] for row in con.execute(f"PRAGMA table_info({table})")}
            for table in self.tables
        }
        self.tasks = {
            row["id"]: dict(row)
            for row in con.execute(
                "SELECT id, title, status, created_at, started_at, completed_at FROM tasks"
            )
        }
        links = [
            (row["parent_id"], row["child_id"])
            for row in con.execute("SELECT parent_id, child_id FROM task_links")
        ]
        self.links = links
        self.children: dict[str, list[str]] = collections.defaultdict(list)
        self.parents: dict[str, list[str]] = collections.defaultdict(list)
        for parent, child in links:
            self.children[parent].append(child)
            self.parents[child].append(parent)
        self.last_run = {
            row["task_id"]: dict(row)
            for row in con.execute(
                "SELECT r.* FROM task_runs r "
                "WHERE r.id = (SELECT MAX(id) FROM task_runs WHERE task_id = r.task_id)"
            )
        }
        # (created_at, kind) per task, chronological.
        self.events: dict[str, list[tuple[int, str]]] = collections.defaultdict(list)
        for row in con.execute(
            "SELECT task_id, kind, created_at FROM task_events ORDER BY created_at, id"
        ):
            self.events[row["task_id"]].append((row["created_at"], row["kind"]))
        self.link_events = [
            (row["created_at"], json.loads(row["payload"] or "{}"))
            for row in con.execute(
                "SELECT created_at, payload FROM task_events "
                "WHERE kind = 'linked' AND payload IS NOT NULL ORDER BY created_at, id"
            )
        ]
        self.first_claimed: dict[str, int] = {
            row["task_id"]: row["m"]
            for row in con.execute(
                "SELECT task_id, MIN(created_at) AS m FROM task_events "
                "WHERE kind = 'claimed' GROUP BY task_id"
            )
        }

    # -- helpers ---------------------------------------------------------
    def title(self, task_id: str) -> str:
        task = self.tasks.get(task_id)
        return task["title"] if task else f"<missing {task_id}>"

    def descendants(self, task_id: str) -> list[str]:
        out: list[str] = []
        stack = list(self.children.get(task_id, ()))
        while stack:
            node = stack.pop()
            if node in out:
                continue
            out.append(node)
            stack.extend(self.children.get(node, ()))
        return out

    def events_after(self, task_id: str, since: int, kinds: tuple[str, ...]) -> list[tuple[int, str]]:
        return [
            (at, kind)
            for at, kind in self.events.get(task_id, ())
            if at >= since and kind in kinds
        ]


@pytest.fixture(scope="module")
def board() -> Board:
    if not BOARD_DB.exists():
        pytest.skip(
            f"kanban board DB not found at {BOARD_DB} "
            "(set KANBAN_BOARD_DB to run this suite against another board)"
        )
    con = sqlite3.connect(f"file:{BOARD_DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    # One transaction = one consistent snapshot: the dispatcher writes to this
    # file while the suite runs.
    con.execute("BEGIN")
    try:
        snapshot = Board(con)
    except Exception:
        con.close()
        raise
    yield snapshot
    con.close()


def _require(board: Board, *tables: str) -> None:
    """Fail loudly on schema drift instead of vacuously passing."""
    missing = [t for t in tables if t not in board.tables]
    assert not missing, f"board schema drift: missing table(s) {missing} in {BOARD_DB}"


def _fmt(items: list[str], limit: int = 12) -> str:
    shown = "\n".join(f"  - {item}" for item in items[:limit])
    if len(items) > limit:
        shown += f"\n  ... and {len(items) - limit} more"
    return shown


def _ts(epoch: int | None) -> str:
    """Board timestamps are unix seconds; show them as local wall-clock."""
    if not epoch:
        return "-"
    return datetime.fromtimestamp(epoch).astimezone().isoformat(sep=" ", timespec="seconds")


# ---------------------------------------------------------------------------
# Controls: prove the read path and the predicates can pass.
# ---------------------------------------------------------------------------


def test_board_schema_exposes_the_tables_the_invariants_read(board: Board) -> None:
    """The suite asserts against the real schema; drift must fail, not skip."""
    missing_tables = [t for t in REQUIRED_TABLES if t not in board.tables]
    assert not missing_tables, (
        f"{BOARD_DB} is missing table(s) {missing_tables}; "
        f"present: {sorted(board.tables)}"
    )
    for table, columns in REQUIRED_COLUMNS.items():
        missing = sorted(set(columns) - board.columns.get(table, set()))
        assert not missing, f"table {table} is missing column(s) {missing}"
    assert board.tasks, "board has no tasks - nothing for the invariants to check"


def test_known_good_release_chains_are_recognised_as_compliant(board: Board) -> None:
    """Positive control for the deploy-node predicate.

    t_59512d13 and t_f0bc0dba are the two chains that DID carry both legs
    (verify card -> post-deploy QA card).  If the predicate ever reports one of
    them, the predicate itself is broken - not the board.
    """
    _require(board, "tasks", "task_links")
    absent = [n for n in KNOWN_GOOD_DEPLOY_NODES if n not in board.tasks]
    if absent:
        pytest.skip(f"known-good chain card(s) {absent} not on this board")
    gaps = {gap["deploy"] for gap in deploy_node_gaps(board)}
    still_broken = [n for n in KNOWN_GOOD_DEPLOY_NODES if n in gaps]
    assert not still_broken, (
        "predicate false-positive: known-good deploy chain(s) reported as missing "
        f"post-deploy legs: {still_broken}"
    )


def test_no_child_is_stranded_with_every_parent_done(board: Board) -> None:
    """The headline symptom: a child sits in ``todo`` and nothing claims it."""
    _require(board, "tasks", "task_links")
    stranded = [
        task_id
        for task_id, task in board.tasks.items()
        if task["status"] == "todo"
        and board.parents.get(task_id)
        and all(
            board.tasks.get(parent, {}).get("status") in TERMINAL_STATUSES
            for parent in board.parents[task_id]
        )
    ]
    assert not stranded, (
        f"{len(stranded)} child card(s) are parked in todo with every parent done:\n"
        + _fmt([f"{tid}: {board.title(tid)}" for tid in sorted(stranded)])
    )


# ---------------------------------------------------------------------------
# Invariant 1: every deploy node carries a post-deploy verify + post-deploy QA
# ---------------------------------------------------------------------------


def deploy_node_gaps(board: Board) -> list[dict]:
    """Deploy nodes missing an attached post-deploy verify and/or QA child.

    "Attached" = reachable downward from the deploy node through ``task_links``
    (the chain's own linkage), which is exactly what a stranded post-deploy QA
    card violates: nothing links it to the deploy it verifies.
    """
    gaps: list[dict] = []
    deploy_nodes = sorted(
        (tid for tid, task in board.tasks.items() if DEPLOY_NODE.search(task["title"])),
        key=lambda tid: board.tasks[tid]["created_at"],
    )
    for deploy in deploy_nodes:
        chain = board.descendants(deploy)
        verify = [n for n in chain if POSTDEPLOY_VERIFY.search(board.title(n))]
        qa = [n for n in chain if POSTDEPLOY_QA.search(board.title(n))]
        if not (verify and qa):
            gaps.append(
                {
                    "deploy": deploy,
                    "verify": verify,
                    "qa": qa,
                    "descendants": len(chain),
                }
            )
    return gaps


def test_every_deploy_node_carries_postdeploy_verify_and_qa(board: Board) -> None:
    """Invariant 1 (card condition 1).

    A release chain whose deploy node has no attached post-deploy verify card
    and post-deploy QA card shipped without recorded verification.
    """
    _require(board, "tasks", "task_links")
    gaps = deploy_node_gaps(board)
    deploy_total = sum(1 for t in board.tasks.values() if DEPLOY_NODE.search(t["title"]))
    lines = []
    for gap in gaps:
        missing = [
            leg for leg, key in (("post-deploy verify", "verify"), ("post-deploy QA", "qa"))
            if not gap[key]
        ]
        lines.append(
            f"{gap['deploy']} (descendants={gap['descendants']}, "
            f"missing={', '.join(missing)}): {board.title(gap['deploy'])}"
        )
    assert not gaps, (
        f"{len(gaps)} of {deploy_total} deploy node(s) have no attached "
        f"post-deploy verify + post-deploy QA child:\n" + _fmt(lines)
    )


# ---------------------------------------------------------------------------
# Invariant 2: a done parent whose run did NOT pass never dispatches a child
# ---------------------------------------------------------------------------


def non_passing_done_parents(board: Board) -> list[tuple[str, str]]:
    """Done parents whose terminal run did not pass, with the verdict shown."""
    found: list[tuple[str, str]] = []
    for task_id, task in board.tasks.items():
        if task["status"] != "done" or not task["completed_at"]:
            continue
        run = board.last_run.get(task_id)
        if not run:
            continue
        summary = (run["summary"] or "").lstrip()
        verdict = FAIL_VERDICT.match(summary)
        if run["outcome"] != "completed":
            found.append((task_id, f"outcome={run['outcome']}"))
        elif verdict:
            found.append((task_id, summary.split("\n")[0][:160]))
    return found


def dispatches_after_non_passing_parent(board: Board) -> list[str]:
    """Child dispatches that happened at/after a non-passing parent's completion."""
    findings: list[str] = []
    for task_id, verdict in non_passing_done_parents(board):
        completed_at = board.tasks[task_id]["completed_at"]
        for child in board.children.get(task_id, ()):
            for at, kind in board.events_after(child, completed_at, DISPATCH_EVENTS):
                findings.append(
                    f"parent {task_id} completed {_ts(completed_at)} with verdict "
                    f"{verdict!r} -> child {child} ({kind} at {_ts(at)}): {board.title(child)}"
                )
                break
    return findings


def test_done_parent_with_failing_verdict_never_dispatches_its_child(board: Board) -> None:
    """Invariant 2 (card condition 2) - the ``done == passed`` demonstration.

    EXPECTED FAIL: this is the known-open dispatcher defect captured on purpose
    (the card's non-goal is fixing it here).  The canonical case is
    t_02068d63, whose run completed with ``GATE-FAIL (Gate 3)`` at
    2026-10-24 13:15:13 and promoted t_f7e7ad6f in the same second; the fix
    belongs to a separate card.  Do not delete or force this green.
    """
    _require(board, "tasks", "task_links", "task_runs", "task_events")
    findings = dispatches_after_non_passing_parent(board)
    assert not findings, (
        f"{len(findings)} child dispatch(es) followed a done parent whose run did "
        "not pass (dispatcher gates on status, not verdict):\n" + _fmt(findings)
    )


# ---------------------------------------------------------------------------
# Invariant 3: a child linked after its parent entered running is re-gated
# ---------------------------------------------------------------------------


def un_regated_tardy_links(board: Board) -> list[str]:
    """Links created after the parent already entered running, with no re-gate.

    "Re-gated" = the board recorded a gate decision for the child at/after the
    link - ``dependency_wait`` (still parked) or ``promoted`` (released).  A
    child whose only post-link activity is comments/unblocks never had the new
    parent evaluated, which is how a QA card ends up stranded.
    """
    findings: list[str] = []
    for linked_at, payload in board.link_events:
        parent, child = payload.get("parent"), payload.get("child")
        if not parent or not child or parent not in board.tasks:
            continue
        running_at = board.first_claimed.get(parent) or board.tasks[parent]["started_at"]
        if not running_at or linked_at <= running_at:
            continue  # parent had not entered running yet - not a tardy link
        if board.events_after(child, linked_at, GATE_EVENTS):
            continue
        stranded = board.tasks.get(child, {}).get("status") == "todo" and all(
            board.tasks.get(p, {}).get("status") in TERMINAL_STATUSES
            for p in board.parents.get(child, ())
        )
        findings.append(
            f"parent {parent} entered running {_ts(running_at)}, link created {_ts(linked_at)}, "
            f"no {'/'.join(GATE_EVENTS)} on child {child} "
            f"(status={board.tasks.get(child, {}).get('status')}, "
            f"stranded_now={stranded}): {board.title(child)}"
        )
    return findings


def test_child_linked_after_parent_entered_running_is_regated(board: Board) -> None:
    """Invariant 3 (card condition 3) - the tardy-link case.

    EXPECTED FAIL while the board's history still holds links that were never
    re-gated; the fix (re-gate on link, as unlink already does) belongs to a
    separate card.  ``stranded_now=`` in the message separates a missing gate
    record from a child that is actually stuck today.
    """
    _require(board, "tasks", "task_links", "task_events")
    findings = un_regated_tardy_links(board)
    assert not findings, (
        f"{len(findings)} child link(s) landed after the parent had already entered "
        f"running, with no recorded re-gate:\n" + _fmt(findings)
    )
