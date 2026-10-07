"""KhataSathi Workflow Supervisor - Core Types and Enums."""
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class WorkflowState(str, Enum):
    """Deterministic repository workflow states for Workflow v2."""
    NO_ACTIVE_TASK = "NO_ACTIVE_TASK"
    NEXT_TASK_UNRESOLVED = "NEXT_TASK_UNRESOLVED"
    READY_FOR_PLANNING = "READY_FOR_PLANNING"
    PLAN_READY_FOR_IMPLEMENTATION = "PLAN_READY_FOR_IMPLEMENTATION"
    DIRECT_IMPLEMENTATION = "DIRECT_IMPLEMENTATION"
    IMPLEMENTATION_IN_PROGRESS = "IMPLEMENTATION_IN_PROGRESS"
    IMPLEMENTED_AWAITING_REVIEW = "IMPLEMENTED_AWAITING_REVIEW"
    FIX_REQUIRED = "FIX_REQUIRED"
    FIX_AWAITING_TARGETED_VERIFICATION = "FIX_AWAITING_TARGETED_VERIFICATION"
    APPROVED_AWAITING_CLOSEOUT = "APPROVED_AWAITING_CLOSEOUT"
    ACCEPTED_WITH_COMMIT_WORTHY_CHANGES = "ACCEPTED_WITH_COMMIT_WORTHY_CHANGES"
    ACCEPTED_NO_COMMIT_WORTHY_CHANGES = "ACCEPTED_NO_COMMIT_WORTHY_CHANGES"
    PRECOMMIT_BLOCKED = "PRECOMMIT_BLOCKED"
    PLAN_REPO_DRIFT = "PLAN_REPO_DRIFT"
    USER_DECISION_REQUIRED = "USER_DECISION_REQUIRED"
    DEPENDENCY_BLOCKED = "DEPENDENCY_BLOCKED"
    PHASE_COMPLETE = "PHASE_COMPLETE"
    DEPLOYMENT_GATE = "DEPLOYMENT_GATE"
    ACTIVATION_BOUNDARY_OLD_WORKFLOW = "ACTIVATION_BOUNDARY_OLD_WORKFLOW"
    CANNOT_DETERMINE_WORKFLOW_STATE = "CANNOT_DETERMINE_WORKFLOW_STATE"
    REPEATED_AGENT_FAILURE = "REPEATED_AGENT_FAILURE"
    AGENT_RESULT_MISMATCH = "AGENT_RESULT_MISMATCH"
    MODEL_NOT_AVAILABLE = "MODEL_NOT_AVAILABLE"
    MODEL_DISCOVERY_TIMEOUT = "MODEL_DISCOVERY_TIMEOUT"
    MODEL_DISCOVERY_FAILED = "MODEL_DISCOVERY_FAILED"
    PROVIDER_QUOTA_OR_AUTH_REQUIRED = "PROVIDER_QUOTA_OR_AUTH_REQUIRED"
    AGENT_PERMISSION_REQUIRED = "AGENT_PERMISSION_REQUIRED"
    REQUIRED_VERIFICATION_UNEXECUTABLE = "REQUIRED_VERIFICATION_UNEXECUTABLE"
    TARGETED_VERIFICATION_REQUIRED = "TARGETED_VERIFICATION_REQUIRED"
    AGENT_INVOCATION_TOO_LARGE = "AGENT_INVOCATION_TOO_LARGE"
    AGENT_LAUNCH_FAILED = "AGENT_LAUNCH_FAILED"
    AGENT_EXECUTION_FAILED = "AGENT_EXECUTION_FAILED"
    AGENT_EXECUTION_TIMEOUT = "AGENT_EXECUTION_TIMEOUT"
    AGENT_EXECUTION_NOT_OBSERVED = "AGENT_EXECUTION_NOT_OBSERVED"
    SENIOR_REVIEW_NO_EFFECT = "SENIOR_REVIEW_NO_EFFECT"
    SUPERVISOR_INVOCATION_IDENTITY_MISMATCH = "SUPERVISOR_INVOCATION_IDENTITY_MISMATCH"




class Role(str, Enum):
    """Workflow roles invoked by the supervisor."""
    SENIOR = "SENIOR"
    PLANNER = "PLANNER"
    IMPLEMENTATION = "IMPLEMENTATION"
    SUPERVISOR = "SUPERVISOR"
    NONE = "NONE"


class ExecutionMode(str, Enum):
    """Task execution modes."""
    READ_ONLY_DIRECT = "READ_ONLY_DIRECT"
    SENIOR_AUTOPILOT = "SENIOR_AUTOPILOT"
    DIRECT_IMPLEMENTATION = "DIRECT_IMPLEMENTATION"
    PLANNED_IMPLEMENTATION = "PLANNED_IMPLEMENTATION"


@dataclass
class CheckpointData:
    """Parsed data from IMPLEMENTATION_CHECKPOINT.md."""
    workflow_version_effective: str = ""
    is_v2_active: bool = False
    master_plan_version: str = ""
    current_phase: str = ""
    current_task: str = ""
    current_task_file: str = ""
    current_task_status: str = ""
    current_task_plan: str = ""
    current_work_branch: str = ""
    last_accepted_task: str = ""
    last_implementation_commit: str = ""
    next_safe_action: str = ""
    raw_fields: Dict[str, str] = field(default_factory=dict)


