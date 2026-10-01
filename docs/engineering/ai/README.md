# KhataSathi Local AI Workflow

This directory is the local task/handoff layer shared by repository-aware AI agents.

It is intentionally separate from the frozen Master Plan.

## Purpose

Use these files to move implementation state between:

- GPT / Codex senior reviewers,
- Gemini / Antigravity implementers,
- QA/verification agents,
- a new chat/account when quota or context changes.

Do not copy full chat histories between models.

## Structure

```text
docs/engineering/ai/
├── README.md
├── TASK_REGISTRY.md
├── BACKLOG.md
├── tasks/
│   ├── TASK_TEMPLATE.md
│   └── TASK-XXX-name.md
├── plans/
│   └── TASK-XXX-plan.md
├── reports/
│   ├── IMPLEMENTATION_REPORT_TEMPLATE.md
│   └── TASK-XXX-implementation.md
└── reviews/
    ├── REVIEW_TEMPLATE.md
    └── TASK-XXX-review.md
```

## Source-of-truth roles

### Master Plan v1.1
Defines architecture, invariants, phase boundaries, dependencies, gates, and accepted product behavior.

### Implementation checkpoint
Defines concise global live state.

### Task file
Defines one bounded implementation contract with Difficulty, Risk, Planning Required, Execution Mode, and Senior Review Required.

### Implementation plan
Defines technical execution sequence, invariants, reusable components, data/transaction flow, and tests for `PLANNED_IMPLEMENTATION` tasks.

### Implementation report
Records what the implementer actually changed and tested.

### Review file
Records one bounded senior review.

### Backlog
Records NON-BLOCKING and OUT-OF-SCOPE findings that should not expand the active task automatically.

## Ownership

### Implementation planner
May write:
- task-specific implementation plan under `docs/engineering/ai/plans/TASK-XXX-plan.md`.

Does not write application code or run migrations.

### Implementation agent
May update:
- its task-specific implementation report,
- code/tests inside authorized scope.

It should not rewrite the global checkpoint for ordinary progress.

### Reviewer
May write:
- the task-specific review file.

It should not change implementation merely because another design is aesthetically preferable.

### Senior/integration workflow
May update:
- global checkpoint,
- task registry,
- backlog disposition,

after a task is accepted or global state changes.

## Execution modes

1. `READ_ONLY_DIRECT`: Senior architecture review, inspection, or readiness checks (`ks-deploy`). Zero code mutation.
2. `SENIOR_AUTOPILOT`: Bounded LOW-risk tasks with no unresolved decisions, touching NO financial, tax, auth, migration, or production paths.
3. `DIRECT_IMPLEMENTATION`: Well-specified tasks executed directly by implementation agent without separate planning step.
4. `PLANNED_IMPLEMENTATION`: High-risk or complex tasks requiring an implementation plan before coding.

## Review loop

Normal maximum:

```text
Implementation
→ one bounded review
→ blocker fixes if needed
→ one targeted verification
→ PASS
```

Only BLOCKER prevents acceptance.

A third loop requires a genuinely new HIGH-risk issue, a material architecture change caused by the fix, or a new regression caused by the fix.

## Fresh chat/account recovery

A new agent should read:

1. `/AGENTS.md`
2. `/docs/engineering/IMPLEMENTATION_CHECKPOINT.md`
3. assigned task
4. latest report/review for that task
5. current Git status/diff
6. relevant code/tests

Do not ask the user to reconstruct the previous conversation unless repository state is insufficient.
