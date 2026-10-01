---
name: khatasathi-workflow-router
description: Route KhataSathi AI engineering workflows deterministically from repository state without relying on chat history.
---

# KhataSathi Workflow Router

Use this skill to determine the exact next engineering action for any KhataSathi agent session directly from repository state.

The repository is shared engineering memory; chat history is temporary context.

---

## 1. Effective Workflow Version Gating

Before any Workflow v2 routing, state evaluation, senior autopilot execution, or auto-commit occurs, inspect `WORKFLOW_VERSION_EFFECTIVE` in `/docs/engineering/IMPLEMENTATION_CHECKPOINT.md`:

- **Semantic Whole-Field Validation:** Workflow Version must be parsed from canonical repository state. The numeric prefix alone is insufficient; the whole field is validated semantically to ensure descriptive text fully agrees with the numeric version.
- **Contradictory or Ambiguous Text is a Hard Stop:** If `WORKFLOW_VERSION_EFFECTIVE` is missing, blank, malformed, contradictory (e.g. `2 or 1`, `1 or 2`, `2 (not active)`, `2 (v2 inactive)`, `2 (old workflow)`, `1 (Workflow v2 active)`), or cannot be confidently determined: HARD STOP (`CANNOT_DETERMINE_WORKFLOW_STATE`). Never guess, attempt fuzzy interpretation, or silently assume v2.
- **Version 1 Invariant (Old Workflow):** When the checkpoint indicates Workflow Version 1 or that Workflow v2 is not active (e.g. `1`, `1 (current old workflow; v2 bootstrap not active)`), ANY task operating under Version 1 must remain governed by the old workflow and must never enter Workflow v2 auto-routing, senior autopilot, or auto-commit. The router yields `ACTIVATION_BOUNDARY_OLD_WORKFLOW`. This gate applies unconditionally to ALL Version 1 tasks (including bootstrap `TASK-WF-001`, accepted tasks, and tasks marked autopilot), regardless of task status, execution mode, or commit readiness.
- **Workflow v2 Active Gate:** Workflow v2 routing is allowed ONLY when repository state unambiguously says Workflow v2 is active (e.g. `2`, `2 (Workflow v2 active)`). Only then do the deterministic routing, implementation planning, autopilot loops, and hygiene-gated auto-commit rules defined in this skill take full effect.

---

## 2. Repository State Recovery

Recover workflow state strictly in this order without querying or trusting chat memory:

1. `/AGENTS.md` (authority, safety contracts, invariants)
2. `/docs/engineering/IMPLEMENTATION_CHECKPOINT.md` (concise global state, phase, active task, branch)
3. `/docs/engineering/ai/TASK_REGISTRY.md` (task lifecycle tracking)
4. Active task contract under `/docs/engineering/ai/tasks/`
5. Task implementation plan (if `PLANNED_IMPLEMENTATION`) under `/docs/engineering/ai/plans/`
6. Latest task implementation report under `/docs/engineering/ai/reports/`
7. Latest task review under `/docs/engineering/ai/reviews/`
8. Git branch, status (`git status --short`), and staged/unstaged diffs
9. Affected code, tests, and relevant sections of Master Plan v1.1

If the repository state materially conflicts with the active task or frozen architecture, STOP and declare:

**PLAN/REPO DRIFT**

---

## 3. The Four Execution Modes

Every bounded task defines its execution mode and planning requirement:

| Execution Mode | When to Use | Assigned Role | Planning Required |
|---|---|---|---|
| `READ_ONLY_DIRECT` | Architecture inquiry, dry-runs, deployment readiness check (`ks-deploy`), or preflight verification. Zero disk mutation. | Senior / Reviewer | NO |
| `SENIOR_AUTOPILOT` | Bounded LOW-risk tasks with no unresolved decisions, touching NO financial, tax, auth, migration, or production paths, where senior workflow permits direct acceptance. | Senior Autopilot | NO |
| `DIRECT_IMPLEMENTATION` | Well-specified tasks with complete implementation-grade contracts and self-contained scope. | Implementation Agent | NO |
| `PLANNED_IMPLEMENTATION` | All HIGH-risk tasks, or tasks involving schema/migrations, multi-step transaction flows, financial integrity, or complex refactors. | Implementation Planner first, then Implementation Agent | YES |

