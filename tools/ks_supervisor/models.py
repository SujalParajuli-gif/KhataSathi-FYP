"""KhataSathi Workflow Supervisor - Centralized Model Selection & Profiles."""
from dataclasses import dataclass, field
import os
import re
from typing import Any, Dict, Optional, Tuple

from tools.ks_supervisor.config import SupervisorConfig
from tools.ks_supervisor.types import ExecutionMode, Role, TaskContract, WorkflowState


@dataclass
class ModelProfile:
    """Configuration for an AI model execution profile."""
    name: str
    provider: str  # "codex" or "antigravity"
    model: str
    effort: str = "medium"  # "low", "medium", "high"
    timeout_seconds: Optional[int] = None
    description: str = ""


@dataclass
class ModelSelectionResult:
    """Auditable model selection decision for a workflow step."""
    profile: ModelProfile
    reason: str
    escalation_level: int = 0
    is_escalated: bool = False
    task_risk: str = "MEDIUM"

    @property
    def provider(self) -> str:
        return "Codex" if self.profile.provider.lower() == "codex" else "Antigravity"

    @property
    def model_name(self) -> str:
        return self.profile.model

    @property
    def effort(self) -> str:
        return self.profile.effort

    @property
    def selection_reason(self) -> str:
        return self.reason



# Standard Centralized Model Profiles (Fail-safe MVP Defaults)
DEFAULT_PROFILES: Dict[str, ModelProfile] = {
    # --- Codex Profiles ---
    "codex_router": ModelProfile(
        name="codex_router",
        provider="codex",
        model="gpt-6.1-sol",
        effort="low",
        description="Efficient read-only routing & status assessment",
    ),
    "codex_senior_autopilot": ModelProfile(
        name="codex_senior_autopilot",
        provider="codex",
        model="gpt-6.1-sol",
        effort="medium",
        description="Capable coding & test execution for authorized LOW-risk autopilot tasks",
    ),
    "codex_planner": ModelProfile(
        name="codex_planner",
        provider="codex",
        model="gpt-6.1-sol",
        effort="high",
        description="Deep reasoning for architecture & implementation plan generation",
    ),
    "codex_reviewer": ModelProfile(
        name="codex_reviewer",
        provider="codex",
        model="gpt-6.1-sol",
        effort="medium",
        description="Standard senior review against acceptance criteria and test evidence",
    ),
    "codex_reviewer_high_risk": ModelProfile(
        name="codex_reviewer_high_risk",
        provider="codex",
        model="gpt-6.1-sol",
        effort="high",
        description="High-effort senior review for financial/schema/auth/concurrency invariants",
    ),
    "codex_closeout": ModelProfile(
        name="codex_closeout",
        provider="codex",
        model="gpt-6.1-sol",
        effort="low",
        description="Deterministic workflow metadata & closeout record updates",
    ),
    # --- Antigravity Gemini Profiles ---
    "gemini_implementation": ModelProfile(
        name="gemini_implementation",
        provider="antigravity",
        model="gemini-3.7-flash-medium",
        effort="medium",
        description="Normal LOW/MEDIUM implementation and ordinary bounded application work",
    ),
    "gemini_high_risk_implementation": ModelProfile(
        name="gemini_high_risk_implementation",
        provider="antigravity",
        model="gemini-3.8-flash-high",
        effort="high",
        description="High-effort implementation for genuinely exceptional VERY_HIGH_RISK tasks",
    ),
    "gemini_fix": ModelProfile(
        name="gemini_fix",
        provider="antigravity",
        model="gemini-3.7-flash-medium",
        effort="medium",
        description="Normal review blocker remediation, including most HIGH-risk tasks where scope and blockers are already well-defined",
    ),
    "gemini_escalation": ModelProfile(
        name="gemini_escalation",
        provider="antigravity",
        model="gemini-3.8-flash-high",
        effort="high",
        description="Bounded escalation after normal Gemini profile genuinely failed or requires exceptional reasoning",
    ),
}


def parse_difficulty_score(difficulty: str) -> int:
    """Parse integer difficulty score from difficulty string (e.g. '8/10' -> 8)."""
    if not difficulty:
        return 0
    match = re.search(r"(\d+)", str(difficulty))
    if match:
        try:
            return int(match.group(1))
        except ValueError:
            return 0
    return 0


_CRITICAL_SCHEMA_PATTERNS = [
    r"\b(?:schema|database|table|column)\s+migration\b",
    r"\bmigration\s+(?:script|execution|contract|gate|schema)\b",
    r"\b(?:alter|create|drop|truncate)\s+table\b",
    r"\bdestructive\s+(?:schema|migration|data\s+operation)\b",
]

