---
name: khatasathi-workflow-router
description: Route KhataSathi AI engineering workflows deterministically from repository state without relying on chat history.
---

# KhataSathi Workflow Router

Use this skill to determine the exact next engineering action for any KhataSathi agent session directly from repository state.

The repository is shared engineering memory; chat history is temporary context.

Standing user authorization (2026-10-04) in AGENTS.md applies to both senior and implementation workflows: proceed with bounded work conforming to the frozen Master Plan and its dependencies without another implementation approval. Reconcile stale task/checkpoint authorization fields rather than declaring authorization drift. Ask for authorization only for work outside or changing the frozen plan; unresolved business decisions and genuine plan/repository conflicts still stop work. Required contracts, planning, review, hygiene, and separate migration/production/push/merge/deployment gates remain unchanged.

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
9. Affected code, tests, and relevant sections of Master Plan v1.2

If the repository state materially conflicts with the active task or frozen architecture, STOP and declare:

**PLAN/REPO DRIFT**

---

## 3. Delivery sizing and execution modes

Before creating another task, apply AGENTS7 and frozen Master Plan28: select a complete client workflow and its actual prerequisites. Group API, UI, tests and schema preparation when they share a coherent test/review boundary. Record a concrete split rationale; an operation-specific migration/fixture approval gate does not by itself require splitting source work. Follow dependency gates rather than numeric phase order.

Required plans can be written/self-reviewed by the senior in the same session using the planner skill, then handed off with the concrete artifact. Do not require another user shortcut just to advance an already authorized transition. Role handoffs do not authorize subagents or concurrent writers. The `ks-start` v3 mission follows section 9 for exactly one task; manual roles remain independent. `ks-senior` reviews only; `ks-next` owns closeout/advance. HIGH/MEDIUM implementation is assigned to the worker after planning, never silently reclassified as senior autopilot.

Keep one contract, required plan, concise report and bounded review per deliverable. Link shared rules/evidence; avoid duplicating the architecture or adding documentation-only audit tasks when the current deliverable can include the integrated exit check.

### The Four Execution Modes

Every bounded task defines its execution mode and planning requirement:

| Execution Mode | When to Use | Assigned Role | Planning Required |
|---|---|---|---|
| `READ_ONLY_DIRECT` | Architecture inquiry, dry-runs, deployment readiness check (`ks-deploy`), or preflight verification. Zero disk mutation. | Senior / Reviewer | NO |
| `SENIOR_AUTOPILOT` | Bounded LOW-risk tasks with no unresolved decisions, touching NO financial, tax, auth, migration, or production paths, where senior workflow permits direct acceptance. | Senior Autopilot | NO |
| `DIRECT_IMPLEMENTATION` | Well-specified tasks with complete implementation-grade contracts and self-contained scope. | Implementation Agent | NO |
| `PLANNED_IMPLEMENTATION` | All HIGH-risk tasks, or tasks involving schema/migrations, multi-step transaction flows, financial integrity, or complex refactors. | Implementation Planner first, then Implementation Agent | YES |

### Rules:
- HIGH-risk tasks require a complete plan before implementation under AGENTS.md. Use an existing implementation-grade contract as linked plan content; write only missing decisions instead of adding ceremonial sections or another user invocation.
- Never downgrade a task's Risk or Difficulty merely to retain `SENIOR_AUTOPILOT`.
- Do not route autopilot work to Gemini merely because a task exists.

---

## 4. Deterministic Repository States & Transitions

Evaluate the recovered repository facts against these mutually exclusive states to choose the next action:

Evaluate report/review and actual diff before trusting stale status labels: an implementation report awaiting review or documented blocker fixes takes precedence over an old READY/PLAN_READY label. Reconcile ordinary stale workflow metadata; genuine architecture/repository drift still stops work.


### State Definitions & Actions:

1. **`NO_ACTIVE_TASK`**
   - *Condition:* `CURRENT_TASK` in checkpoint is empty, None, or points to an already `ACCEPTED` task with no active work.
   - *Action:* Senior identifies next eligible task from roadmap/backlog, drafts a bounded task contract under `docs/engineering/ai/tasks/`, updates checkpoint and registry to `READY`, then evaluates execution mode.

2. **`READY_FOR_PLANNING`**
   - *Condition:* Active task status is `READY` or `IN_PROGRESS`, `Planning Required: YES`, and the required plan is missing or incomplete under `docs/engineering/ai/plans/TASK-XXX-plan.md`.
   - *Action:* Use the `khatasathi-implementation-planner` skill to create the required plan now when operating as senior/planner; otherwise hand off with the exact task and missing decisions. No extra user invocation is required for authorized planning.

