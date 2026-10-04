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

Implement the complete user outcome in the bounded task contract (and plan artifact when present), including its API/UI/tests where scoped. Treat internal plan steps as one implementation, not new task handoffs. Follow AGENTS.md deliverable sizing; do not split by code layer or create extra planning tasks. If an existing required plan is complete, proceed without another planning invocation.

Read linked authoritative details instead of copying them into every artifact. Record exact final-content evidence once and reference it in the report; the reviewer may reuse sufficient checks with attribution. Fault/reconciliation tests must prove the branch executed, concurrent tests must overlap requests, and rollback fixtures must use transaction-local staged state. Identify unavailable verification targets before coding and retain their explicit approval gates.

Standing user authorization (2026-10-04), shared with the senior workflow: proceed with bounded work within the frozen Master Plan and its dependencies without asking again for implementation authorization. Reconcile stale authorization fields under AGENTS.md. Ask only for work outside or changing the frozen plan; unresolved business decisions and genuine drift still require a stop. Required plans, reviews, and separate migration/production/push/merge/deployment gates remain in force.

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
3. Run required checks and AGENTS.md section 12 startup verification; report actual local errors and pending migrations even when disposable checks pass.
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