_CRITICAL_SECURITY_PATTERNS = [
    r"\b(?:authentication|authorization|security)\s+boundary\b",
    r"\bcredential\s+(?:encryption|storage|verification)\b",
    r"\bpassword\s+(?:hashing|reset|security)\b",
    r"\btoken\s+(?:signing|validation|revocation)\b",
    r"\brbac\s+(?:boundary|enforcement|engine)\b",
]

_CRITICAL_FINANCIAL_PATTERNS = [
    r"\birreversible\s+(?:money|payment|charge|transfer)\b",
    r"\b(?:financial|general)\s+ledger\s+(?:mutation|posting|entry)\b",
    r"\bpayment\s+(?:capture|disbursement|gateway\s+posting)\b",
    r"\bledger\s+(?:corruption|reconciliation|integrity)\b",
]

_CRITICAL_CONCURRENCY_PATTERNS = [
    r"\bconcurrency\s+(?:race|correctness|corruption)\b",
    r"\bdistributed\s+(?:lock|locking)\b",
    r"\bdouble\s+(?:spend|payment|charge)\s+prevention\b",
    r"\bidempotency\s+correctness\b",
]

_CRITICAL_RECOVERY_PATTERNS = [
    r"\bproduction-critical\s+recovery\b",
    r"\bdisaster\s+recovery\b",
    r"\bdata-loss\s+recovery\b",
    r"\bmeaningful\s+data-loss\s+risk\b",
]


def is_very_high_risk(task: Optional[TaskContract]) -> Tuple[bool, str]:
    """Deterministic predicate determining if a task qualifies for gemini-3.8-flash-high.

    A task qualifies for gemini-3.8-flash-high only when:
    risk == HIGH AND at least one strong condition applies:
    - difficulty >= 9
    - database schema or migration changes
    - destructive or irreversible data operations
    - authentication / authorization / security boundary changes
    - concurrency / idempotency correctness where duplicate execution could corrupt business state
    - irreversible money movement / payment posting / financial ledger mutation
    - production-critical recovery logic with meaningful data-loss risk

    Ordinary billing UI, bounded API work, regular CRUD, test fixes, frontend changes,
    or already-planned blocker remediation do NOT qualify solely because task metadata says HIGH.
    """
    if not task:
        return False, "No active task contract provided"

    task_risk = (task.risk or "MEDIUM").strip().upper()
    if task_risk != "HIGH":
        return False, f"Task risk is {task_risk} (requires HIGH for very-high-risk qualification)"

    diff_score = parse_difficulty_score(task.difficulty)
    if diff_score >= 9:
        return True, f"Task risk is HIGH with difficulty {diff_score}/10 (>= 9)"

    search_text = " ".join([
        task.title or "",
        task.delivery_outcome or "",
        " ".join(task.acceptance_criteria or []),
        task.stop_conditions or "",
    ]).lower()

    for pattern in _CRITICAL_SCHEMA_PATTERNS:
        match = re.search(pattern, search_text, re.IGNORECASE)
        if match:
            return True, f"Task risk is HIGH with database schema or migration changes ('{match.group(0)}')"

    for pattern in _CRITICAL_SECURITY_PATTERNS:
        match = re.search(pattern, search_text, re.IGNORECASE)
        if match:
            return True, f"Task risk is HIGH with authentication/security boundary changes ('{match.group(0)}')"

    for pattern in _CRITICAL_FINANCIAL_PATTERNS:
        match = re.search(pattern, search_text, re.IGNORECASE)
        if match:
            return True, f"Task risk is HIGH with irreversible financial ledger or payment posting mutation ('{match.group(0)}')"

    for pattern in _CRITICAL_CONCURRENCY_PATTERNS:
        match = re.search(pattern, search_text, re.IGNORECASE)
        if match:
            return True, f"Task risk is HIGH with critical concurrency/idempotency invariants ('{match.group(0)}')"

    for pattern in _CRITICAL_RECOVERY_PATTERNS:
        match = re.search(pattern, search_text, re.IGNORECASE)
        if match:
            return True, f"Task risk is HIGH with production-critical recovery logic ('{match.group(0)}')"

    return False, f"Task risk is HIGH (difficulty {diff_score}/10) but does not meet VERY_HIGH_RISK criteria"