3. **`PLAN_READY_FOR_IMPLEMENTATION`**
   - *Condition:* Active task requires planning, plan file `docs/engineering/ai/plans/TASK-XXX-plan.md` exists and is complete, but implementation has not started or completed.
   - *Action:* Hand off to Implementation Agent (`ks-impl` / `GEMINI.md`).

4. **`IMPLEMENTATION_IN_PROGRESS`**
   - *Condition:* Code edits exist in working tree matching active task; implementation report not finalized.
   - *Action:* Implementation agent completes minimal robust change, runs required tests, writes implementation report under `docs/engineering/ai/reports/TASK-XXX-implementation.md`, and marks report `COMPLETE — AWAITING SENIOR REVIEW`.

5. **`AWAITING_REVIEW`**
   - *Condition:* Implementation report is complete; no review file exists under `docs/engineering/ai/reviews/TASK-XXX-review.md`.
   - *Action:* Senior reviewer performs ONE bounded review against task contract, frozen architecture, diff, and tests. Reuse sufficient final-content/target evidence with attribution; rerun only relevant changed, missing, failed or doubtful checks under AGENTS12. Writes review file classifying findings into BLOCKER, NON-BLOCKING, OUT OF SCOPE, QUESTION.

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
    - *Condition:* Material disagreement between task contract, frozen Master Plan v1.2, and actual repository code.
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

- **`ks-senior`**: Canonical Senior reviewer. Independently inspect implementation/evidence and write the canonical review under AGENTS12. Return ACCEPTED (canonical APPROVED, zero blockers) or FIX_REQUIRED and stop. Do not plan, implement, closeout, commit or begin another task.
- **`ks-start`**: One-task Codex mission controller; execute section 9 in the current session.
- **`ks-plan`**: Implementation Planner entry point. Invokes the `khatasathi-implementation-planner` skill to draft a concrete plan for `PLANNED_IMPLEMENTATION` tasks.
- **`ks-impl`**: Implementation Agent entry point (`GEMINI.md`). Reads task contract and plan artifact, implements code and tests, writes report.
- **`ks-next`**: Router execution. Inspects repository state, identifies current state (1–13), and executes or hands off the next deterministic action.
- **`ks-deploy`**: Deployment readiness audit. Read-only inspection of migrations, hygiene, build, and environment checklists. NEVER executes a deployment.

---

## 8. Special-Case Recovery Procedures

- **Quota Expiry or Model Switch:** When switching agents or accounts, the new agent runs `ks-next`, re-reading repository state from files without asking the user to summarize previous chat.
- **Blocked Work:** If a task is blocked by external dependencies, record blockers in task file and checkpoint, set task status to `BLOCKED`, and select the next unblocked task.
- **Disposable Migration Testing:** Migration tasks (`HIGH` risk) must be verified against a local disposable database container. Never run test migrations against production or configured non-test databases.
- **Independent Architecture Review:** Read-only inspection against Master Plan v1.2. Any discovered discrepancy is classified into `BACKLOG.md` or flagged as `PLAN/REPO DRIFT`.

---

## 9. ks-start: one-task Codex mission (2026-10-07)

Codex owns WHEN existing roles run; the roles own HOW. Python supplies facts, invocation, evidence and safety, never a role-executing orchestration loop. One invocation binds exactly ONE task. Manual `ks-plan`, `ks-impl`, `ks-senior`, `ks-next` and legacy doctor/status/dry-run/manual run remain independent. Never invoke nested Codex or legacy `run --once --live` to simulate logical roles. Current explicit user restrictions always override lifecycle defaults; this tooling correction does not authorize live execution or commit.

This section is the ONE authoritative mission definition. Exact `ks-start` in
repository Codex chat is dispatched by AGENTS20, using the deterministic
`chat-entrypoint` route descriptor, into this same session. The helper resolves
instructions/facts; it is neither an IDE input listener nor a second controller.
Read and execute this section, not a copied terminal prompt. Logical roles
return control to ks-start; a reviewer-only stop ends that role, while manual
ks-senior stops its own invocation.

Emit concise `[ROLE] ks-plan/ks-impl/ks-senior/ks-next` events as each role begins,
alongside the existing REANCHOR/DELEGATE/RETURN/VERIFY/REVIEW/mission events.

### Bind, reuse roles, complete one mission

