# TASK-XXX Implementation Report

## Status

COMPLETE / PARTIAL / BLOCKED

## Branch / worktree / revision

## What changed

## Files changed

- path

## Tests/checks

| Command / check | Result | Tested revision / limits |
|---|---|---|
| | | |

Reference existing sufficient evidence instead of duplicating logs. Distinguish performed, reused (source/revision/target), failed and unavailable checks. For fault/race evidence name the exercised path, overlap/commit/rollback assertions and connected-versus-mocked limits; passing test counts alone do not prove coverage.

## Mandatory development startup verification

Follow AGENTS.md section 12: record revision/worktree/database, both dev commands, health/HTTP results, runtime errors, cleanup and limits. Explicitly report configured-local errors and missing migrations awaiting approval even if disposable checks pass.

## Acceptance criteria

| Criterion | Result | Evidence |
|---|---|---|
| AC-1 | PASS / FAIL / NOT TESTED | |

## Unresolved BLOCKERS

None / list.

## Unrelated findings

None / list.

Do not fix unrelated findings unless separately authorized.

## Git state

## Notes for reviewer

Keep concise. The reviewer should inspect the repository/diff rather than relying only on this report.