def get_configured_profile(profile_name: str, config: Optional[SupervisorConfig] = None) -> ModelProfile:
    """Retrieve model profile applying user environment overrides without mutating workflow authority."""
    base = DEFAULT_PROFILES.get(profile_name)
    if not base:
        raise KeyError(f"Unknown model profile '{profile_name}'")

    # Clone base profile
    profile = ModelProfile(
        name=base.name,
        provider=base.provider,
        model=base.model,
        effort=base.effort,
        timeout_seconds=base.timeout_seconds,
        description=base.description,
    )

    # Check for user overrides via environment variables (e.g. KS_MODEL_GEMINI_FIX="gemini-2.5-pro")
    env_key_model = f"KS_MODEL_{profile_name.upper()}"
    env_key_effort = f"KS_EFFORT_{profile_name.upper()}"

    override_model = os.environ.get(env_key_model)
    override_effort = os.environ.get(env_key_effort)

    if override_model:
        profile.model = override_model.strip()

    if override_effort:
        val = override_effort.strip().lower()
        if val in {"low", "medium", "high"}:
            profile.effort = val

    return profile


def select_model_for_action(
    workflow_state: WorkflowState,
    assigned_role: Role,
    task: Optional[TaskContract] = None,
    fix_cycle: int = 0,
    attempt_count: int = 0,
    config: Optional[SupervisorConfig] = None,
) -> ModelSelectionResult:
    """Select auditable model profile deterministically from Workflow v2 state, task risk, and retry counts."""
    task_risk = (task.risk if task else "MEDIUM").upper()
    exec_mode = task.execution_mode if task else ExecutionMode.DIRECT_IMPLEMENTATION

    # 1. Router / Pure Read-Only Inspection / READ_ONLY_DIRECT
    if exec_mode == ExecutionMode.READ_ONLY_DIRECT or assigned_role == Role.NONE or workflow_state in {
        WorkflowState.NO_ACTIVE_TASK,
        WorkflowState.CANNOT_DETERMINE_WORKFLOW_STATE,
        WorkflowState.ACTIVATION_BOUNDARY_OLD_WORKFLOW,
        WorkflowState.PLAN_REPO_DRIFT,
        WorkflowState.USER_DECISION_REQUIRED,
        WorkflowState.DEPENDENCY_BLOCKED,
        WorkflowState.ACCEPTED_NO_COMMIT_WORTHY_CHANGES,
        WorkflowState.PROVIDER_QUOTA_OR_AUTH_REQUIRED,
    }:
        return ModelSelectionResult(
            profile=get_configured_profile("codex_router", config),
            reason="Read-only Workflow v2 inspection & status assessment",
            escalation_level=0,
            task_risk=task_risk,
        )

    # 2. Supervisor Auto-Commit (No AI invocation)
    if assigned_role == Role.SUPERVISOR:
        return ModelSelectionResult(
            profile=get_configured_profile("codex_closeout", config),
            reason="Deterministic supervisor auto-commit / closeout step",
            escalation_level=0,
            task_risk=task_risk,
        )

    # 3. Senior Autopilot (LOW-risk direct tasks)
    if assigned_role == Role.SENIOR and exec_mode == ExecutionMode.SENIOR_AUTOPILOT and task_risk == "LOW":
        return ModelSelectionResult(
            profile=get_configured_profile("codex_senior_autopilot", config),
            reason="LOW-risk task authorized for direct Senior autopilot execution",
            escalation_level=0,
            task_risk=task_risk,
        )

    # 4. Planner Role (Codex)
    if assigned_role == Role.PLANNER or workflow_state == WorkflowState.READY_FOR_PLANNING:
        return ModelSelectionResult(
            profile=get_configured_profile("codex_planner", config),
            reason=f"{task_risk}-risk task requiring planning and implementation plan generation",
            escalation_level=0,
            task_risk=task_risk,
        )


    # 5. Senior Review / Targeted Verification / Closeout (Codex)
    if assigned_role == Role.SENIOR:
        if workflow_state == WorkflowState.APPROVED_AWAITING_CLOSEOUT:
            return ModelSelectionResult(
                profile=get_configured_profile("codex_closeout", config),
                reason="Senior closeout updating task status, checkpoint, and registry",
                escalation_level=0,
                task_risk=task_risk,
            )
        elif task_risk == "HIGH":
            return ModelSelectionResult(
                profile=get_configured_profile("codex_reviewer_high_risk", config),
                reason="HIGH-risk senior review requiring high reasoning effort for invariants",
                escalation_level=0,
                task_risk=task_risk,
            )
        else:
            return ModelSelectionResult(
                profile=get_configured_profile("codex_reviewer", config),
                reason=f"{task_risk}-risk senior review against acceptance criteria and diff",
                escalation_level=0,
                task_risk=task_risk,
            )

    # 6. Implementation / Fix Roles (Antigravity Gemini)
    if assigned_role == Role.IMPLEMENTATION:
        is_vhr, vhr_reason = is_very_high_risk(task)

        # Case A: FIX_REQUIRED remediation
        if workflow_state == WorkflowState.FIX_REQUIRED:
            if fix_cycle > 0:
                # Bounded escalation on retry / persistent blockers (max 1 escalation level)
                return ModelSelectionResult(
                    profile=get_configured_profile("gemini_escalation", config),
                    reason=f"Bounded escalation (cycle {fix_cycle}) after prior fix attempt: {vhr_reason if is_vhr else 'persistent review blockers'}",
                    escalation_level=1,
                    is_escalated=True,
                    task_risk=task_risk,
                )
            elif is_vhr:
                # Qualifies as VERY_HIGH_RISK
                return ModelSelectionResult(
                    profile=get_configured_profile("gemini_escalation", config),
                    reason=f"VERY_HIGH_RISK blocker remediation: {vhr_reason}",
                    escalation_level=1,
                    is_escalated=True,
                    task_risk=task_risk,
                )
            else:
                return ModelSelectionResult(
                    profile=get_configured_profile("gemini_fix", config),
                    reason="Bounded blocker remediation / continuation (does not meet VERY_HIGH_RISK threshold)",
                    escalation_level=0,
                    is_escalated=False,
                    task_risk=task_risk,
                )

        # Case B: Initial Implementation
        if is_vhr:
            return ModelSelectionResult(
                profile=get_configured_profile("gemini_high_risk_implementation", config),
                reason=f"VERY_HIGH_RISK implementation deliverable: {vhr_reason}",
                escalation_level=0,
                is_escalated=False,
                task_risk=task_risk,
            )
        elif attempt_count > 0:
            return ModelSelectionResult(
                profile=get_configured_profile("gemini_escalation", config),
                reason=f"Bounded escalation (attempt {attempt_count}) after initial implementation attempt",
                escalation_level=1,
                is_escalated=True,
                task_risk=task_risk,
            )
        else:
            return ModelSelectionResult(
                profile=get_configured_profile("gemini_implementation", config),
                reason=f"{task_risk}-risk implementation deliverable (does not meet VERY_HIGH_RISK threshold)" if task_risk == "HIGH" else f"{task_risk}-risk implementation coding and unit tests",
                escalation_level=0,
                is_escalated=False,
                task_risk=task_risk,
            )

    # Default fallback
    return ModelSelectionResult(
        profile=get_configured_profile("codex_router", config),
        reason="Default router profile",
        escalation_level=0,
        task_risk=task_risk,
    )


