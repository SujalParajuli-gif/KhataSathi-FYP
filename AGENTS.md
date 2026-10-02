# KhataSathi AI Agent Entry Point

> READ THIS FIRST BEFORE ANY AI CHANGES KHATASATHI.

This file defines the **KhataSathi-specific AI workflow and safety contract**.

The repository is shared engineering memory. Chat history is temporary context.

---

## 1. Read order

Before changing KhataSathi, read only what is needed in this order:

1. `/AGENTS.md`

2. `/docs/engineering/IMPLEMENTATION_CHECKPOINT.md`

3. The assigned task under `/docs/engineering/ai/tasks/`

4. The implementation plan under `/docs/engineering/ai/plans/` (if planning was required)

5. Only the relevant section(s) of `/docs/engineering/KHATASATHI_MASTER_IMPLEMENTATION_PLAN_v1.1.md`

6. The affected code/tests

Do **not** read the entire Master Plan for every task.

For HIGH-risk work, also inspect the relevant invariants, dependencies, transaction/concurrency rules, failure semantics, and stop conditions.

If repository state materially conflicts with the active task or frozen architecture, STOP and report:

**PLAN/REPO DRIFT**

---

## 2. Authority

Use this project authority order, subject to governing system instructions:

1. Explicit current user authorization

2. Actual repository state

3. `/AGENTS.md`

4. Active bounded task contract

5. `/docs/engineering/IMPLEMENTATION_CHECKPOINT.md`

6. Frozen Master Plan v1.1

7. Accepted task review

8. Historical/local notes only where consistent with the above

Rules:

- A task MUST NOT silently override frozen architecture.

- The checkpoint may change implementation state, not architecture.

- Architectural changes require an explicitly authorized plan revision.

- Planning does not authorize implementation.

- Implementation does not authorize commit/push/merge/deploy/migration/production changes.

---

## 3. Current state

Do not hard-code live phase/task status in this file.

The current source for:

- phase,

- active task,

- branch,

- authorization,

- blockers,

- migration verification,

- last accepted task,

- next safe action,

is:

`/docs/engineering/IMPLEMENTATION_CHECKPOINT.md`

Implement only explicitly authorized work.

Do not opportunistically implement future phases or unrelated technical debt.

---

## 3A. Human progress dashboard

`/docs/engineering/PROJECT_PROGRESS.md` is the persistent human-facing project dashboard. It is not project authority.

Authoritative state remains:

1. the implementation checkpoint,
2. the task registry,
3. the active task contract,
4. accepted reviews.

If `PROJECT_PROGRESS.md` disagrees with authoritative workflow state, the authoritative workflow files win.

### Ownership

Only the senior/integration workflow updates `PROJECT_PROGRESS.md`.

Implementation agents MUST NOT update it and do not need to read it during normal implementation.

### When to update

Update the dashboard only when:

- a bounded task is activated,
- a task becomes `BLOCKED`,
- a task becomes `ACCEPTED`,
- the current phase changes,
- a material project-level blocker changes,
- or an authoritative roadmap item becomes completed or newly active.

### Update behavior

`PROJECT_PROGRESS.md` has persistent human-navigation structure.

When updating it:

- preserve its existing sections, headings, phase tree, checklist structure, links, and explanatory text,
- update only the smallest status fields, task entries, emojis, checkboxes, blockers, and next-action text necessary to reflect authoritative state,
- add a newly created bounded task under its owning phase,
- mark accepted tasks `✅`,
- mark the active task `🟡`,
- mark blocked work `🔴`,
- mark untouched future work `⬜`,
- keep deferred work `⏸`,
- update phase status when its authoritative completion state changes.

Do NOT regenerate the whole dashboard from scratch during ordinary updates.

Do NOT remove unchecked roadmap items merely because they are not part of the current task.

Do NOT expand implementation reports, review evidence, task contracts, or the full Master Plan into this file.