1. Recover state in section 2 order, inspect actual diff and call `python -m tools.ks_supervisor mission begin --json`. Emit `[KS-START]` / `[REANCHOR]` and retain its `mission_id` for EVERY automated tool call. Active partial work (including TASK-2A-002) is the mission; continue it intact. If a runtime interruption resumes the same invocation, reuse its handle/history, never reset budgets. Accepted tasks never reopen.
2. If unbound, obtain existing task-definition instructions with `role-instructions ks-next --action TASK_DEFINITION --mission <handle> --json`; execute them here using section 4 NO_ACTIVE_TASK authority. Register exactly one complete authorized task, then `mission bind --mission <handle> --task <id> --json`. After binding, a different task ID is prohibited throughout this invocation, even after acceptance. Record task-definition outcome. If no safe task exists, report the missing authority.
3. Obtain each needed logical role through `role-instructions <ks-plan|ks-senior|ks-next> --task <id> --mission <handle> --json` and execute those returned existing instructions in this session. This surface reuses CodexAdapter builders and installed role skills; do not invent duplicate role prompts. For ks-next supply `--action CLOSEOUT`; for correction review supply `--action TARGETED_VERIFICATION`. Manual calls may omit `--mission`.
4. Missing/incomplete required plan -> ks-plan using the existing planner skill; write/self-review the physical plan with final disposition IMPLEMENTATION-READY and record planning outcome. Ready/partial -> ks-impl through `delegate-gemini --task <id> --mission <handle> --mode implement --json`. Its packet reuses AntigravityAdapter.build_prompt / GEMINI.md with a thin workspace-only overlay and artifact context. Worker invocation is synchronous; one writer. Emit `[DELEGATE]` / `[RETURN]`, inspect real changes/report, preserve existing partial/unrelated work. Never regenerate an already-ready plan to restart implementation.
5. Codex inspects actual changes after EVERY worker return; run full product verification at an appropriate implementation boundary, not between unfinished slices. For large/partial tasks, use multiple bounded turns within the SAME task/mission/ready plan. Write a current-content continuation JSON with `task_id`, `mission_id`, `content_identity`, `plan_sha256`, exact `slice`, `instructions`, `preserve_completed`, `files` (at most 12 exact product paths), `plan_steps`, `acceptance_criteria`, and `remaining_slices`; pass `--continuation <path>` to delegate-gemini. Inspect diff/report against the plan; record `record-worker-checkpoint --task <id> --mission <handle> --run <worker-run> --assessment <path> --json`. The assessment binds current content/plan and records `meaningful_progress`, `verification_boundary`, `inspection`, `progressed_plan_steps`, `acceptance_criteria`, `remaining_slices`. A meaningful valid timeout becomes PRODUCTIVE_CHECKPOINT and continues with the smallest unfinished slice; no infrastructure retry is consumed. Changed bytes/provider status alone are pending inspection, not progress or acceptance. Preserve completed files/interfaces and cumulative report; Codex may reconstruct a timeout's missing report. No new task, plan regeneration, per-slice closeout or commit. Worker remains workspace-edit-only; no shell/tests/Git/Prisma/migrations/servers/deploy. Record each run, content identity, changed paths, material plan/criteria progress, report update and remaining slices. Only BOUNDARY_READY proceeds to Codex source verification; it does not waive any checks or Senior review. Required startup/configured schema and connected-target authority remain AGENTS12 requirements. Supported reviewed source checks use `verify-source --task <id> --mission <handle> --content-identity <current inspect identity> --source-reviewed --command "<check>" --json`. Unsupported local checks return to Codex for safe direct execution under existing authorization. Record direct check commands/output/revision/target and limits; retain unaffected valid evidence. Empty checks do not certify completion.
6. Ordinary source/build/typecheck/Prisma/test failure -> analyze exact diagnostic, write a repository-local correction JSON (`task_id`, current `content_identity`, `failures` with stable ID/diagnostic/correction or expected behavior), and `delegate-gemini ... --mode fix --correction <relative path> --mission <handle> --json`. Senior FIX_REQUIRED -> reuse latest canonical blocker context through the same fix helper. Correct only listed failures/blockers and direct regressions; run targeted verification and existing targeted Senior review. Emit `[VERIFY]` / `[CORRECTION]` / `[REVIEW]`. The reviewer writes canonical APPROVED/FIX_REQUIRED; its displayed ACCEPTED means review acceptance, before ks-next closeout. Do not replace Senior authority with a worker report or a cycle record.
7. On valid Senior approval with zero blockers and sufficient final-content evidence, invoke existing ks-next CLOSEOUT role (section 4 state 8 / AGENTS13). Record physical accepted closeout via `record-cycle --task <id> --mission <handle> --phase closeout --outcome ACCEPTED --json`. Apply existing section 5 accepted-scope branch/index/hygiene/staged-diff/atomic-commit policy under current authorization. Never use the legacy runner's all-dirty-files commit helper. Stage only reviewed accepted files, preserve unrelated index/worktree data, never push/merge/deploy/migrate. Record actual commit metadata under existing authority. If commit is explicitly prohibited, stop with the precise authorization gate; never claim mission completion.
8. After successful commit, determine the next safe candidate from existing roadmap/backlog/dependencies without registering/activating it. Call `mission finish --mission <handle> --accepted-file <path> [--accepted-file <path>] --next-task <candidate-id> --next-title "<title>" --json`. This re-anchors ONCE from observed state, validates accepted authority/closeout and exact atomic commit against mission initial HEAD, reports truthful CLEAN or DIRTY with preserved unrelated paths, and seals the handle. Do not separately start another re-anchor loop. No next contract/plan/implementation or task-definition cycle may occur. STOP successfully at the task boundary; another user invocation of ks-start is needed for the candidate. If no safe candidate can be determined, report that uncertainty without inventing an ID.