def validate_profile_availability(profile: ModelProfile, config: SupervisorConfig) -> Tuple[bool, str]:
    """Verify whether the requested model profile can be executed in the current environment (Fail-Closed)."""
    if profile.provider == "codex":
        # Check if codex binary is available
        from tools.ks_supervisor.adapters.codex import CodexAdapter
        adapter = CodexAdapter(config)
        info = adapter.check_availability()
        if not info["available"]:
            return False, f"MODEL_DISCOVERY_FAILED: Codex provider unavailable ({info.get('error')})"
        return True, f"Locally verifiable: {profile.model} on Codex ({profile.effort} effort)"

    elif profile.provider == "antigravity":
        from tools.ks_supervisor.adapters.antigravity import AntigravityAdapter
        adapter = AntigravityAdapter(config)
        info = adapter.check_availability()
        if not info["available"]:
            return False, f"MODEL_DISCOVERY_FAILED: Antigravity headless CLI unavailable ({info.get('error')})"

        # Validate configured model against output of `agy models`
        ok, available_models, err = adapter.get_available_models()
        if not ok:
            if err and err.partition(":")[0] in {
                "MODEL_DISCOVERY_TIMEOUT", "MODEL_DISCOVERY_FAILED", "PROVIDER_QUOTA_OR_AUTH_REQUIRED",
            }:
                return False, err
            return False, f"MODEL_DISCOVERY_FAILED: Failed to validate models via `agy models`: {err}"

        if profile.model not in available_models:
            return False, (
                f"MODEL_NOT_AVAILABLE: Model '{profile.model}' is not in available models list from `agy models`. "
                f"Available models: {', '.join(available_models) if available_models else 'none'}"
            )

        return True, f"Verified available on Antigravity: {profile.model} ({profile.effort} effort)"

    return False, f"MODEL_DISCOVERY_FAILED: Unknown provider '{profile.provider}'"