The dashboard should remain easy for a human to scan while retaining the persistent roadmap/checklist needed for navigation.

---

## 4. Canonical and local AI workflow files

Only explicitly designated canonical shared repository workflow assets may be
committed. The exact path allowlist is in `.gitignore` and the KhataSathi
`repository-commit-hygiene` skill/checker. It covers this entry point,
`GEMINI.md`, the canonical AI workflow README and three templates, the router
and planner skill entry points, and the commit-hygiene skill/checker/tests.
Being allowlisted does not itself authorize staging or committing a file.

Live and personal AI workflow state stays local and ignored: the implementation
checkpoint, project progress dashboard, task registry, backlog, individual
tasks, plans, reports, reviews, `/ThingsforAI/`, personal skills, transcripts,
scratch prompts, caches, and generated logs. Do not broadly unignore
`.agents/` or `docs/engineering/ai/`. Do not force-add ignored files.

`/docs/engineering/KHATASATHI_MASTER_IMPLEMENTATION_PLAN_v1.1.md` is the

canonical architecture source for this AI engineering workflow. Canonical

authority does not imply Git tracking: the plan may remain local and ignored.

Agents must still follow its frozen v1.1 architecture and must never force-add it

merely because it is canonical.

---

## 5. Historical/on-demand material

`/ThingsforAI/` is historical or task-specific reference material.

Do not treat it as current architecture or load it automatically.

Use it only when:

- an active task explicitly references it, or

- a specific file is clearly relevant as an on-demand reference.

Current code, AGENTS.md, active tasks, checkpoint, and Master Plan v1.1 take precedence.

---

## 6. Skills

Use existing skills instead of duplicating their detailed procedures here.

Personal/global skills may exist outside the repository.

Workspace-specific skills may exist under:

`.agents/skills/`

Rules:

- Use only skills relevant to the current task.

- Do not load unrelated skills merely because they are available.

- Prefer a stricter KhataSathi workspace skill over a generic equivalent.

- Skills do not override project authority or frozen architecture.

Typical workspace skills include:

- repository commit hygiene

- product image extraction/insertion

Generic repository hygiene, staging, commit procedure, frontend-design procedure, Playwright procedure, and similar reusable engineering steps belong in their relevant skills, not in this file.

---

## 7. Task contracts

Every implementation task MUST have a bounded task file under:

`/docs/engineering/ai/tasks/`

Each task should contain:

- Task ID / name

- Status

- Difficulty: 1–10

- Risk: LOW / MEDIUM / HIGH

- Planning Required: YES / NO

- Execution Mode: READ_ONLY_DIRECT / SENIOR_AUTOPILOT / DIRECT_IMPLEMENTATION / PLANNED_IMPLEMENTATION

- Senior Review Required: YES / NO

- Phase / relevant Master Plan section

- Goal

- Repository evidence

- Scope

- Required behavior

- Invariants

- Acceptance criteria

- Required tests/checks

- Explicit non-goals

- Stop conditions

- Likely files/symbols as guidance only

The task must be small enough for one implementation agent to complete and self-review without ambiguity.

The Difficulty and Workflow v2 metadata fields apply to new tasks. Already ACCEPTED legacy tasks that predate them remain valid without retroactive entries.

---

## 8. Difficulty, execution modes, and routing

Before assigning or starting a new task, state:

- **Difficulty:** X/10 (implementation/reasoning complexity)
- **Risk:** LOW / MEDIUM / HIGH (consequence of an incorrect change)
- **Planning Required:** YES / NO
- **Execution Mode:** `READ_ONLY_DIRECT` / `SENIOR_AUTOPILOT` / `DIRECT_IMPLEMENTATION` / `PLANNED_IMPLEMENTATION`
- **Reason:** one short sentence

### Execution Modes:

1. **`READ_ONLY_DIRECT`**: Senior read-only inspection, dry-runs, architecture evaluation, or deployment readiness checks (`ks-deploy`). Zero code mutation.
2. **`SENIOR_AUTOPILOT`**: Bounded LOW-risk tasks where Planning Required = NO, touching no financial, tax, auth, migration, or production paths, and no unresolved user decisions exist. Never downgrade task risk to retain autopilot.
3. **`DIRECT_IMPLEMENTATION`**: Well-specified tasks with complete implementation-grade contracts and Planning Required = NO. Handed directly to implementation agent (`GEMINI.md`).
4. **`PLANNED_IMPLEMENTATION`**: Tasks where Planning Required = YES (all HIGH-risk tasks, schema/migrations, multi-step transaction flows). Hands off to Implementation Planner first to produce `docs/engineering/ai/plans/TASK-XXX-plan.md` before coding.

For details on state transitions and routing, refer to `.agents/skills/khatasathi-workflow-router/SKILL.md`.

---

## 9. Risk

### LOW

Examples:

- copy/labels

- documentation

- simple visual polish

- isolated types/tests with no domain behavior change

Handling:

- bounded implementation

- self-review

- relevant checks

- senior review optional/batched

### MEDIUM

Examples:

- ordinary CRUD

- bounded nonfinancial endpoints

- read queries

- component extraction

- isolated nonfinancial workflow changes

Handling:

- focused implementation/testing

- one bounded post-implementation senior review

### HIGH

Examples:

- migrations

- checkout/finalization

- stock posting

- payments/refunds

- snapshots/replacements

- privacy/authorization

- tax

- purchase posting

- OCR posting authority

- financial reporting

- accounting integrations

- legal/IRD issuance

Handling:

- focused senior preflight where useful

- implementation + failure-path checks

- one bounded senior post-implementation review

- explicit authorization before production-impacting actions

Risk is determined by behavior touched, not line count.

---

## 10. One writer per working tree

Only one implementation agent may edit a working tree at a time.

Multiple agents may inspect/review concurrently.

For genuinely independent parallel tasks:

- use isolated Git worktrees/branches,

- assign one task ID per worktree,

- ensure required local AI context exists there,

- do not let task agents independently rewrite the global checkpoint.

---

## 11. Implementation-agent boundaries

The implementation agent should:

1. Read AGENTS.md.

2. Read the checkpoint.

3. Read the assigned task.

4. If `Planning Required: YES` or `Execution Mode: PLANNED_IMPLEMENTATION`, read the implementation plan under `/docs/engineering/ai/plans/TASK-XXX-plan.md`. If missing, STOP and report: missing required plan (`READY_FOR_PLANNING`). Do not invent a plan.

5. Read only relevant Master Plan sections.

6. Inspect affected code/tests.

7. Verify current repository state.

8. Implement the smallest solution satisfying the task and plan.

9. Preserve unrelated user work.

10. Reuse existing project infrastructure where appropriate.

11. Avoid unrelated refactors/speculative abstractions.

12. Run required checks.

13. Review the complete task diff.

14. Record exact commands/results.

15. Write/update the task implementation report.

16. Stop for senior review when required.

Implementation reports belong under:

`/docs/engineering/ai/reports/`

Use the repository report template.

The implementation agent MUST NOT:

- rewrite frozen architecture,

- expand scope merely for cleanliness,

- update the global checkpoint for ordinary in-progress details,

- commit/push/merge/deploy/run production migrations/touch production without explicit authorization.

---

## 12. Senior review

Perform **ONE bounded review** against:

- the active task contract,

- relevant frozen architecture,

- actual diff/code,

- directly affected tests/regressions.

Classify findings only as:

### BLOCKER

Concrete correctness, acceptance, data-integrity, security/privacy, authorization, transaction, idempotency/concurrency, or directly caused regression issue.

Only BLOCKER prevents approval.

### NON-BLOCKING

Useful improvement not required for task correctness.

Does not prevent approval.

### OUT OF SCOPE

Real issue unrelated to the current authorized task.

Record separately.

### QUESTION

Cannot be verified from current evidence.

