---
name: khatasathi-implementation-planner
description: Produce bounded, execution-ready implementation plans for KhataSathi tasks from repository state and frozen architecture.
---

# KhataSathi Implementation Planner

Use this skill when a task has `Planning Required: YES` or `Execution Mode: PLANNED_IMPLEMENTATION`.

The Implementation Planner bridges the gap between high-level task specifications and concrete code implementation, ensuring safety, data integrity, and strict adherence to frozen architecture before code is written.

---

## 1. Planner Boundaries & Non-Goals

The Implementation Planner MUST:
- Read active task contract, relevant sections of Master Plan v1.2, and actual repository code.
- Analyze existing working components and explicitly mark them `REUSE AS-IS`.
- Define the exact step-by-step technical implementation sequence.
- Write a concrete, bounded plan artifact under `docs/engineering/ai/plans/TASK-XXX-plan.md`.

The Implementation Planner MUST NOT:
- Write or modify application source code or tests.
- Reopen frozen architecture or invent new product requirements.
- Expand scope beyond the authorized task contract.
- Execute migrations or touch databases.
- Commit, push, merge, deploy, or modify production.

If the task contract materially conflicts with Master Plan v1.2 or repository code, STOP and declare:

**PLAN/REPO DRIFT**

---

## 2. Plan Artifact Convention

Implementation plans are stored locally under:

```text
docs/engineering/ai/plans/TASK-XXX-plan.md
```

Plans are local, ignored working artifacts (consistent with task contracts, reports, and reviews). They are NOT tracked in Git and must never be force-added.

---

## 3. Plan content proportional to the work

Apply frozen Master Plan28 and AGENTS7 before decomposition: plan one coherent client workflow with its necessary API/UI/tests and schema preparation. Record why any independent task is needed. A transaction/ownership/risk/dependency boundary or genuinely excessive scope justifies splitting; a code layer, document or migration execution approval gate alone does not. Do not reopen accepted work merely to rebundle it.

A required plan has no fixed section count. A concise plan may use these five groups, combined or expanded as useful:

1. **Outcome, scope and gates:** task reference, delivery priority, accepted dependencies, actual branch/revision, unresolved decisions and verification-target approvals. Link the contract rather than repeating its metadata/non-goals. Do not guess deadline or client scope.
2. **Owning code and implementation:** affected files/symbols, reusable pieces marked `REUSE AS-IS`, partial work on resume, exact sequence through all scoped layers. Internal steps do not become separate tasks.
3. **Invariants and failure behavior:** applicable access/privacy, state transitions, transaction boundaries, audit, locking/conditional claims, retry/ambiguous-outcome semantics, storage retention and zero partial posting. Include precise schema/backfill/nullability/SQL shape when relevant. Mark irrelevant concerns briefly; do not fill headings with boilerplate.
4. **Acceptance evidence:** map each criterion to exact meaningful commands/fixtures/runtime paths. Fault tests must prove the affected branch ran; race fixtures overlap competing decisions; rollback fixtures stage transaction-local document/audit state and commit/discard it. Identify existing evidence reusable for unchanged content and connected-versus-mocked limits. Identify unavailable targets before coding; preparation grants no migration/fixture permission.
5. **Completion and handoff:** open blockers/stop conditions and concrete implementation entry point, required final startup/schema checks and one bounded review. Link existing checks/rules; report only changed decisions.

Expand HIGH-risk invariants/transactions/auth/retry/failures until implementation is unambiguous. Concision is not permission to omit them. HIGH-risk planning remains mandatory under AGENTS.md; an implementation-grade contract can supply linked content, but the required plan artifact must exist and be complete before coding.

The senior may prepare/self-review this artifact in the current session using this skill. A separate planner agent or user invocation is unnecessary. Do not silently turn the planner role into an application writer. If the same authorized agent later changes roles, recover implementation instructions and verify the complete plan before source edits.

---

## 4. Implementation Agent Handoff

Once the plan artifact is written and self-reviewed:

1. Update the task contract's `Implementation notes` indicating that planning is complete and referencing the plan artifact.
2. Transition the task status to `PLAN_READY_FOR_IMPLEMENTATION`.
3. Hand off to the Implementation Agent (`ks-impl` / `GEMINI.md`).
4. The Implementation Agent reads the complete artifact and linked relevant authority, implements the whole scoped outcome, verifies its acceptance criteria, and writes a concise report referencing exact final-content evidence. Reviewer reuse follows AGENTS12; incomplete or questionable evidence is verified rather than assumed.
