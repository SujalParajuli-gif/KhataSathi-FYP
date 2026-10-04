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
Authorization: <existing source; identify separately gated operations>
Delivery outcome: <observable complete user workflow>
Delivery priority: <client-required / prerequisite / optional; rationale>
Dependencies / approval gates: <accepted prerequisites and operation-specific gates>
Split rationale: <concrete boundary, or cohesive deliverable; no split>
Deadline / effort assumptions: <supplied date or UNKNOWN; estimates only with basis>

## Goal

State one coherent user outcome, including its necessary layers and tests. Split only for a concrete boundary under Master Plan28/AGENTS7.

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

List exact focused checks and the acceptance criteria each proves; identify final-content evidence that can be reused. Establish runtime/database/fixture targets and their existing approvals before implementation. For fault/race cases, require actual branch entry, overlapping competitors and transaction-local commit/rollback assertions. Do not infer connected DB proof from mocks.

Mandatory completion check: follow AGENTS.md section 12 for both dev servers, health/HTTP and runtime logs on final application changes. Report configured-local errors and pending migrations separately from disposable results; do not apply configured migrations without approval.

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