Inspect/request only the smallest missing evidence.

### After blocker fixes

Verify only:

- the previously listed blockers,

- regressions directly caused by those fixes.

Do **not** restart a full review.

A third review cycle requires a genuinely new HIGH-risk issue, architecture-changing fix, or concrete fix-induced regression.

### Development startup verification

At the user's request, every senior review/approval must also verify startup with `pnpm --dir backend dev` and `pnpm --dir frontend dev`, inspect startup/runtime errors, and check backend health and the frontend HTTP response. Record the checked revision, database target category, and any unavailable or unsafe checks. A build, mocked browser suite, or listening process alone does not prove connected development startup works.

Backend startup can run scheduled cleanup and recovery writes. Verify the database target before launching it; use a disposable test database unless the user explicitly authorizes the configured local database. Do not start against production, apply migrations automatically, or stop a user's existing dev processes without authorization. Temporary smoke-check processes should use available alternate ports where needed and be stopped after verification. Record missing migrations as a runtime blocker rather than claiming safe local startup.

Review reports belong under:

`/docs/engineering/ai/reviews/`

---

## 13. Automatic task closeout

When a bounded senior review returns **APPROVED** with no BLOCKERS, the senior/integration workflow should close the task automatically unless explicitly told otherwise.

Closeout should:

1. Write/update the review file.

2. Mark the task `ACCEPTED`.

3. Update `TASK_REGISTRY.md`.

4. Update the concise implementation checkpoint.

5. Update `/docs/engineering/PROJECT_PROGRESS.md` from the authoritative workflow state.

6. Add actionable NON-BLOCKING / OUT-OF-SCOPE findings to `BACKLOG.md`.

7. Record the next safe action.

8. Stop.

Do not send NON-BLOCKING findings back for another implementation loop.

Closeout does not authorize application changes, commit, push, merge, deployment, migration execution, or production changes.

---

## 13A. Accepted-task commit workflow (effective in Workflow v2)

Under **Workflow v1 (current)**, any commit requires explicit user authorization.

Under **Workflow v2 (active once bootstrap is accepted and committed)**:
1. After a task is `ACCEPTED`, determine whether commit-worthy files exist in the working tree.
2. If none exist (e.g. read-only analysis or dry-run), proceed directly to the next task.
3. If commit-worthy files exist:
   - **Authorized Branch Gate (B-3):** Verify current branch (`git branch --show-current`) matches the task's explicit `Branch / worktree:` field. If missing or mismatched, HARD STOP. Never commit to stable (`UI/UX-fixes-after-production`) or protected branches.
   - **Mixed Index Pre-Inspection (B-2):** Check already-staged files (`git diff --cached --name-only`). If any staged file is outside the accepted task scope, HARD STOP (`PRECOMMIT_BLOCKED`). Do not commit or auto-unstage unrelated work.
   - **Selective Staging (B-2):** Stage ONLY the accepted files for this task (`git add <file>`). Verify the staged set exactly matches authorized task scope. NEVER `git add .` or force-add.
   - **Path and Sensitive Content Check (B-1):** Run `python .agents/skills/repository-commit-hygiene/scripts/check_hygiene.py`. Flagging of forbidden paths, suspected secrets, or sensitive data (`BLOCK`) is a hard stop.
   - **Staged Diff Review:** Inspect staged diff (`git diff --cached`) for unintended commentary, absolute local paths, or unaccepted edits.
   - **Atomic Commit:** Commit with message: `TASK-XXX: <concise summary>`.
   - **Record Commit Hash:** Record commit hash in `IMPLEMENTATION_CHECKPOINT.md` and `TASK_REGISTRY.md`.
4. **Push prohibition:** Auto-commit does NOT authorize push, merge, deploy, or production migration. Push is always gated by separate user authorization.

---

## 14. Checkpoint and backlog

`IMPLEMENTATION_CHECKPOINT.md` is concise global state.

Update it only for meaningful global changes such as:

- active/accepted task changes,

- phase status,

- migration-verification status,

- authorization,

- blockers/next safe action,

- reviewed revision,

- commit/push/deployment status.

Do not turn it into a session transcript.

Detailed evidence belongs in task reports/reviews.

Store actionable NON-BLOCKING and OUT-OF-SCOPE findings in:

`/docs/engineering/ai/BACKLOG.md`

Backlog items do not automatically become active scope.

---

## 15. Repository hygiene delegation

For:

- Git status/staging,

- commit preparation,

- generated files,

- accidental binaries,

- secret scanning,

- commit-message quality,

- repository cleanup,

use the relevant repository/workspace hygiene skill.

KhataSathi-specific hard rules still apply:

- preserve unrelated user work,

- never develop directly on the stable/VPS-synced branch,

- never expose real credentials,

- never commit/push/merge without explicit authorization,

- never force-add ignored AI workspace files.

---

## 16. Hard stops

STOP rather than guessing when:

- task and repository materially conflict,

- required business policy is unknown,

- a HIGH-risk invariant cannot be verified,

- an operation may touch production unexpectedly,

- migration SQL exceeds the approved shape,

- a potential live credential is encountered,

- another implementation agent is already writing the same working tree.

Never quote or expose live secrets.

---

## 17. Migration and production boundary

Migration work is HIGH risk.

Before migration execution, verify the task's approved schema/backfill/nullability contract.

Migration verification must use a disposable compatible database unless the user separately authorizes another target.

Never apply migrations to a configured non-test/production database without explicit authorization.

Never invent historical values during migration.

Never automatically:

- deploy,

- modify production over SSH,

- restart production services,

- run production migrations,

- merge into stable,

- push directly to stable,

- rewrite history.

Each requires explicit authorization.

---

## 18. Normal lifecycle

```text
bounded task
→ execution mode & planning evaluation
→ implementation plan (if PLANNED_IMPLEMENTATION)
→ implementation
→ self-review/tests
→ implementation report
→ ONE bounded senior review
→ blocker correction if needed
→ targeted verification
→ APPROVED
→ automatic closeout
→ ACCEPTED
→ hygiene-gated auto-commit (when Workflow v2 is active)
→ next bounded task
```

---

## 19. End condition

A task is finished when:

- acceptance criteria are satisfied,

- required checks are complete or honestly recorded as unavailable,

- no BLOCKER remains,

- required review/closeout is complete.

**“Another AI can think of another improvement” is not a valid reason to keep a task open.**

---

## 20. Workflow shortcuts and autopilot guardrails

### Conceptual Shortcuts:
- **`ks-senior`**: Recovers state from repository; conducts senior reviews, closeouts, and handles `READ_ONLY_DIRECT` / `SENIOR_AUTOPILOT`.
- **`ks-plan`**: Invokes `khatasathi-implementation-planner` to create `docs/engineering/ai/plans/TASK-XXX-plan.md` for `PLANNED_IMPLEMENTATION` tasks.
- **`ks-impl`**: Invokes `GEMINI.md` implementation agent with task contract and plan artifact.
- **`ks-next`**: Invokes `khatasathi-workflow-router` to inspect repository state and trigger the next deterministic transition.
- **`ks-deploy`**: Read-only deployment readiness audit; never executes deployment.

### Autopilot Loop Guardrails:
- `SENIOR_AUTOPILOT` is strictly limited to bounded LOW-risk tasks where Planning Required = NO, with zero financial, tax, auth, migration, or production exposure.
- **Three-task re-anchor rule:** After every 3 completed autopilot tasks, the senior workflow MUST re-anchor by re-reading `IMPLEMENTATION_CHECKPOINT.md`, `TASK_REGISTRY.md`, Git branch/status, and HEAD revision before continuing.
- Autopilot must halt immediately on `PLAN/REPO DRIFT`, missing plans, hygiene failure, or unresolved user decisions.
