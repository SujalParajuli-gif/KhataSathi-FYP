"""KhataSathi Workflow Supervisor - Deterministic State Derivation Engine."""
from pathlib import Path
from typing import Optional

from tools.ks_supervisor.config import SupervisorConfig
from tools.ks_supervisor.completion import completion_path, report_completion_valid
from tools.ks_supervisor.approval import approval_mismatch
from tools.ks_supervisor.models import select_model_for_action
from tools.ks_supervisor.repo import (
    get_git_state,
    parse_checkpoint,
    parse_report,
    parse_review,
    parse_task_contract,
)
from tools.ks_supervisor.types import (
    CheckpointData,
    DerivedState,
    ExecutionMode,
    GitState,
    ReportData,
    ReviewData,
    Role,
    TaskContract,
    WorkflowState,
)


def find_task_file(tasks_dir: Path, task_id: str) -> Optional[Path]:
    """Find the task contract file by task ID prefix."""
    if not tasks_dir.exists():
        return None
    for p in tasks_dir.glob("*.md"):
        if p.name.startswith(task_id):
            return p
    return None


def find_report_file(reports_dir: Path, task_id: str) -> Optional[Path]:
    """Find the implementation report file by task ID."""
    if not reports_dir.exists():
        return None
    for pattern in (f"{task_id}-implementation.md", f"{task_id}-report.md", f"{task_id}*.md"):
        for p in reports_dir.glob(pattern):
            return p
    return None


def find_review_file(reviews_dir: Path, task_id: str) -> Optional[Path]:
    """Find the review file by task ID."""
    if not reviews_dir.exists():
        return None
    for p in reviews_dir.glob(f"{task_id}-review.md"):
        return p
    return None


def find_plan_file(plans_dir: Path, task_id: str) -> Optional[Path]:
    """Find the implementation plan file by task ID."""
    if not plans_dir.exists():
        return None
    for p in plans_dir.glob(f"{task_id}-plan.md"):
        return p
    return None


def has_application_code_changes(git_state: Optional[GitState]) -> bool:
    """Check if the working tree has changes outside workflow metadata directories."""
    if not git_state or git_state.is_clean:
        return False
    
    workflow_prefixes = (
        "docs/engineering/ai/",
        "docs/engineering/implementation_checkpoint.md",
        "docs/engineering/task_registry.md",
        "docs/engineering/project_progress.md",
        ".agents/",
    )
    
    all_files = git_state.modified_files + git_state.untracked_files + git_state.staged_files
    for f in all_files:
        norm = f.replace("\\", "/").lower()
        if not any(norm.startswith(p) for p in workflow_prefixes):
            return True
            
    return False


def derive_workflow_state(
    config: SupervisorConfig,
    fix_cycle: int = 0,
    attempt_count: int = 0,
    completion_candidate: Optional[dict] = None,
) -> DerivedState:
    """Derive authoritative workflow state and attach deterministic model selection."""
    state = _raw_derive_workflow_state(config, completion_candidate)
    if state.assigned_role == Role.SUPERVISOR and state.state == WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION:
        return state  # Deterministic checks have no LLM/model discovery route.
    state.model_selection = select_model_for_action(
        workflow_state=state.state,
        assigned_role=state.assigned_role,
        task=state.task_contract,
        fix_cycle=fix_cycle,
        attempt_count=attempt_count,
        config=config,
    )
    return state