For a task with no commit-worthy changes, use the existing section 4 accepted/no-changes rule: report acceptance, closeout and commit NOT APPLICABLE, then stop at this same task boundary; never create an empty commit merely to satisfy output. The commit-validating finish helper is for missions with an actual task commit.

### Budgets and human stops

Retain SUP006 `record-cycle` / CycleLedger evidence and limits. All automated worker/verification/cycle calls carry the bound mission handle; manual roles do not require one. Record logical planning/review/closeout and direct verification outcomes; physical canonical reviews and append-only history remain authoritative. Runtime records live in resolved Git ks-runtime/v3, never tracked source. Python never authors product contracts/plans/reviews/closeout, commits or invokes Codex.

Emit `[HUMAN INPUT REQUIRED]` with Reason, Requested decision/authorization, Evidence and Safe resume action for business ambiguity, drift, migration/DB/fixture target authority, production/external/destructive operations, credentials/login/quota, unsupported business/provenance policy, protected-file/hygiene violations or exhausted budgets. Ordinary implementation/check/review failures and partial work self-recover within the bound task.

- Identical infrastructure signature WITHOUT productive progress: initial failure plus at most TWO retries; preserve partial work and target/permission boundaries. Hash-bound progress assessments append to original records; never delete failures or reset correction budgets. Timeouts without observable product changes count as no-effect, including bounded turns. TWO consecutive no-progress turns stop; auth/quota/protected/provenance and genuine gates remain immediate stops. A productive checkpoint cannot resolve these gates.
- Authentication/quota/genuine human gate: stop immediately.
- TWO consecutive no-effect worker returns: stop for diagnosis.
- THREE correction cycles without strict reduction of the stable remaining-blocker set: stop. Renaming/replacing blockers is not reduction; track source-check and Senior scopes separately.
- Hard ceiling: 60 total recorded cycles, persistent across resumes. No silent reset; explicitly authorized recovery preserves archived evidence.

### Entry points and final output

PRIMARY UX: open Codex IDE/chat in this repository and type exactly `ks-start`. AGENTS20 resolves router9 in the current session, with no PowerShell or user-run Python/role commands. Genuine authorization questions and replies stay in this conversation; preserve the mission handle and history, re-inspect, and continue only within the specific reply's authority.

SECONDARY terminal fallback: `.\ks-start.cmd` or `.\tools\ks-start.ps1` forwards the exact same `ks-start` token to ONE new interactive Codex CLI process/session at this repository cwd. That new session reads AGENTS20 and resolves this same section; it does not share IDE conversation memory, so it recovers repository/runtime state. Workflow semantics are identical. Dot-source `.\tools\ks-entrypoints.ps1` once to expose bare `ks-start` and reviewer-only `ks-senior` in that PowerShell session. No global profile/PATH changes. Never invoke a launcher from inside an existing Codex mission.

Success output includes `[MISSION COMPLETE]`, task/result ACCEPTED, verification summary with limits, Senior ACCEPTED/zero blockers, closeout COMPLETE, actual commit SHA/message (or justified NOT APPLICABLE), truthful working-tree state, next candidate ID/title and `KS-START STOPPED AT TASK BOUNDARY. Run ks-start to begin the next task.` No CLEAN claim when unrelated edits remain. No success claim on a gated/failed commit or incomplete required evidence.
