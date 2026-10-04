# TASK-XXX Review

## Result

APPROVED / FIX REQUIRED / CANNOT VERIFY

Record reviewed branch/revision/final content and bounded scope. Reuse sufficient final-content checks with attribution; rerun only changed, missing, failed or questionable evidence and blocker/direct-regression checks. Inspect fault/race branch coverage rather than trusting test names/counts. Do not reopen the complete review after a narrow correction.

## Mandatory development startup verification

Follow AGENTS.md section 12: record revision/worktree/database, both dev commands, health/HTTP results, runtime errors, cleanup and limits. Explicitly report configured-local errors and missing migrations awaiting approval even if disposable checks pass.

## BLOCKERS

If none, write:

`None.`

For each blocker:

### B-1 — Short title

**Location:**
**Concrete failure:**
**Violated task requirement/invariant:**
**Smallest acceptable correction:**

## NON-BLOCKING

Useful improvements that do not prevent approval.

## OUT OF SCOPE

Real issues unrelated to the authorized task.

## QUESTIONS

Items that could not be verified from available evidence.

## Targeted re-review scope

If blockers are fixed, verify only:
- the listed blockers,
- regressions directly caused by their fixes.

Do not restart a full review unless the fixes materially change architecture or introduce a new HIGH-risk issue.