### Rules:
- Risk alone does not replace planning classification; HIGH-risk tasks normally require planning unless an implementation-grade contract explicitly justifies why not.
- Never downgrade a task's Risk or Difficulty merely to retain `SENIOR_AUTOPILOT`.
- Do not route autopilot work to Gemini merely because a task exists.

---

## 4. Deterministic Repository States & Transitions

Evaluate the recovered repository facts against these mutually exclusive states to choose the next action:

```text
[NO_ACTIVE_TASK]
       │
       ▼
[READY_FOR_PLANNING]  ──(Planning Required == YES)──►  Invoke Planner (ks-plan)
       │                                                         │
       │ (Planning Required == NO)                               ▼
       ▼                                               [PLAN_READY_FOR_IMPLEMENTATION]
[DIRECT_IMPLEMENTATION]                                          │
       │                                                         │
       └─────────────────────────┬───────────────────────────────┘
                                 ▼
                    [IMPLEMENTATION_IN_PROGRESS] (ks-impl)
                                 │
                                 ▼
                         [AWAITING_REVIEW] (ks-senior)
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
       [UNRESOLVED_BLOCKERS]             [APPROVED_AWAITING_CLOSEOUT]
                 │                               │
                 ▼                               ▼
 [FIX_AWAITING_TARGETED_VERIFICATION]       [ACCEPTED]
                                                 │
                                 ┌───────────────┴───────────────┐
                                 ▼                               ▼
                [ACCEPTED_NO_COMMIT_WORTHY_CHANGES]  [ACCEPTED_WITH_COMMIT_WORTHY_CHANGES]
                                 │                               │
                                 ▼                               ▼
                            [NEXT TASK]               Invoke check_hygiene.py
                                                                 │
                                                 ┌───────────────┴───────────────┐
                                                 ▼                               ▼
                                         [PRECOMMIT_BLOCKED]              [AUTO-COMMIT]
                                                 │                               │
                                            STOP & REPORT                   [NEXT TASK]
```

### State Definitions & Actions:

1. **`NO_ACTIVE_TASK`**
   - *Condition:* `CURRENT_TASK` in checkpoint is empty, None, or points to an already `ACCEPTED` task with no active work.
   - *Action:* Senior identifies next eligible task from roadmap/backlog, drafts a bounded task contract under `docs/engineering/ai/tasks/`, updates checkpoint and registry to `READY`, then evaluates execution mode.

2. **`READY_FOR_PLANNING`**
   - *Condition:* Active task status is `READY` or `IN_PROGRESS`, `Planning Required: YES`, and no plan file exists under `docs/engineering/ai/plans/TASK-XXX-plan.md`.
   - *Action:* Hand off to Implementation Planner (`ks-plan`) using the `khatasathi-implementation-planner` skill.

3. **`PLAN_READY_FOR_IMPLEMENTATION`**
   - *Condition:* Active task requires planning, plan file `docs/engineering/ai/plans/TASK-XXX-plan.md` exists and is complete, but implementation has not started or completed.
   - *Action:* Hand off to Implementation Agent (`ks-impl` / `GEMINI.md`).

4. **`IMPLEMENTATION_IN_PROGRESS`**
   - *Condition:* Code edits exist in working tree matching active task; implementation report not finalized.
   - *Action:* Implementation agent completes minimal robust change, runs required tests, writes implementation report under `docs/engineering/ai/reports/TASK-XXX-implementation.md`, and marks report `COMPLETE — AWAITING SENIOR REVIEW`.

5. **`AWAITING_REVIEW`**
   - *Condition:* Implementation report is complete; no review file exists under `docs/engineering/ai/reviews/TASK-XXX-review.md`.
   - *Action:* Senior reviewer performs ONE bounded review against task contract, frozen architecture, diff, and tests. Writes review file classifying findings into BLOCKER, NON-BLOCKING, OUT OF SCOPE, QUESTION.

