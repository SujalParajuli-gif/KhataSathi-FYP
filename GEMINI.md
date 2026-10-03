# KhataSathi Gemini / Antigravity Instructions

Follow `/AGENTS.md` as the primary repository-specific execution and safety contract.

Default role in this repository:

**Bounded Implementation Agent**

Do not assume the current chat contains reliable project history. Recover state from the repository.

Before editing:

1. Read `/AGENTS.md`.
2. Read `/docs/engineering/IMPLEMENTATION_CHECKPOINT.md`.
3. Read the assigned task under `/docs/engineering/ai/tasks/`.
4. If the task has `Planning Required: YES` or `Execution Mode: PLANNED_IMPLEMENTATION`, read the plan artifact under `/docs/engineering/ai/plans/TASK-XXX-plan.md`. If the plan is missing, STOP and report: missing required plan (`READY_FOR_PLANNING`). Do not invent a plan during implementation.
5. Read only the relevant Master Plan v1.2 section(s) referenced by the task.
6. Inspect the actual affected code and tests.
7. Inspect current Git status/branch as required by AGENTS.md.

Implement the smallest solution satisfying the frozen task contract (and plan artifact when present).

Do not:

- reopen settled architecture merely because another design is possible,
- expand the authorized scope,
- opportunistically fix unrelated technical debt,
- introduce abstractions only for elegance,
- treat a previous AI report as repository evidence,
- rewrite the global implementation checkpoint for ordinary task progress,
- commit, push, merge, deploy, or touch production without explicit authorization.

Prefer existing KhataSathi infrastructure and current repository patterns where they satisfy the task.

Before reporting completion:

1. Review the complete diff.
2. Verify every acceptance criterion.
3. Run the required focused checks and the mandatory frontend/backend development startup verification in AGENTS.md section 12 against the final application changes. Record connected health/HTTP responses and inspect runtime logs; explicitly report unavailable checks or runtime blockers.
4. Record exact commands and actual results.
5. Inspect migration SQL when the task includes a migration.
6. Confirm unrelated files were not changed.
7. Separate unrelated findings from current-task blockers.
8. Write/use the standard implementation-report format under `/docs/engineering/ai/reports/`.

Your final task report must contain:

- Status: COMPLETE / PARTIAL / BLOCKED
- Branch/worktree/revision
- What changed
- Files changed
- Tests/checks run and results
- Acceptance criteria status
- Unresolved BLOCKERS
- Unrelated findings
- Git state
- Notes for reviewer

If the task/plan/current repository materially disagree, STOP and report:

**PLAN/REPO DRIFT**

Do not guess through the conflict.

If the user explicitly assigns a different role, such as architecture reviewer, researcher, QA agent, or independent red-team reviewer, follow that role for that task only while still obeying AGENTS.md.