@dataclass
class TaskContract:
    """Parsed data from an active task contract."""
    task_id: str = ""
    title: str = ""
    status: str = ""
    difficulty: str = ""
    risk: str = "MEDIUM"
    planning_required: bool = False
    execution_mode: ExecutionMode = ExecutionMode.DIRECT_IMPLEMENTATION
    senior_review_required: bool = True
    phase: str = ""
    branch_worktree: str = ""
    assigned_role: str = ""
    authorization: str = ""
    delivery_outcome: str = ""
    acceptance_criteria: List[str] = field(default_factory=list)
    stop_conditions: str = ""
    raw_content: str = ""


@dataclass
class ReportData:
    """Parsed data from an implementation report."""
    task_id: str = ""
    status: str = ""
    branch: str = ""
    revision: str = ""
    is_complete: bool = False
    is_awaiting_review: bool = False
    blocker_fixes_reported: bool = False
    raw_content: str = ""
    current_content: str = ""


@dataclass
class ReviewData:
    """Parsed data from a senior review."""
    task_id: str = ""
    decision: str = ""  # APPROVED, FIX_REQUIRED, etc.
    blockers: List[str] = field(default_factory=list)
    non_blocking: List[str] = field(default_factory=list)
    out_of_scope: List[str] = field(default_factory=list)
    raw_content: str = ""
    current_content: str = ""
    workflow_state: str = ""
    blockers_explicitly_empty: bool = False


@dataclass
class GitState:
    """Observed Git repository state."""
    branch: str = ""
    head_sha: str = ""
    is_clean: bool = True
    modified_files: List[str] = field(default_factory=list)
    staged_files: List[str] = field(default_factory=list)
    untracked_files: List[str] = field(default_factory=list)


@dataclass
class RepositoryBaseline:
    """Deterministic snapshot of repository and workflow state before/after an agent run."""
    timestamp: str = ""
    branch: str = ""
    head_sha: str = ""
    is_clean: bool = True
    modified_files: List[str] = field(default_factory=list)
    staged_files: List[str] = field(default_factory=list)
    untracked_files: List[str] = field(default_factory=list)
    # Porcelain status per individual path: relative_path -> two-column status code
    porcelain: Dict[str, str] = field(default_factory=dict)
    # File content fingerprints: relative_path -> sha256
    file_hashes: Dict[str, str] = field(default_factory=dict)
    # Workflow artifact hashes: "task", "report", "review", "plan", "checkpoint", "registry"
    artifact_hashes: Dict[str, str] = field(default_factory=dict)
    workflow_state: str = ""
    task_id: str = ""


@dataclass
class RepositoryDelta:
    """Differences between pre-run baseline and post-run repository state."""
    has_git_changes: bool = False
    new_files: List[str] = field(default_factory=list)
    modified_files: List[str] = field(default_factory=list)
    deleted_files: List[str] = field(default_factory=list)
    changed_workflow_artifacts: List[str] = field(default_factory=list)
    initial_workflow_state: str = ""
    final_workflow_state: str = ""
    head_changed: bool = False
    branch_changed: bool = False
    observable_effect: bool = False


@dataclass
class DerivedState:
    """Result of deterministic state derivation."""
    state: WorkflowState = WorkflowState.CANNOT_DETERMINE_WORKFLOW_STATE
    assigned_role: Role = Role.NONE
    active_task_id: str = ""
    task_contract: Optional[TaskContract] = None
    checkpoint: Optional[CheckpointData] = None
    git_state: Optional[GitState] = None
    reason: str = ""
    next_action_description: str = ""
    is_hard_stop: bool = False
    stop_reason: Optional[str] = None
    model_selection: Optional[Any] = None  # ModelSelectionResult


@dataclass(frozen=True)
class AgentInvocation:
    """Execution identity captured before launch, independent of resulting state."""
    run_id: str
    task_id: str
    workflow_state_before: str
    action: str
    role: Role
    provider: str
    model: str
    effort: str
    selection_reason: str
    started_at: str


@dataclass
class AgentResult:
    """Result of child agent execution."""
    role: Role
    task_id: str
    exit_code: int
    stdout: str
    stderr: str
    duration_seconds: float
    success: bool
    process_completed: bool = False
    process_started: Optional[bool] = None  # None preserves legacy adapter/result compatibility
    infrastructure_failure: Optional[WorkflowState] = None
    provider_reported_success: bool = False
    observable_repo_effect: bool = False
    postconditions_valid: bool = False
    workflow_transition_valid: bool = False
    error_message: Optional[str] = None
    soft_permission_denial: bool = False
    auth_or_quota_failure: bool = False
    session_id: Optional[str] = None
    files_modified: List[str] = field(default_factory=list)
    provider: str = ""
    model_name: str = ""
    effort: str = ""
    token_usage: Dict[str, Any] = field(default_factory=dict)
    cmd_argv: List[str] = field(default_factory=list)
    final_status: Optional[str] = None
    stream_summary: Dict[str, Any] = field(default_factory=dict)
    denied_actions: List[str] = field(default_factory=list)
    timed_out: bool = False
    timeout_kind: Optional[str] = None
    last_activity_at: Optional[str] = None
    last_step_index: Optional[int] = None
    last_tool_name: Optional[str] = None
    last_tool_target: Optional[str] = None
    events_received: int = 0
    run_id: str = ""
    started_at: str = ""
    final_message: str = ""
    final_message_path: str = ""


@dataclass
class StopReport:
    """Actionable report when supervisor encounters a hard stop."""
    state: WorkflowState
    task_id: str
    reason: str
    question_for_human: Optional[str] = None
    evidence: Dict[str, Any] = field(default_factory=dict)
    recommended_next_action: str = ""
    resume_command: str = ""