6. **`UNRESOLVED_BLOCKERS`**
   - *Condition:* Review file lists one or more concrete BLOCKER items (`B-1`, etc.).
   - *Action:* Implementation agent fixes ONLY the listed blockers and direct regressions, records fixes in implementation report, and requests targeted verification.

7. **`FIX_AWAITING_TARGETED_VERIFICATION`**
   - *Condition:* Blocker fixes reported by implementer; awaiting re-review.
   - *Action:* Senior reviewer verifies ONLY previously listed blockers and direct regressions. Does NOT restart full review.

8. **`APPROVED_AWAITING_CLOSEOUT`**
   - *Condition:* Review returns APPROVED with zero BLOCKERS.
   - *Action:* Senior workflow marks task `ACCEPTED` in task contract, updates `TASK_REGISTRY.md`, updates `IMPLEMENTATION_CHECKPOINT.md`, records backlog items in `BACKLOG.md`, updates `PROJECT_PROGRESS.md` if authorized.

9. **`ACCEPTED_WITH_COMMIT_WORTHY_CHANGES`**
   - *Condition:* Task is `ACCEPTED`; working tree contains changes belonging to the accepted task.
   - *Action:* Trigger Hygiene-Gated Auto-Commit workflow (Section 5).

10. **`ACCEPTED_NO_COMMIT_WORTHY_CHANGES`**
    - *Condition:* Task is `ACCEPTED` (e.g. read-only verification, documentation-only research, or external check); no trackable file modifications.
    - *Action:* Transition directly to next safe action / task.

11. **`PRECOMMIT_BLOCKED`**
    - *Condition:* Hygiene check (`check_hygiene.py`) or staged inspection detects forbidden paths, secrets, unaccepted changes, or wrong branch.
    - *Action:* STOP and report exact violations. Do NOT commit. Do NOT force-add. Preserve unrelated user work.

12. **`PLAN_REPO_DRIFT`**
    - *Condition:* Material disagreement between task contract, frozen Master Plan v1.1, and actual repository code.
    - *Action:* STOP immediately and report drift. Await user authorization for plan/architecture alignment.

13. **`USER_BUSINESS_DECISION_REQUIRED`**
    - *Condition:* Missing business policy, unresolved tax/VAT rule, or undefined product invariant.
    - *Action:* STOP and present the specific decision to the user.

---

## 5. Hygiene-Gated Auto-Commit Workflow

When Workflow v2 is active and a task reaches `ACCEPTED_WITH_COMMIT_WORTHY_CHANGES`:

1. **Authorized Branch Gate (B-3):**
   - Recover the expected authorized branch directly from the active task contract field (`Branch / worktree:`).
   - If the field is missing, blank, or ambiguous: HARD STOP (`PRECOMMIT_BLOCKED: missing or ambiguous authorized branch in task contract`).
   - Query the actual current branch (`git branch --show-current`).
   - If current branch != authorized task branch: HARD STOP (`PRECOMMIT_BLOCKED: branch mismatch — expected '<authorized-branch>', found '<current-branch>'`). Do NOT silently switch branches.
   - Ensure current branch is NOT the stable/VPS branch (`UI/UX-fixes-after-production`) or a protected branch (`main`, `master`).

2. **Mixed Index Pre-Inspection (B-2):**
   - Determine the exact accepted task commit scope (the specific list of files changed and accepted for this task).
   - Inspect currently staged files (`git diff --cached --name-only`).
   - If ANY already-staged file is outside the authorized task commit scope:
     - HARD STOP (`PRECOMMIT_BLOCKED: mixed index detected — files outside authorized task scope are already staged`).
     - Report the unexpected staged paths.
     - Do NOT commit. Do NOT automatically unstage or discard unrelated user work.
     - Require user resolution or explicit clean staging before proceeding.

