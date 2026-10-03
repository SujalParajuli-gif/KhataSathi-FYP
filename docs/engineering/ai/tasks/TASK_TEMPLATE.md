# TASK-XXX — Short Name

Status: READY
Difficulty: X/10
Risk: LOW / MEDIUM / HIGH
Planning Required: YES / NO
Execution Mode: READ_ONLY_DIRECT / SENIOR_AUTOPILOT / DIRECT_IMPLEMENTATION / PLANNED_IMPLEMENTATION
Senior Review Required: YES / NO
Phase:
Master Plan section:
Branch / worktree: <exact authorized work branch; enforced by router commit gate>
Assigned role:

## Goal

State one bounded outcome.

## Repository evidence

List the exact current code paths/symbols/tests that establish the starting state.

## Scope

Include only work required for this task.

## Required behavior

Describe observable behavior that must be true after implementation.

## Invariants

List architecture/safety rules that must remain true.

## Acceptance criteria

- [ ] AC-1
- [ ] AC-2
- [ ] AC-3

## Required tests/checks

List exact or expected focused checks.

Mandatory completion check (AGENTS.md section 12): run `pnpm --dir backend run dev` and `pnpm --dir frontend run dev` on the final application content. Inspect startup/runtime logs; require backend `/api/health` HTTP 200 with database/storage healthy and frontend HTTP 200. Check affected browser/API paths where relevant. Record revision/diff, safe database target, ports, warnings/errors, cleanup and unavailable checks. Use a disposable database unless configured-local startup is explicitly authorized; migration execution needs separate authorization. Failed/unavailable checks must be reported, never presented as verified runtime health.

## Explicit non-goals

List nearby work that must not be absorbed.

## Stop conditions

Stop and report instead of guessing if any listed condition is reached.

## Likely files/symbols

Guidance only. Inspect the actual repository before editing.

## Implementation notes

Leave blank until implementation begins.

## Review status

Not reviewed.
