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
- Read active task contract, relevant sections of Master Plan v1.1, and actual repository code.
- Analyze existing working components and explicitly mark them `REUSE AS-IS`.
- Define the exact step-by-step technical implementation sequence.
- Write a concrete, bounded plan artifact under `docs/engineering/ai/plans/TASK-XXX-plan.md`.

The Implementation Planner MUST NOT:
- Write or modify application source code or tests.
- Reopen frozen architecture or invent new product requirements.
- Expand scope beyond the authorized task contract.
- Execute migrations or touch databases.
- Commit, push, merge, deploy, or modify production.

If the task contract materially conflicts with Master Plan v1.1 or repository code, STOP and declare:

**PLAN/REPO DRIFT**

---

## 2. Plan Artifact Convention

Implementation plans are stored locally under:

```text
docs/engineering/ai/plans/TASK-XXX-plan.md
```

Plans are local, ignored working artifacts (consistent with task contracts, reports, and reviews). They are NOT tracked in Git and must never be force-added.

---

## 3. Required Plan Artifact Sections

Every plan artifact created by the Implementation Planner must contain the following structured sections:

```markdown
# TASK-XXX Implementation Plan: <Task Title>

## 1. Task Metadata
- Task ID: TASK-XXX
- Risk: LOW / MEDIUM / HIGH
- Difficulty: 1–10
- Execution Mode: PLANNED_IMPLEMENTATION
- Master Plan References: Section X.X

## 2. Invariants & Architectural Alignment
- List frozen invariants from Master Plan v1.1 governing this subsystem.
- Confirm schema, financial, auth, and state boundaries.

## 3. Existing Code Analysis & Reusability
- Identify existing functions, types, routes, controllers, and services.
- Explicitly mark correct existing components: `REUSE AS-IS`.
- Identify partial work already completed in working tree if resuming.

## 4. Exact File & Symbol Changes
- Specific file paths to be created, modified, or deleted.
- Exact functions, classes, interfaces, types, and schema fields to add or adjust.

## 5. Step-by-Step Implementation Sequence
1. Step 1: Types and domain models.
2. Step 2: Service layer logic and validation.
3. Step 3: Controller and route integration.
4. Step 4: Focused test suite creation/extension.

## 6. Data & Transaction Flow
- Database transaction boundaries (`prisma.$transaction`).
- Atomicity guarantees and rollback behavior on failure.
- Audit log entry creation and timing.

## 7. Authorization & Role Boundaries
- Enforced route guards (`requireRole`, `denyStaff`).
- Field-level masking or role-specific access rules.
- Isolation from weaker privilege boundaries (e.g. cashier vs admin).

## 8. Concurrency & Idempotency Rules
- Unique constraints, locking, or idempotent retry behavior.
- Storage capacity boundaries (e.g. Unicode code-point counts, UTF-8 byte limits).

## 9. Migration & Schema Contract (if applicable)
- Disposable database verification requirements.
- Additive/nullable column rules; no destructive drop operations.

## 10. Required Tests & Verification Commands
- Exact test files and commands to execute:
  - `pnpm --dir backend build`
  - `node --test backend/dist/tests/<test-file>.test.js`
  - `pnpm --dir backend test`
  - `git diff --check`
  - `python .agents/skills/repository-commit-hygiene/scripts/check_hygiene.py`

## 11. Failure Modes & Edge Cases
- Invalid inputs, boundary conditions, malformed types.
- Partial failure semantics (ensure zero partial writes on error).

## 12. Explicit Non-Goals & Stop Conditions
- What adjacent or nearby code must NOT be touched.
- Specific conditions requiring immediate halt and escalation.

## 13. Definition of Done
- Complete checklist of acceptance criteria that must be verified before handoff to senior review.
```

---

## 4. Implementation Agent Handoff

Once the plan artifact is written and self-reviewed:

1. Update the task contract's `Implementation notes` indicating that planning is complete and referencing the plan artifact.
2. Transition the task status to `PLAN_READY_FOR_IMPLEMENTATION`.
3. Hand off to the Implementation Agent (`ks-impl` / `GEMINI.md`).
4. The Implementation Agent must read the plan artifact, execute the exact steps specified, verify all acceptance criteria, and write the standard implementation report.