def _raw_derive_workflow_state(config: SupervisorConfig, completion_candidate: Optional[dict] = None,
                              checkpoint: Optional[CheckpointData] = None,
                              git_state: Optional[GitState] = None) -> DerivedState:
    """Derive the authoritative workflow state deterministically from repository artifacts + Git."""
    checkpoint_path = config.checkpoint_path
    checkpoint = checkpoint or parse_checkpoint(checkpoint_path)
    git_state = git_state or get_git_state(config.repo_root)

    # 1. Effective Workflow Version Gate
    if not checkpoint.workflow_version_effective:
        return DerivedState(
            state=WorkflowState.CANNOT_DETERMINE_WORKFLOW_STATE,
            assigned_role=Role.NONE,
            checkpoint=checkpoint,
            git_state=git_state,
            reason="WORKFLOW_VERSION_EFFECTIVE is missing or blank in checkpoint",
            is_hard_stop=True,
            stop_reason="CANNOT_DETERMINE_WORKFLOW_STATE: missing WORKFLOW_VERSION_EFFECTIVE",
        )

    if not checkpoint.is_v2_active:
        if checkpoint.workflow_version_effective.startswith("1") or "old workflow" in checkpoint.workflow_version_effective.lower():
            return DerivedState(
                state=WorkflowState.ACTIVATION_BOUNDARY_OLD_WORKFLOW,
                assigned_role=Role.NONE,
                checkpoint=checkpoint,
                git_state=git_state,
                reason=f"Workflow Version 1 is indicated ({checkpoint.workflow_version_effective}); Workflow v2 auto-routing not active",
                is_hard_stop=True,
                stop_reason="ACTIVATION_BOUNDARY_OLD_WORKFLOW",
            )
        return DerivedState(
            state=WorkflowState.CANNOT_DETERMINE_WORKFLOW_STATE,
            assigned_role=Role.NONE,
            checkpoint=checkpoint,
            git_state=git_state,
            reason=f"Contradictory or ambiguous WORKFLOW_VERSION_EFFECTIVE: '{checkpoint.workflow_version_effective}'",
            is_hard_stop=True,
            stop_reason="CANNOT_DETERMINE_WORKFLOW_STATE",
        )

    # 2. No Active Task Gate
    current_task_id = checkpoint.current_task.strip()
    if not current_task_id or current_task_id.lower() in {"none", "null", ""}:
        return DerivedState(
            state=WorkflowState.NO_ACTIVE_TASK,
            assigned_role=Role.SENIOR,
            checkpoint=checkpoint,
            git_state=git_state,
            reason="No active task specified in checkpoint",
            next_action_description="Senior engineer identifies next task from roadmap/backlog and drafts task contract: " + checkpoint.next_safe_action,
        )

    # 3. Resolve Task Contract
    task_file = None
    if checkpoint.current_task_file:
        candidate = config.repo_root / checkpoint.current_task_file
        if candidate.exists():
            task_file = candidate
            
    if not task_file:
        task_file = find_task_file(config.tasks_dir, current_task_id)

    if not task_file or not task_file.exists():
        return DerivedState(
            state=WorkflowState.PLAN_REPO_DRIFT,
            assigned_role=Role.NONE,
            active_task_id=current_task_id,
            checkpoint=checkpoint,
            git_state=git_state,
            reason=f"Active task contract for '{current_task_id}' not found on disk",
            is_hard_stop=True,
            stop_reason=f"PLAN_REPO_DRIFT: missing task contract for {current_task_id}",
        )

    task = parse_task_contract(task_file)
    if not task:
        return DerivedState(
            state=WorkflowState.PLAN_REPO_DRIFT,
            assigned_role=Role.NONE,
            active_task_id=current_task_id,
            checkpoint=checkpoint,
            git_state=git_state,
            reason=f"Failed to parse task contract for '{current_task_id}'",
            is_hard_stop=True,
            stop_reason=f"PLAN_REPO_DRIFT: malformed task contract for {current_task_id}",
        )

    # 4. Check for Explicit Task Status Blocker or Human Decision
    upper_task_status = task.status.upper()
    if "BLOCKED" in upper_task_status or "BLOCKED" in checkpoint.current_task_status.upper():
        return DerivedState(
            state=WorkflowState.DEPENDENCY_BLOCKED,
            assigned_role=Role.NONE,
            active_task_id=current_task_id,
            task_contract=task,
            checkpoint=checkpoint,
            git_state=git_state,
            reason=f"Task {current_task_id} is marked BLOCKED",
            is_hard_stop=True,
            stop_reason=f"DEPENDENCY_BLOCKED: {current_task_id}",
        )

    if "USER_DECISION" in upper_task_status or "DECISION_REQUIRED" in upper_task_status:
        return DerivedState(
            state=WorkflowState.USER_DECISION_REQUIRED,
            assigned_role=Role.NONE,
            active_task_id=current_task_id,
            task_contract=task,
            checkpoint=checkpoint,
            git_state=git_state,
            reason=f"Task {current_task_id} requires user business/architectural decision",
            is_hard_stop=True,
            stop_reason=f"USER_DECISION_REQUIRED: {current_task_id}",
        )

    # 5. Look up Related Artifacts (Plan, Report, Review)
    plan_path = find_plan_file(config.plans_dir, current_task_id)
    report_path = find_report_file(config.reports_dir, current_task_id)
    review_path = find_review_file(config.reviews_dir, current_task_id)

    report = parse_report(report_path) if report_path else None
    review = parse_review(review_path) if review_path else None

    # 6. Evaluate State & Transitions

    # Case A: Task is already ACCEPTED
    if upper_task_status == "ACCEPTED" or checkpoint.current_task_status.upper() == "ACCEPTED":
        if has_application_code_changes(git_state):
            return DerivedState(
                state=WorkflowState.ACCEPTED_WITH_COMMIT_WORTHY_CHANGES,
                assigned_role=Role.SUPERVISOR,
                active_task_id=current_task_id,
                task_contract=task,
                checkpoint=checkpoint,
                git_state=git_state,
                reason=f"Task {current_task_id} is ACCEPTED with pending changes in working tree",
                next_action_description="Execute hygiene-gated auto-commit workflow",
            )
        else:
            return DerivedState(
                state=WorkflowState.ACCEPTED_NO_COMMIT_WORTHY_CHANGES,
                assigned_role=Role.SUPERVISOR,
                active_task_id=current_task_id,
                task_contract=task,
                checkpoint=checkpoint,
                git_state=git_state,
                reason=f"Task {current_task_id} is ACCEPTED and working tree is clean",
                next_action_description="Advance to next safe action / re-anchor",
            )

    # Explicit terminal approval is authoritative even without an agent completion
    # attestation, but only when canonical state and reviewed content agree.
    if (upper_task_status == "APPROVED_AWAITING_CLOSEOUT"
            or checkpoint.current_task_status.upper() == "APPROVED_AWAITING_CLOSEOUT"
            or (review and review.workflow_state == "APPROVED_AWAITING_CLOSEOUT")):
        mismatch = approval_mismatch(config, task, checkpoint, review, report, review_path, report_path)
        if mismatch:
            return DerivedState(
                state=WorkflowState.PLAN_REPO_DRIFT, assigned_role=Role.NONE,
                active_task_id=current_task_id, task_contract=task, checkpoint=checkpoint,
                git_state=git_state, is_hard_stop=True,
                reason=f"APPROVAL_PROVENANCE_MISMATCH: {mismatch}",
                stop_reason=f"APPROVAL_PROVENANCE_MISMATCH: {mismatch}",
            )

    # Case B: Review file exists with APPROVED decision (and zero blockers)
    if review and review.decision == "APPROVED" and len(review.blockers) == 0:
        return DerivedState(
            state=WorkflowState.APPROVED_AWAITING_CLOSEOUT,
            assigned_role=Role.SENIOR,
            active_task_id=current_task_id,
            task_contract=task,
            checkpoint=checkpoint,
            git_state=git_state,
            reason=f"Senior review for {current_task_id} is APPROVED with zero blockers",
            next_action_description="Senior closeout: mark ACCEPTED in task contract, registry, and checkpoint",
        )

    # Case C: Task is in FIX_REQUIRED state (from review or task status)
    if upper_task_status == "FIX_REQUIRED" or checkpoint.current_task_status.upper() == "FIX_REQUIRED" or (review and (review.decision == "FIX_REQUIRED" or len(review.blockers) > 0)):
        # Check if implementer has reported fixes after the review
        if (report and report.blocker_fixes_reported
                and (report_path.stat().st_mtime > review_path.stat().st_mtime if review_path else True)
                and (report_completion_valid(config, current_task_id, report_path, completion_candidate)
                     or report_completion_valid(config, current_task_id, report_path, pending=True))):
            if completion_candidate is None and report_completion_valid(config, current_task_id, report_path, pending=True):
                from tools.ks_supervisor.verification import VerificationEvidence
                required = VerificationEvidence(config, current_task_id).plan()["required_verification"]
                checks = "; ".join(f"{i['check_id']}: {i['command']}" for i in required)
                return DerivedState(
                    state=WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION, assigned_role=Role.SUPERVISOR,
                    active_task_id=current_task_id, task_contract=task, checkpoint=checkpoint, git_state=git_state,
                    reason="Current implementation is complete but current-content targeted verification is pending for "
                           + (checks or "completion attestation publication"),
                    next_action_description="TARGETED_VERIFICATION: execute authorized bounded checks directly, then attest completion",
                )
            return DerivedState(
                state=WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION,
                assigned_role=Role.SENIOR,
                active_task_id=current_task_id,
                task_contract=task,
                checkpoint=checkpoint,
                git_state=git_state,
                reason=f"Blocker fixes reported for {current_task_id}; awaiting targeted senior verification",
                next_action_description="Senior engineer verifies only previously listed blockers and regressions",
            )
        else:
            return DerivedState(
                state=WorkflowState.FIX_REQUIRED,
                assigned_role=Role.IMPLEMENTATION,
                active_task_id=current_task_id,
                task_contract=task,
                checkpoint=checkpoint,
                git_state=git_state,
                reason=f"Task {current_task_id} has unresolved review blockers or uncommitted implementation completion evidence",
                next_action_description="Implementation agent fixes listed blockers and direct regressions",
            )

    # Case D: Implementation report exists and indicates completion / awaiting review
    if (report and (report.is_complete or report.is_awaiting_review)
            and (not completion_path(config, current_task_id).exists()
                 or report_completion_valid(config, current_task_id, report_path, completion_candidate))):
        return DerivedState(
            state=WorkflowState.IMPLEMENTED_AWAITING_REVIEW,
            assigned_role=Role.SENIOR,
            active_task_id=current_task_id,
            task_contract=task,
            checkpoint=checkpoint,
            git_state=git_state,
            reason=f"Implementation report for {current_task_id} is complete and awaiting senior review",
            next_action_description="Senior engineer performs bounded review against contract, diff, and tests",
        )

    # Case E: Task requires planning and plan is missing
    if task.planning_required and not plan_path:
        return DerivedState(
            state=WorkflowState.READY_FOR_PLANNING,
            assigned_role=Role.PLANNER,
            active_task_id=current_task_id,
            task_contract=task,
            checkpoint=checkpoint,
            git_state=git_state,
            reason=f"Task {current_task_id} requires implementation planning; plan file missing",
            next_action_description=f"Planner invokes khatasathi-implementation-planner to produce plans/{current_task_id}-plan.md",
        )

    # Case F: Task requires planning and plan exists
    if task.planning_required and plan_path:
        if has_application_code_changes(git_state):
            return DerivedState(
                state=WorkflowState.IMPLEMENTATION_IN_PROGRESS,
                assigned_role=Role.IMPLEMENTATION,
                active_task_id=current_task_id,
                task_contract=task,
                checkpoint=checkpoint,
                git_state=git_state,
                reason=f"Implementation in progress for planned task {current_task_id}",
                next_action_description="Implementation agent continues coding/testing and writes implementation report",
            )
        return DerivedState(
            state=WorkflowState.PLAN_READY_FOR_IMPLEMENTATION,
            assigned_role=Role.IMPLEMENTATION,
            active_task_id=current_task_id,
            task_contract=task,
            checkpoint=checkpoint,
            git_state=git_state,
            reason=f"Implementation plan exists for {current_task_id}; ready for coding",
            next_action_description="Implementation agent implements task and tests from plan",
        )

    # Case G: Direct implementation (no planning required) or Senior Autopilot
    if not task.planning_required:
        is_autopilot = task.execution_mode == ExecutionMode.SENIOR_AUTOPILOT and task.risk == "LOW"
        assigned_role = Role.SENIOR if is_autopilot else Role.IMPLEMENTATION
        role_label = "Senior Autopilot" if is_autopilot else "Implementation agent"

        if has_application_code_changes(git_state):
            return DerivedState(
                state=WorkflowState.IMPLEMENTATION_IN_PROGRESS,
                assigned_role=assigned_role,
                active_task_id=current_task_id,
                task_contract=task,
                checkpoint=checkpoint,
                git_state=git_state,
                reason=f"Implementation in progress for {'autopilot' if is_autopilot else 'direct'} task {current_task_id}",
                next_action_description=f"{role_label} completes changes, runs tests, and writes report",
            )
        return DerivedState(
            state=WorkflowState.DIRECT_IMPLEMENTATION,
            assigned_role=assigned_role,
            active_task_id=current_task_id,
            task_contract=task,
            checkpoint=checkpoint,
            git_state=git_state,
            reason=f"Task {current_task_id} is ready for {'senior autopilot' if is_autopilot else 'direct implementation'}",
            next_action_description=f"{role_label} implements task according to contract",
        )

    # Default fallback
    return DerivedState(
        state=WorkflowState.CANNOT_DETERMINE_WORKFLOW_STATE,
        assigned_role=Role.NONE,
        active_task_id=current_task_id,
        task_contract=task,
        checkpoint=checkpoint,
        git_state=git_state,
        reason=f"Unable to match deterministic transition rules for {current_task_id}",
        is_hard_stop=True,
        stop_reason=f"CANNOT_DETERMINE_WORKFLOW_STATE: {current_task_id}",
    )
