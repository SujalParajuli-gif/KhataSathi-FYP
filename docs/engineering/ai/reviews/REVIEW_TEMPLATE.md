# TASK-XXX Review

## Result

APPROVED / FIX REQUIRED / CANNOT VERIFY

## Mandatory development startup verification

Follow AGENTS.md section 12. Include final branch/HEAD and uncommitted application diff, database target category and schema readiness, exact frontend/backend dev commands and ports, backend health HTTP/database/storage results, frontend HTTP response, relevant connected browser/API checks, runtime errors/warnings, cleanup, and unavailable checks. Distinguish disposable-target and mocked evidence from configured-local runtime health. Reuse evidence only if application content and runtime configuration are unchanged; failed or unavailable checks cannot support a healthy-runtime claim.

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