3. **Selective Staging (B-2):**
   - Stage ONLY the explicitly accepted files belonging to the task commit scope:
     ```powershell
     git add <file1> <file2>
     ```
   - NEVER use `git add .`, `git add -A`, or force-add (`git add -f`).
   - Post-staging check: verify that the complete staged set (`git diff --cached --name-only`) EXACTLY matches the authorized task commit scope. If any extra or missing files are detected, STOP.

4. **Hygiene & Content-Level Audit (B-1):**
   - Run the path and sensitive-content checker:
     ```powershell
     python .agents/skills/repository-commit-hygiene/scripts/check_hygiene.py
     ```
     Must return clean exit code 0 (`PASS: path and content policy`).
   - If any path or suspected secret/credential is flagged (`BLOCK [index:content]`), HARD STOP immediately.
   - Inspect the staged diff (`git diff --cached`) for unintended commentary, absolute paths, or unaccepted edits.

5. **Atomic Commit:**
   - Commit with structured task reference:
     ```powershell
     git commit -m "TASK-XXX: <concise summary of accepted change>"
     ```
6. **Record Metadata:**
   - Capture commit hash (`git rev-parse HEAD`).
   - Record commit hash in `IMPLEMENTATION_CHECKPOINT.md` (`LAST_IMPLEMENTATION_COMMIT`) and `TASK_REGISTRY.md`.

7. **Strict Push Prohibition:**
   - STOP after commit.
   - NEVER automatically `git push`, merge into stable, deploy, or run production migrations. Push remains explicitly gated by separate user authorization.

---

## 6. Autopilot Loop & Safety Guardrails

For continuous `SENIOR_AUTOPILOT` loops:
- **Eligible Tasks Only:** Strictly bounded, LOW risk, Planning Required = NO, zero financial/tax/migration/production impact.
- **Three-Task Re-Anchor:** After every 3 completed autopilot tasks, the senior workflow MUST re-anchor by re-reading:
  - `IMPLEMENTATION_CHECKPOINT.md`
  - `TASK_REGISTRY.md`
  - `git branch` and `git status`
  - Current `HEAD` revision
  - Next authorized roadmap action
- **Hard Stops:** An autopilot loop must terminate immediately upon hitting any of:
  - Task risk is MEDIUM or HIGH
  - `Planning Required: YES`
  - Precommit hygiene violation
  - `PLAN/REPO DRIFT`
  - Unresolved business or architectural question
  - Potential credential or secret detected

---

## 7. Conceptual Shortcuts

These standard shortcut tokens invoke specific role behaviors from repository state:

- **`ks-senior`**: Senior engineer entry point. Recovers state, conducts reviews, performs closeouts, or handles `READ_ONLY_DIRECT` / `SENIOR_AUTOPILOT` tasks.
- **`ks-plan`**: Implementation Planner entry point. Invokes the `khatasathi-implementation-planner` skill to draft a concrete plan for `PLANNED_IMPLEMENTATION` tasks.
- **`ks-impl`**: Implementation Agent entry point (`GEMINI.md`). Reads task contract and plan artifact, implements code and tests, writes report.
- **`ks-next`**: Router execution. Inspects repository state, identifies current state (1–13), and executes or hands off the next deterministic action.
- **`ks-deploy`**: Deployment readiness audit. Read-only inspection of migrations, hygiene, build, and environment checklists. NEVER executes a deployment.

---

## 8. Special-Case Recovery Procedures

- **Quota Expiry or Model Switch:** When switching agents or accounts, the new agent runs `ks-next`, re-reading repository state from files without asking the user to summarize previous chat.
- **Blocked Work:** If a task is blocked by external dependencies, record blockers in task file and checkpoint, set task status to `BLOCKED`, and select the next unblocked task.
- **Disposable Migration Testing:** Migration tasks (`HIGH` risk) must be verified against a local disposable database container. Never run test migrations against production or configured non-test databases.
- **Independent Architecture Review:** Read-only inspection against Master Plan v1.1. Any discovered discrepancy is classified into `BACKLOG.md` or flagged as `PLAN/REPO DRIFT`.
