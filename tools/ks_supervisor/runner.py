"""KhataSathi Workflow Supervisor - Execution Engine & Handoff Orchestrator."""
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
from uuid import uuid4
from typing import Any, Callable, Dict, List, Optional, Tuple

from tools.ks_supervisor.adapters.antigravity import AntigravityAdapter
from tools.ks_supervisor.adapters.codex import CodexAdapter
from tools.ks_supervisor.config import SupervisorConfig
from tools.ks_supervisor.completion import completion_record, write_completion, validation_marker_present, report_completion_valid, completion_context, pending_completion
from tools.ks_supervisor.lock import SupervisorLock
from tools.ks_supervisor.verification import VerificationEvidence
from tools.ks_supervisor.permissions import CommandPermissions
from tools.ks_supervisor.models import validate_profile_availability
from tools.ks_supervisor.repo import (
    capture_repository_baseline,
    compute_repository_delta,
    get_git_state,
    parse_checkpoint,
    parse_report,
    parse_review,
    parse_task_contract,
    run_git,
    run_hygiene_check,
)
from tools.ks_supervisor.state import derive_workflow_state, find_plan_file, find_report_file, find_review_file, find_task_file
from tools.ks_supervisor.types import (
    AgentResult,
    AgentInvocation,
    CheckpointData,
    DerivedState,
    ExecutionMode,
    GitState,
    RepositoryBaseline,
    RepositoryDelta,
    Role,
    StopReport,
    TaskContract,
    WorkflowState,
)


# --- Action kinds (what a live invocation is expected to accomplish) ---
ACTION_IMPLEMENTATION = "IMPLEMENTATION"
ACTION_FIX = "FIX_REQUIRED_REMEDIATION"
ACTION_SENIOR_AUTOPILOT = "SENIOR_AUTOPILOT"
ACTION_PLANNING = "PLANNING"
ACTION_REVIEW = "REVIEW"
ACTION_TARGETED_VERIFICATION = "TARGETED_VERIFICATION"
ACTION_CLOSEOUT = "CLOSEOUT"

NO_OBSERVABLE_AGENT_EFFECT = "NO_OBSERVABLE_AGENT_EFFECT"
NO_ACTION_SPECIFIC_EFFECT = "NO_ACTION_SPECIFIC_EFFECT"
POSTCONDITION_VIOLATION = "POSTCONDITION_VIOLATION"
INVALID_WORKFLOW_TRANSITION = "INVALID_WORKFLOW_TRANSITION"

# Paths that are workflow metadata rather than product/application content.
WORKFLOW_PATH_PREFIXES = (
    "docs/engineering/ai/",
    "docs/engineering/implementation_checkpoint.md",
    "docs/engineering/project_progress.md",
    "docs/engineering/khatasathi_master_implementation_plan",
    ".agents/",
)

DIAG_STDOUT_LIMIT = 16000
DIAG_STDERR_LIMIT = 8000

_SECRET_PATTERNS = [
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9\-._~+/]{8,}=*"), r"\1<redacted>"),
    (re.compile(r"ya29\.[0-9A-Za-z\-_]{10,}"), "<redacted-oauth-token>"),
    (re.compile(r"AIza[0-9A-Za-z\-_]{30,}"), "<redacted-google-api-key>"),
    (re.compile(r"\bsk-[A-Za-z0-9\-_]{16,}"), "<redacted-api-key>"),
    (re.compile(r"(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\"?\s*[=:]\s*\"?)[^\s\",]+"), r"\1<redacted>"),
]


def redact_secrets(text: str) -> str:
    """Remove credential-shaped substrings from diagnostic text."""
    if not text:
        return text
    for pattern, repl in _SECRET_PATTERNS:
        text = pattern.sub(repl, text)
    return text


def safe_argv(argv: List[str]) -> List[str]:
    """Return argv with the (potentially large) prompt replaced by a fingerprint placeholder."""
    out: List[str] = []
    for i, arg in enumerate(argv):
        prev = argv[i - 1] if i > 0 else ""
        is_prompt = prev in ("-p", "--print", "--prompt") or len(arg) > 200 or "\n" in arg
        if is_prompt:
            digest = hashlib.sha256(arg.encode("utf-8", "replace")).hexdigest()[:16]
            out.append(f"<prompt {len(arg)} chars sha256:{digest}>")
        else:
            out.append(redact_secrets(arg))
    return out


def _is_workflow_path(path: str) -> bool:
    norm = path.replace("\\", "/").lower()
    return any(norm.startswith(p) for p in WORKFLOW_PATH_PREFIXES)


@dataclass
class PostconditionResult:
    """Action-specific evaluation of a live agent run against PRE/POST repository evidence."""
    action: str
    action_effect: bool = False
    postconditions_valid: bool = False
    transition_valid: bool = False
    advanced: bool = False
    violations: List[str] = field(default_factory=list)
    reason: str = ""
    details: Dict[str, Any] = field(default_factory=dict)


def evaluate_postconditions(
    action: str,
    initial_state: DerivedState,
    post_state: DerivedState,
    delta: RepositoryDelta,
    report_validated: bool = False,
) -> PostconditionResult:
    """Validate action-specific postconditions without hard-coding a single next state."""
    changed_paths = delta.new_files + delta.modified_files + delta.deleted_files
    app_changes = [p for p in changed_paths if not _is_workflow_path(p)]
    arts = delta.changed_workflow_artifacts
    report_changed = any(a.startswith("report:") for a in arts)
    review_changed = any(a.startswith("review:") for a in arts)
    plan_changed = any(a.startswith("plan:") for a in arts)
    task_changed = any(a.startswith("task:") for a in arts)
    closeout_changed = task_changed or "checkpoint" in arts or "registry" in arts
    pre_s, post_s = initial_state.state, post_state.state

    res = PostconditionResult(action=action)
    res.details = {
        "app_changes": app_changes,
        "report_changed": report_changed,
        "review_changed": review_changed,
        "report_validated": report_validated,
        "plan_changed": plan_changed,
        "task_changed": task_changed,
        "checkpoint_changed": "checkpoint" in arts,
        "registry_changed": "registry" in arts,
        "pre_state": pre_s.value,
        "post_state": post_s.value,
    }

    if delta.head_changed:
        res.violations.append("HEAD moved during the agent run (agents must not commit)")
    if delta.branch_changed:
        res.violations.append("Branch changed during the agent run")

    if action in (ACTION_IMPLEMENTATION, ACTION_FIX, ACTION_SENIOR_AUTOPILOT):
        # Checkpoint/registry text alone is NOT implementation evidence.
        res.action_effect = bool(app_changes or report_changed or report_validated)
        if review_changed and action in (ACTION_IMPLEMENTATION, ACTION_FIX):
            res.violations.append("Implementation agent modified the senior review artifact")
        if action == ACTION_FIX:
            if post_s in (WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION, WorkflowState.IMPLEMENTED_AWAITING_REVIEW):
                res.transition_valid, res.advanced = True, True
            elif post_s == WorkflowState.FIX_REQUIRED:
                # Legitimate partial attempt: blockers remain but real remediation evidence exists.
                res.transition_valid = res.action_effect
            else:
                res.reason = f"Unexpected post-fix state {post_s.value}"
        else:
            allowed = {WorkflowState.IMPLEMENTED_AWAITING_REVIEW, WorkflowState.IMPLEMENTATION_IN_PROGRESS}
            res.transition_valid = post_s in allowed
            res.advanced = post_s == WorkflowState.IMPLEMENTED_AWAITING_REVIEW
            if not res.transition_valid:
                res.reason = f"Unexpected post-implementation state {post_s.value}"
    elif action == ACTION_PLANNING:
        res.action_effect = plan_changed
        if app_changes:
            res.violations.append("Planner modified application files")
        res.transition_valid = post_s in (
            WorkflowState.PLAN_READY_FOR_IMPLEMENTATION, WorkflowState.IMPLEMENTATION_IN_PROGRESS,
        )
        res.advanced = res.transition_valid
        if not res.transition_valid:
            res.reason = f"Unexpected post-planning state {post_s.value}"
    elif action in (ACTION_REVIEW, ACTION_TARGETED_VERIFICATION):
        res.action_effect = review_changed
        if app_changes:
            res.violations.append("Senior reviewer modified application files")
        res.transition_valid = post_s in (WorkflowState.APPROVED_AWAITING_CLOSEOUT, WorkflowState.FIX_REQUIRED)
        res.advanced = res.transition_valid
        if not res.transition_valid:
            res.reason = f"Unexpected post-review state {post_s.value}"
    elif action == ACTION_CLOSEOUT:
        res.action_effect = closeout_changed
        accepted = {WorkflowState.ACCEPTED_WITH_COMMIT_WORTHY_CHANGES, WorkflowState.ACCEPTED_NO_COMMIT_WORTHY_CHANGES}
        res.transition_valid = post_s in accepted or post_state.active_task_id != initial_state.active_task_id
        res.advanced = res.transition_valid
        if not res.transition_valid:
            res.reason = f"Unexpected post-closeout state {post_s.value}"
    else:
        res.reason = f"Unknown action kind {action}"

    res.postconditions_valid = res.action_effect and not res.violations
    return res


class SupervisorRunner:
    """Deterministic orchestrator for Workflow v2 transitions and agent handoffs."""

    def __init__(self, config: Optional[SupervisorConfig] = None):
        self.config = config or SupervisorConfig()
        self.codex_adapter = CodexAdapter(self.config)
        self.antigravity_adapter = AntigravityAdapter(self.config)
        
        # In-memory execution tracking for retry limits
        self.planner_attempts: Dict[str, int] = {}
        self.impl_attempts: Dict[str, int] = {}
        self.fix_cycles: Dict[str, int] = {}
        self.completed_tasks_count = 0

        # What the last run_step actually executed (None = nothing executed)
        self.last_action: Optional[str] = None
        self.last_run_record: Optional[Dict[str, Any]] = None
        self.current_run_id: str = ""
        self.invocation_started_at: str = ""
        self.expected_provider: str = ""
        self.current_agent_result: Optional[AgentResult] = None
        self.current_invocation: Optional[AgentInvocation] = None
        self.on_invocation: Optional[Callable[[AgentInvocation], None]] = None
        self.report_validation_marker: str = ""

    def get_status(self) -> DerivedState:
        """Read-only query of the current workflow and repository state."""
        return derive_workflow_state(self.config)

    def write_stop_report(self, report: StopReport) -> None:
        """Write structured stop report JSON under .git/ks-runtime/."""
        self.config.runtime_dir.mkdir(parents=True, exist_ok=True)
        report_file = self.config.runtime_dir / "stop_report.json"
        data = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "state": report.state.value,
            "task_id": report.task_id,
            "reason": report.reason,
            "question_for_human": report.question_for_human,
            "evidence": report.evidence,
            "recommended_next_action": report.recommended_next_action,
            "resume_command": report.resume_command,
        }
        try:
            report_file.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception:
            pass

    def execute_auto_commit(self, task: TaskContract, git_state: GitState) -> Tuple[bool, Optional[str]]:
        """Execute the Hygiene-Gated Auto-Commit workflow (Workflow v2 Section 5)."""
        # Feature gate check
        if not self.config.enable_auto_commit:
            return False, "PRECOMMIT_GATED: auto-commit is disabled in current configuration. Enable via --enable-auto-commit."

        # 1. Authorized Branch Gate (B-3)
        authorized_branch = ""
        if task.branch_worktree:
            # Handle formats like "feat/branch / primary worktree" or "feat/branch; primary worktree"
            parts = re.split(r"\s+/\s+|\s*;\s*", task.branch_worktree)
            authorized_branch = parts[0].strip()

        if not authorized_branch:
            return False, "PRECOMMIT_BLOCKED: missing or ambiguous authorized branch in task contract"

        if git_state.branch != authorized_branch:
            return False, f"PRECOMMIT_BLOCKED: branch mismatch — expected '{authorized_branch}', found '{git_state.branch}'"

        if git_state.branch in {"UI/UX-fixes-after-production", "main", "master"}:
            return False, f"PRECOMMIT_BLOCKED: committing directly to protected branch '{git_state.branch}' is prohibited"

        # 2. Mixed Index Pre-Inspection (B-2)
        if git_state.staged_files:
            return False, f"PRECOMMIT_BLOCKED: mixed index detected — unexpected staged files: {git_state.staged_files}"

        # 3. Selective Staging (B-2)
        # Stage only modified files
        files_to_stage = git_state.modified_files + git_state.untracked_files
        if not files_to_stage:
            return True, "No files to commit"

        for f in files_to_stage:
            code, _, err = run_git(self.config.repo_root, "add", f)
            if code != 0:
                return False, f"PRECOMMIT_BLOCKED: failed to stage file '{f}': {err}"

        # 4. Hygiene Check (B-1)
        hygiene_code, hygiene_output = run_hygiene_check(self.config.repo_root, self.config.hygiene_script_path)
        if hygiene_code != 0:
            # Unstage on hygiene block
            run_git(self.config.repo_root, "reset")
            return False, f"PRECOMMIT_BLOCKED: hygiene check failed:\n{hygiene_output}"

        # 5. Atomic Commit
        commit_msg = f"{task.task_id}: {task.title or 'Accepted task changes'}"
        code, out, err = run_git(self.config.repo_root, "commit", "-m", commit_msg)
        if code != 0:
            return False, f"PRECOMMIT_BLOCKED: git commit failed: {err}"

        # 6. Record Metadata
        return True, f"Committed accepted task {task.task_id} as {head_sha[:8]}"

    def verify_post_agent_state(
        self,
        initial_state: DerivedState,
        result: AgentResult,
        expected_role: Role,
        pre_baseline: Optional[RepositoryBaseline] = None,
        post_baseline: Optional[RepositoryBaseline] = None,
        delta: Optional[RepositoryDelta] = None,
        action: Optional[str] = None,
        post_state: Optional[DerivedState] = None,
        report_validated: bool = False,
    ) -> Optional[StopReport]:
        """Verify repository state after child agent execution."""
        task_id = initial_state.active_task_id

        if self.current_run_id:
            try:
                current_time = datetime.fromisoformat(result.started_at)
                valid_time = datetime.fromisoformat(self.invocation_started_at) <= current_time <= datetime.now(timezone.utc)
            except (ValueError, TypeError):
                valid_time = False
            if (result.run_id != self.current_run_id or result.provider != self.expected_provider
                    or result.role != expected_role or result.task_id != task_id or not valid_time):
                return StopReport(
                    state=WorkflowState.AGENT_EXECUTION_NOT_OBSERVED, task_id=task_id,
                    reason="AGENT_EXECUTION_NOT_OBSERVED: missing or mismatched current-run execution identity",
                    evidence={"run_id": self.current_run_id, "result_run_id": result.run_id,
                              "provider": result.provider, "role": result.role.value, "valid_time": valid_time},
                )
        
        # Preflight/launch failures never constitute an observed provider result.
        if result.infrastructure_failure:
            invocation = self.current_invocation
            if invocation and (result.model_name != invocation.model or result.effort != invocation.effort):
                return StopReport(state=WorkflowState.SUPERVISOR_INVOCATION_IDENTITY_MISMATCH,
                                  task_id=task_id, reason="SUPERVISOR_INVOCATION_IDENTITY_MISMATCH: infrastructure result identity differs")
            valid = (result.infrastructure_failure in {WorkflowState.AGENT_INVOCATION_TOO_LARGE, WorkflowState.AGENT_LAUNCH_FAILED}
                     and result.process_started is False and not result.success and not result.process_completed
                     and not result.provider_reported_success and result.exit_code != 0)
            stop_state = result.infrastructure_failure if valid else (
                WorkflowState.AGENT_RESULT_MISMATCH if result.process_started is True
                else WorkflowState.AGENT_EXECUTION_NOT_OBSERVED)
            return StopReport(state=stop_state, task_id=task_id,
                              reason=f"{stop_state.value}: {result.error_message or 'inconsistent invocation lifecycle'}",
                              evidence={"run_id": result.run_id, "provider": result.provider,
                                        "model": result.model_name, "action": action,
                                        "process_started": result.process_started,
                                        **result.stream_summary},
                              recommended_next_action="Inspect supervisor invocation diagnostics; preserve partial work and existing evidence")

        if result.process_started is False:
            return StopReport(state=WorkflowState.AGENT_EXECUTION_NOT_OBSERVED, task_id=task_id,
                              reason="AGENT_EXECUTION_NOT_OBSERVED: no provider process started; output cannot certify completion",
                              evidence={"run_id": result.run_id, "process_started": False})

        # 0. Check for explicit provider quota or authentication failure
        if result.auth_or_quota_failure:
            return StopReport(
                state=WorkflowState.PROVIDER_QUOTA_OR_AUTH_REQUIRED,
                task_id=task_id,
                reason=f"Provider quota or authentication required: {result.error_message}",
                evidence={
                    "provider": result.provider,
                    "model": result.model_name,
                    "exit_code": result.exit_code,
                    "stderr": result.stderr[:300] if result.stderr else "",
                    "stdout": result.stdout[-300:] if result.stdout else "",
                },
                recommended_next_action="Verify Google AI account authentication (`agy auth login`) or check account plan quota before resuming.",
                resume_command="ks-supervisor run --once --live",
            )

        # 1. Check for permission denials (headless auto-denials or tool denials)
        if result.soft_permission_denial or (hasattr(result, "denied_actions") and result.denied_actions):
            denied_str = ", ".join(result.denied_actions) if getattr(result, "denied_actions", None) else "unapproved tool command"
            return StopReport(
                state=WorkflowState.AGENT_PERMISSION_REQUIRED,
                task_id=task_id,
                reason=f"AGENT_PERMISSION_REQUIRED: Agent encountered tool permission denial ({denied_str}) during headless execution",
                evidence={
                    "denied_actions": getattr(result, "denied_actions", []),
                    "provider": result.provider,
                    "model": result.model_name,
                    "exit_code": result.exit_code,
                    "stderr": result.stderr[:400] if result.stderr else "",
                    "stdout_snippet": result.stdout[-400:] if result.stdout else "",
                },
                recommended_next_action="Instruct agent to use built-in workspace discovery tools (list_dir, grep_search, view_file) instead of shell navigation, or adjust permission policy if genuinely required.",
                resume_command="ks-supervisor run --once --live",
            )

        # 1b. Check for execution timeout (idle stall or hard maximum)
        if result.timed_out or result.exit_code == 124:
            has_progress = delta.observable_effect if delta else result.observable_repo_effect
            kind_str = result.timeout_kind or "hard_limit"
            if has_progress:
                reason = f"AGENT_EXECUTION_TIMEOUT: agent made observable progress but did not complete within the bounded execution window ({kind_str})"
                rec_action = "Inspect existing partial changes in working tree and resume with a continuation run (`ks-supervisor run --once --live`)"
            else:
                reason = f"AGENT_EXECUTION_TIMEOUT: agent timed out ({kind_str}) without producing observable changes to the repository"
                rec_action = "Check if agent stalled on tool execution or model generation and resume (`ks-supervisor run --once --live`)"

            return StopReport(
                state=WorkflowState.AGENT_EXECUTION_TIMEOUT,
                task_id=task_id,
                reason=reason,
                evidence={
                    "timed_out": True,
                    "timeout_kind": kind_str,
                    "observable_repo_effect": has_progress,
                    "events_received": result.events_received,
                    "last_step_index": result.last_step_index,
                    "last_tool_name": result.last_tool_name,
                    "last_tool_target": result.last_tool_target,
                    "last_activity_at": result.last_activity_at,
                    "token_usage": result.token_usage,
                    "duration_seconds": result.duration_seconds,
                    "delta": {
                        "modified_files": delta.modified_files if delta else [],
                        "new_files": delta.new_files if delta else [],
                        "deleted_files": delta.deleted_files if delta else [],
                    } if delta else None,
                },
                recommended_next_action=rec_action,
                resume_command="ks-supervisor run --once --live",
            )

        invocation = self.current_invocation
        if invocation and (result.model_name != invocation.model or result.effort != invocation.effort):
            return StopReport(
                state=WorkflowState.SUPERVISOR_INVOCATION_IDENTITY_MISMATCH, task_id=task_id,
                reason="SUPERVISOR_INVOCATION_IDENTITY_MISMATCH: result model/effort differs from invocation",
                evidence={"run_id": invocation.run_id},
            )

        # 2. Verify agent process success
        if not result.success or not result.process_completed or result.exit_code != 0:
            return StopReport(
                state=(WorkflowState.AGENT_EXECUTION_FAILED if not result.success
                       else WorkflowState.AGENT_RESULT_MISMATCH),
                task_id=task_id,
                reason=f"Agent ({expected_role.value}) failed: {result.error_message or f'exit code {result.exit_code}'}",
                evidence={"exit_code": result.exit_code, "stderr": result.stderr[:300] if result.stderr else ""},
                recommended_next_action="Inspect agent error diagnostics and retry",
                resume_command="ks-supervisor run --once --live",
            )

        # 3. Check for observable effect on write-capable actions
        if action == ACTION_TARGETED_VERIFICATION:
            key = f"review:{task_id}-review.md"
            before = pre_baseline.artifact_hashes.get(key, "") if pre_baseline else ""
            after = post_baseline.artifact_hashes.get(key, "") if post_baseline else ""
            review_file = self.config.reviews_dir / f"{task_id}-review.md"
            content = review_file.read_text(encoding="utf-8") if review_file.exists() else ""
            parsed_review = parse_review(review_file)
            section = parsed_review.current_content if parsed_review else ""
            correction = pre_baseline.artifact_hashes.get(f"report:{task_id}-implementation.md", "") if pre_baseline else ""
            decision = parsed_review.decision if parsed_review else "UNKNOWN"
            remaining = re.search(r"^Remaining blockers:\s*(.+)$", section, re.M)
            evidence = re.search(r"^Evidence:\s*(\S[^\n]*)$", section, re.M)
            valid = (before != after and bool(after) and bool(correction)
                     and f"Run ID: {self.current_run_id}\n" in section
                     and f"Correction report SHA256: {correction}\n" in section
                     and decision in ("APPROVED", "FIX_REQUIRED") and remaining and evidence)
            if valid:
                approved = decision == "APPROVED"
                valid = ((approved and parsed_review.blockers_explicitly_empty and post_state.state == WorkflowState.APPROVED_AWAITING_CLOSEOUT)
                         or (not approved and re.search(r"\bB-\d+\b", remaining.group(1))
                             and post_state.state == WorkflowState.FIX_REQUIRED and post_state.assigned_role == Role.IMPLEMENTATION))
            if not valid:
                return StopReport(
                    state=WorkflowState.SENIOR_REVIEW_NO_EFFECT, task_id=task_id,
                    reason="SENIOR_REVIEW_NO_EFFECT: canonical review lacks changed current-run evidence or a valid targeted decision/transition",
                    evidence={"run_id": self.current_run_id, "review_path": str(review_file),
                              "review_sha256_before": before, "review_sha256_after": after,
                              "correction_report_sha256": correction},
                )

        write_actions = {
            ACTION_IMPLEMENTATION,
            ACTION_FIX,
            ACTION_SENIOR_AUTOPILOT,
            ACTION_PLANNING,
            ACTION_REVIEW,
            ACTION_TARGETED_VERIFICATION,
            ACTION_CLOSEOUT,
        }
        if delta is not None:
            result.observable_repo_effect = delta.observable_effect
            if action in write_actions and not delta.observable_effect and not report_validated:
                return StopReport(
                    state=WorkflowState.AGENT_RESULT_MISMATCH,
                    task_id=task_id,
                    reason=f"{NO_OBSERVABLE_AGENT_EFFECT}: Agent ({expected_role.value}) completed with exit code 0 but produced no observable changes to code, workflow artifacts, or git state for {task_id}.",
                    evidence={
                        "provider": result.provider,
                        "model": result.model_name,
                        "exit_code": result.exit_code,
                        "duration_seconds": result.duration_seconds,
                        "action": action,
                        "session_id": result.session_id,
                        "token_usage": result.token_usage,
                        "stderr_snippet": result.stderr[:300] if result.stderr else "",
                        "stream_summary": result.stream_summary,
                    },
                    recommended_next_action="Inspect agent prompt/mode to ensure it produces required edits or artifacts.",
                    resume_command="ks-supervisor run --once --live",
                )

        # 4. Action-specific postcondition validation
        if action and post_state and delta:
            pc = evaluate_postconditions(action, initial_state, post_state, delta, report_validated)
            result.postconditions_valid = pc.postconditions_valid
            result.workflow_transition_valid = pc.transition_valid

            if not pc.action_effect:
                return StopReport(
                    state=WorkflowState.AGENT_RESULT_MISMATCH,
                    task_id=task_id,
                    reason=f"{NO_ACTION_SPECIFIC_EFFECT}: Agent ({expected_role.value}) made changes, but none met required action effects for {action}.",
                    evidence=pc.details,
                    recommended_next_action=f"Ensure agent modifies required artifacts or code for {action}.",
                    resume_command="ks-supervisor run --once --live",
                )
            if pc.violations:
                return StopReport(
                    state=WorkflowState.AGENT_RESULT_MISMATCH,
                    task_id=task_id,
                    reason=f"{POSTCONDITION_VIOLATION}: {'; '.join(pc.violations)}",
                    evidence={"violations": pc.violations, "details": pc.details},
                    recommended_next_action="Ensure agent respects role and workflow boundaries.",
                    resume_command="ks-supervisor run --once --live",
                )
            if not pc.transition_valid:
                return StopReport(
                    state=WorkflowState.AGENT_RESULT_MISMATCH,
                    task_id=task_id,
                    reason=f"{INVALID_WORKFLOW_TRANSITION}: Post-agent state '{post_state.state.value}' is not valid for action '{action}': {pc.reason}",
                    evidence={"post_state": post_state.state.value, "reason": pc.reason, "details": pc.details},
                    recommended_next_action="Check agent output conforms to expected workflow state progression.",
                    resume_command="ks-supervisor run --once --live",
                )

        # 5. Check expected artifact production
        if initial_state.state == WorkflowState.READY_FOR_PLANNING:
            plan_file = find_plan_file(self.config.plans_dir, task_id)
            if not plan_file or not plan_file.exists() or plan_file.stat().st_size == 0:
                return StopReport(
                    state=WorkflowState.AGENT_RESULT_MISMATCH,
                    task_id=task_id,
                    reason=f"Planner agent exited without creating required non-empty plan artifact for {task_id}",
                    recommended_next_action=f"Verify plans/{task_id}-plan.md creation",
                    resume_command="ks-supervisor run --once --live",
                )

        if initial_state.state in {WorkflowState.DIRECT_IMPLEMENTATION, WorkflowState.PLAN_READY_FOR_IMPLEMENTATION, WorkflowState.IMPLEMENTATION_IN_PROGRESS}:
            report_file = find_report_file(self.config.reports_dir, task_id)
            if not report_file or not report_file.exists():
                return StopReport(
                    state=WorkflowState.AGENT_RESULT_MISMATCH,
                    task_id=task_id,
                    reason=f"Implementation agent exited without creating implementation report for {task_id}",
                    recommended_next_action=f"Create reports/{task_id}-implementation.md",
                    resume_command="ks-supervisor run --once --live",
                )

        if initial_state.state in {WorkflowState.IMPLEMENTED_AWAITING_REVIEW, WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION}:
            review_file = find_review_file(self.config.reviews_dir, task_id)
            if not review_file or not review_file.exists():
                return StopReport(
                    state=WorkflowState.AGENT_RESULT_MISMATCH,
                    task_id=task_id,
                    reason=f"Senior reviewer exited without creating review artifact for {task_id}",
                    recommended_next_action=f"Create reviews/{task_id}-review.md",
                    resume_command="ks-supervisor run --once --live",
                )

        return None

    def _record_session_telemetry(
        self,
        state: DerivedState,
        result: AgentResult,
        delta: Optional[RepositoryDelta] = None,
        action: Optional[str] = None,
        post_state: Optional[DerivedState] = None,
        pre_baseline: Optional[RepositoryBaseline] = None,
        post_baseline: Optional[RepositoryBaseline] = None,
    ) -> None:
        """Record structured runtime execution telemetry into session.jsonl and last_agent_run.json."""
        self.config.runtime_dir.mkdir(parents=True, exist_ok=True)
        session_file = self.config.runtime_dir / "session.jsonl"
        last_run_file = self.config.runtime_dir / "last_agent_run.json"

        argv_clean = safe_argv(result.cmd_argv)
        invocation = self.current_invocation

        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "run_id": self.current_run_id,
            "result_run_id": result.run_id,
            "started_at": result.started_at,
            "invocation_started_at": self.invocation_started_at,
            "verifier_run_id": self.current_run_id,
            "task_id": state.active_task_id,
            "role": result.role.value,
            "action": action or "",
            "workflow_state_before": state.state.value,
            "workflow_state_after": post_state.state.value if post_state else state.state.value,
            "provider": self.expected_provider or result.provider,
            "result_provider": result.provider,
            "final_message_path": result.final_message_path,
            "model": result.model_name,
            "effort": result.effort,
            "escalation_level": state.model_selection.escalation_level if state.model_selection else 0,
            "selection_reason": state.model_selection.reason if state.model_selection else "",
            "cmd_argv": argv_clean,
            "exit_code": result.exit_code,
            "duration_seconds": result.duration_seconds,
            "success": result.success,
            "process_completed": result.process_completed,
            "process_started": result.process_started,
            "infrastructure_failure": result.infrastructure_failure.value if result.infrastructure_failure else None,
            "provider_reported_success": result.provider_reported_success,
            "observable_repo_effect": delta.observable_effect if delta else False,
            "postconditions_valid": result.postconditions_valid,
            "workflow_transition_valid": result.workflow_transition_valid,
            "session_id": result.session_id,
            "token_usage": result.token_usage,
            "stream_summary": result.stream_summary,
            "denied_actions": getattr(result, "denied_actions", []),
            "soft_permission_denial": result.soft_permission_denial,
            "timed_out": result.timed_out,
            "timeout_kind": result.timeout_kind,
            "last_activity_at": result.last_activity_at,
            "last_step_index": result.last_step_index,
            "last_tool_name": result.last_tool_name,
            "last_tool_target": result.last_tool_target,
            "events_received": result.events_received,
        }

        entry["artifact_delta"] = delta.changed_workflow_artifacts if delta else []
        if invocation:
            entry.update({
                "run_id": invocation.run_id, "task_id": invocation.task_id,
                "workflow_state_before": invocation.workflow_state_before,
                "action": invocation.action, "role": invocation.role.value,
                "provider": invocation.provider, "model": invocation.model, "effort": invocation.effort,
                "selection_reason": invocation.selection_reason,
                "invocation": {**asdict(invocation), "role": invocation.role.value},
                "result_role": result.role.value, "result_model": result.model_name,
            })
        key = f"review:{state.active_task_id}-review.md"
        entry["review_sha256_before"] = pre_baseline.artifact_hashes.get(key, "") if pre_baseline else ""
        entry["review_sha256_after"] = post_baseline.artifact_hashes.get(key, "") if post_baseline else ""

        # Last agent run diagnostic object
        last_run_data = dict(entry)
        last_run_data["error_message"] = result.error_message
        last_run_data["auth_or_quota_failure"] = result.auth_or_quota_failure
        last_run_data["soft_permission_denial"] = result.soft_permission_denial
        last_run_data["denied_actions"] = getattr(result, "denied_actions", [])
        last_run_data["final_status"] = result.final_status
        last_run_data["timed_out"] = result.timed_out
        last_run_data["timeout_kind"] = result.timeout_kind
        last_run_data["last_activity_at"] = result.last_activity_at
        last_run_data["last_step_index"] = result.last_step_index
        last_run_data["last_tool_name"] = result.last_tool_name
        last_run_data["last_tool_target"] = result.last_tool_target
        last_run_data["events_received"] = result.events_received
        if delta:
            last_run_data["delta"] = {
                "observable_effect": delta.observable_effect,
                "modified_files": delta.modified_files,
                "new_files": delta.new_files,
                "deleted_files": delta.deleted_files,
                "changed_workflow_artifacts": delta.changed_workflow_artifacts,
                "head_changed": delta.head_changed,
                "branch_changed": delta.branch_changed,
            }
        else:
            last_run_data["delta"] = None

        if result.stdout:
            last_run_data["stdout_snippet"] = redact_secrets(result.stdout[-DIAG_STDOUT_LIMIT:])
        if result.stderr:
            last_run_data["stderr_snippet"] = redact_secrets(result.stderr[-DIAG_STDERR_LIMIT:])

        last_run_data["final_message"] = redact_secrets(result.final_message[-DIAG_STDOUT_LIMIT:])
        last_run_data["final_message_path"] = result.final_message_path
        with open(session_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        temporary = last_run_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(last_run_data, indent=2), encoding="utf-8")
        temporary.replace(last_run_file)
        self.last_run_record = last_run_data

    def _execute_agent_step(
        self,
        state: DerivedState,
        role: Role,
        action: str,
        invoke_fn: Callable[[str], AgentResult],
    ) -> Tuple[DerivedState, Optional[StopReport]]:
        """Wrap agent invocation with pre/post baseline diffing, telemetry, and validation."""
        task_id = state.active_task_id
        self.last_action = action
        pre_baseline = capture_repository_baseline(self.config, task_id, state.state.value)
        
        self.invocation_started_at = datetime.now(timezone.utc).isoformat()
        profile = state.model_selection.profile if state.model_selection else None
        self.expected_provider = profile.provider if profile else ("antigravity" if role == Role.IMPLEMENTATION else "codex")
        self.current_invocation = AgentInvocation(
            run_id=self.current_run_id, task_id=task_id, workflow_state_before=state.state.value,
            action=action, role=role, provider=self.expected_provider,
            model=profile.model if profile else "", effort=profile.effort if profile else "",
            selection_reason=state.model_selection.reason if state.model_selection else "",
            started_at=self.invocation_started_at,
        )
        delta = None
        post_baseline = None
        post_state = state
        mismatch_report = None
        fix_cycle = self.fix_cycles.get(task_id, 0)
        attempt_count = self.impl_attempts.get(task_id, 0)
        started = time.monotonic()
        completion = None
        report_path = find_report_file(self.config.reports_dir, task_id) or self.config.reports_dir / f"{task_id}-implementation.md"
        implementation_action = role == Role.IMPLEMENTATION and action in (ACTION_FIX, ACTION_IMPLEMENTATION)
        result = AgentResult(role=role, task_id=task_id, exit_code=1, stdout="", stderr="",
                             duration_seconds=0, success=False, run_id=self.current_run_id,
                             started_at=self.invocation_started_at, provider=self.expected_provider,
                             model_name=profile.model if profile else "", effort=profile.effort if profile else "")
        try:
            if implementation_action:
                completion = completion_record(self.config, self.current_invocation, report_path)
                write_completion(self.config, completion)
                if completion["report_sha256"]:
                    self.report_validation_marker = f"REPORT_COMPLETION_VALIDATED: {self.current_run_id} {task_id} {completion['report_sha256']}"
            if self.on_invocation:
                self.on_invocation(self.current_invocation)
            observed = invoke_fn(self.current_run_id)
            if not isinstance(observed, AgentResult):
                raise RuntimeError("AGENT_EXECUTION_NOT_OBSERVED: adapter returned no execution result")
            result = observed
            result.postconditions_valid = False
            result.workflow_transition_valid = False
            self.current_agent_result = result
            post_baseline = capture_repository_baseline(self.config, task_id, state.state.value)
            delta = compute_repository_delta(pre_baseline, post_baseline, self.config.repo_root)
            result.observable_repo_effect = delta.observable_effect
            candidate = completion_record(self.config, self.current_invocation, report_path, result) if implementation_action else None
            verified_context = completion_context(self.config, task_id) if implementation_action else None
            report_validated = bool(implementation_action and self.report_validation_marker
                                    and validation_marker_present(result, self.report_validation_marker)
                                    and candidate["report_sha256"] == completion["report_sha256"])
            if action == ACTION_FIX and not delta.observable_effect:
                review_file = find_review_file(self.config.reviews_dir, task_id)
                review = parse_review(review_file) if review_file else None
                if review and review.decision == "FIX_REQUIRED" and review.blockers:
                    report_validated = False  # A marker cannot override unresolved Senior authority.
            post_state = derive_workflow_state(self.config, fix_cycle=fix_cycle, attempt_count=attempt_count,
                                               completion_candidate=candidate)
            mismatch_report = self.verify_post_agent_state(
                initial_state=state, result=result, expected_role=role,
                pre_baseline=pre_baseline, post_baseline=post_baseline,
                delta=delta, action=action, post_state=post_state,
                report_validated=report_validated,
            )
        except Exception as exc:
            result.success = False
            result.error_message = redact_secrets(str(exc))
            result.stderr = result.error_message
            result.duration_seconds = time.monotonic() - started
            mismatch_report = StopReport(
                state=WorkflowState.AGENT_EXECUTION_NOT_OBSERVED, task_id=task_id,
                reason=f"AGENT_EXECUTION_NOT_OBSERVED: invocation or verification failed: {result.error_message}",
                evidence={"run_id": self.current_run_id},
            )
        if mismatch_report:
            result.success = False
        try:
            self._record_session_telemetry(state, result, delta=delta, action=action, post_state=post_state,
                                           pre_baseline=pre_baseline, post_baseline=post_baseline)
        except OSError as exc:
            self.last_run_record = None
            mismatch_report = StopReport(
                state=WorkflowState.AGENT_EXECUTION_NOT_OBSERVED, task_id=task_id,
                reason=f"AGENT_EXECUTION_NOT_OBSERVED: execution telemetry could not be persisted ({type(exc).__name__})",
                evidence={"run_id": self.current_run_id},
            )
        if not mismatch_report and not self.has_current_execution_record():
            mismatch_report = StopReport(state=WorkflowState.SUPERVISOR_INVOCATION_IDENTITY_MISMATCH, task_id=task_id,
                                         reason="SUPERVISOR_INVOCATION_IDENTITY_MISMATCH: current execution record missing or inconsistent")
        if mismatch_report:
            if implementation_action and completion:
                result.success = False
                try:
                    uncommitted = completion_record(self.config, self.current_invocation, report_path, result)
                    uncommitted.update(status="UNCOMMITTED", success=False, postconditions_valid=False,
                                       workflow_transition_valid=False, workflow_state_after=state.state.value)
                    write_completion(self.config, uncommitted)
                except OSError:
                    pass  # The pre-launch PENDING record already blocks promotion.
            self.write_stop_report(mismatch_report)
            return state, mismatch_report

        if implementation_action:
            # Publish precisely the content evaluated above, never a later report revision.
            completion = dict(candidate)
            completion.update(postconditions_valid=result.postconditions_valid,
                              workflow_transition_valid=result.workflow_transition_valid)
            completion.update(status="VERIFIED" if post_state.state in (
                WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION, WorkflowState.IMPLEMENTED_AWAITING_REVIEW,
            ) else "PARTIAL", workflow_state_after=post_state.state.value)
            try:
                if verified_context != completion_context(self.config, task_id):
                    raise OSError("Implementation content changed after postcondition validation")
                if (action == ACTION_FIX and completion["status"] == "VERIFIED"
                        and VerificationEvidence(self.config, task_id).plan()["required_verification"]):
                    plan = VerificationEvidence(self.config, task_id).plan()
                    completion.update(status="VERIFICATION_PENDING", completion_context=verified_context,
                                      verification_expected_checks=[i["check_id"] for i in
                                                                    plan["required_verification"] + plan["reusable_verification"]])
                write_completion(self.config, completion)
                if completion["status"] == "VERIFICATION_PENDING":
                    if not report_completion_valid(self.config, task_id, report_path, pending=True):
                        raise OSError("Pending completion content changed")
                    pending_state = derive_workflow_state(self.config)
                    report = StopReport(
                        state=WorkflowState.TARGETED_VERIFICATION_REQUIRED, task_id=task_id,
                        reason=pending_state.reason,
                        evidence={"run_id": self.current_run_id,
                                  "required_verification": VerificationEvidence(self.config, task_id).plan()["required_verification"]},
                        recommended_next_action="Execute the supervisor's deterministic targeted verification transition",
                        resume_command="python -m tools.ks_supervisor run --once --live",
                    )
                    self.write_stop_report(report)
                    return pending_state, report
                if completion["status"] == "VERIFIED" and not report_completion_valid(self.config, task_id, report_path):
                    completion.update(status="UNCOMMITTED", success=False)
                    write_completion(self.config, completion)
                    raise OSError("Report changed after completion verification")
            except OSError:
                result.success = False
                result.postconditions_valid = False
                result.workflow_transition_valid = False
                report = StopReport(state=WorkflowState.AGENT_EXECUTION_NOT_OBSERVED, task_id=task_id,
                                    reason="Completion attestation could not be persisted; partial work remains uncommitted workflow evidence")
                try:
                    self._record_session_telemetry(state, result, delta=delta, action=action, post_state=state)
                except OSError:
                    self.last_run_record = None
                self.write_stop_report(report)
                return state, report

        # An explicitly verified unchanged report is also a completed continuation.
        if (delta.observable_effect or report_validated) and result.postconditions_valid:
            if action == ACTION_FIX:
                self.fix_cycles[task_id] = fix_cycle + 1
            elif action in (ACTION_IMPLEMENTATION, ACTION_SENIOR_AUTOPILOT):
                self.impl_attempts[task_id] = attempt_count + 1
            elif action == ACTION_PLANNING:
                self.planner_attempts[task_id] = self.planner_attempts.get(task_id, 0) + 1

        return post_state, None

    def has_current_execution_record(self) -> bool:
        """Completion requires both persisted records and the observed current result."""
        result = self.current_agent_result
        invocation = self.current_invocation
        if not result or not invocation or not result.success or result.run_id != self.current_run_id:
            return False
        if (invocation.run_id != result.run_id or invocation.role != result.role
                or invocation.provider != result.provider or invocation.model != result.model_name
                or invocation.effort != result.effort or invocation.task_id != result.task_id):
            return False
        if result.final_message_path and invocation.run_id not in Path(result.final_message_path).name:
            return False
        try:
            record = json.loads((self.config.runtime_dir / "last_agent_run.json").read_text(encoding="utf-8"))
            session = json.loads((self.config.runtime_dir / "session.jsonl").read_text(encoding="utf-8").splitlines()[-1])
            return all(
                item.get("run_id") == self.current_run_id
                and item.get("result_run_id") == self.current_run_id
                and item.get("verifier_run_id") == self.current_run_id
                and item.get("provider") == self.expected_provider == result.provider
                and item.get("result_provider") == result.provider
                and item.get("role") == result.role.value
                and item.get("result_role") == result.role.value
                and item.get("result_model") == result.model_name
                and item.get("model") == invocation.model
                and item.get("effort") == invocation.effort
                and item.get("task_id") == invocation.task_id
                and item.get("workflow_state_before") == invocation.workflow_state_before
                and item.get("action") == invocation.action
                and item.get("invocation") == {**asdict(invocation), "role": invocation.role.value}
                and item.get("final_message_path") == result.final_message_path
                and item.get("started_at") == result.started_at
                and self.invocation_started_at <= item.get("timestamp", "") <= datetime.now(timezone.utc).isoformat()
                and item.get("success") and item.get("postconditions_valid") and item.get("workflow_transition_valid")
                for item in (record, session)
            )
        except (OSError, ValueError, IndexError, TypeError, AttributeError):
            return False

    def run_step(self, dry_run: bool = False, execute_agents: bool = False,
                 on_invocation: Optional[Callable[[AgentInvocation], None]] = None) -> Tuple[DerivedState, Optional[StopReport]]:
        """Perform a single deterministic workflow step or handoff transition."""
        self.current_run_id = uuid4().hex
        self.current_agent_result = None
        self.last_run_record = None
        self.last_action = None
        self.current_invocation = None
        self.current_verification_record = None
        self.on_invocation = on_invocation
        self.report_validation_marker = ""
        with SupervisorLock(self.config) as lock:
            # First pass to identify active task
            pre_state = derive_workflow_state(self.config)
            task_id = pre_state.active_task_id
            fix_cycle = self.fix_cycles.get(task_id, 0)
            attempt_count = self.impl_attempts.get(task_id, 0)

            # Re-derive state with accurate retry/fix counts for model selection
            state = derive_workflow_state(self.config, fix_cycle=fix_cycle, attempt_count=attempt_count)
            lock.update_heartbeat(task_id=state.active_task_id, role=state.assigned_role.value)

            # Handle Hard Stops
            if state.is_hard_stop:
                stop_report = StopReport(
                    state=state.state,
                    task_id=state.active_task_id,
                    reason=state.reason,
                    question_for_human=state.reason if state.state == WorkflowState.USER_DECISION_REQUIRED else None,
                    evidence={
                        "branch": state.git_state.branch if state.git_state else "unknown",
                        "head": state.git_state.head_sha if state.git_state else "unknown",
                        "checkpoint_task": state.checkpoint.current_task if state.checkpoint else "unknown",
                        "checkpoint_status": state.checkpoint.current_task_status if state.checkpoint else "unknown",
                    },
                    recommended_next_action="Review and resolve the blocker reported above",
                    resume_command="ks-supervisor run --once",
                )
                self.write_stop_report(stop_report)
                return state, stop_report

            # Dry Run Mode: report action without executing agents or modifying Git
            if dry_run or not execute_agents:
                return state, None

            if state.assigned_role == Role.SUPERVISOR and state.state == WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION:
                return self._execute_targeted_verification(state, lock)

            # 1. Check Live Feature Gate
            if not self.config.enable_live_agents and state.assigned_role in {Role.SENIOR, Role.PLANNER, Role.IMPLEMENTATION}:
                stop_report = StopReport(
                    state=WorkflowState.USER_DECISION_REQUIRED,
                    task_id=state.active_task_id,
                    reason="Live AI agent execution is gated in MVP. Pass --live to explicitly authorize one live agent call.",
                    recommended_next_action="Review action via `ks-supervisor run --once --dry-run` or execute with `ks-supervisor run --once --live`",
                    resume_command="ks-supervisor run --once --live",
                )
                self.write_stop_report(stop_report)
                return state, stop_report

            # 2. Check Model Availability (Fail-Closed)
            if state.model_selection and state.model_selection.profile:
                profile = state.model_selection.profile
                is_available, avail_msg = validate_profile_availability(profile, self.config)
                if not is_available:
                    failure_kind = avail_msg.partition(":")[0]
                    discovery_stops = {
                        kind.value: kind for kind in (
                            WorkflowState.MODEL_DISCOVERY_TIMEOUT, WorkflowState.MODEL_DISCOVERY_FAILED,
                            WorkflowState.PROVIDER_QUOTA_OR_AUTH_REQUIRED, WorkflowState.MODEL_NOT_AVAILABLE,
                        )
                    }
                    failure_state = discovery_stops.get(failure_kind, WorkflowState.MODEL_DISCOVERY_FAILED)
                    guidance = {
                        WorkflowState.MODEL_DISCOVERY_TIMEOUT: "Retry after provider discovery recovers, or inspect agy models/provider connectivity. Do not change model profile solely because discovery timed out.",
                        WorkflowState.MODEL_DISCOVERY_FAILED: "Inspect provider CLI/model discovery errors and connectivity, then retry discovery. Model availability has not been determined.",
                        WorkflowState.PROVIDER_QUOTA_OR_AUTH_REQUIRED: "Restore provider authentication or quota, then retry model discovery.",
                        WorkflowState.MODEL_NOT_AVAILABLE: "Inspect the successful provider inventory and configured model profile; the selected model was absent. Configure an authorized profile only if appropriate.",
                    }
                    stop_report = StopReport(
                        state=failure_state,
                        task_id=state.active_task_id,
                        reason=avail_msg,
                        evidence={
                            "provider": profile.provider,
                            "profile": profile.name,
                            "model": profile.model,
                            "effort": profile.effort,
                        },
                        recommended_next_action=guidance[failure_state],
                        resume_command="ks-supervisor run --once --live",
                    )
                    self.write_stop_report(stop_report)
                    return state, stop_report

            # Handle Supervisor Auto-Commit
            if state.state == WorkflowState.ACCEPTED_WITH_COMMIT_WORTHY_CHANGES:
                if state.task_contract and state.git_state:
                    success, message = self.execute_auto_commit(state.task_contract, state.git_state)
                    if not success:
                        stop_report = StopReport(
                            state=WorkflowState.PRECOMMIT_BLOCKED,
                            task_id=state.active_task_id,
                            reason=message or "Precommit blocked",
                            evidence={"branch": state.git_state.branch},
                            recommended_next_action="Inspect precommit block and resolve hygiene or branch mismatch",
                            resume_command="ks-supervisor run --once",
                        )
                        self.write_stop_report(stop_report)
                        return state, stop_report
                
                # Re-derive state after commit
                new_state = derive_workflow_state(self.config)
                return new_state, None

            # Handle Agent Invocations
            task_id = state.active_task_id
            task = state.task_contract
            selected_profile = state.model_selection.profile if state.model_selection else None
            
            # A. Senior Autopilot Invocation (Codex)
            if state.assigned_role == Role.SENIOR and task and task.execution_mode == ExecutionMode.SENIOR_AUTOPILOT:
                attempts = self.impl_attempts.get(task_id, 0)
                if attempts >= self.config.max_impl_attempts_per_task:
                    stop_report = StopReport(
                        state=WorkflowState.REPEATED_AGENT_FAILURE,
                        task_id=task_id,
                        reason=f"Autopilot attempt limit ({self.config.max_impl_attempts_per_task}) exhausted for {task_id}",
                        recommended_next_action="Senior engineer inspects task manually",
                        resume_command="ks-supervisor run --once --live",
                    )
                    self.write_stop_report(stop_report)
                    return state, stop_report

                return self._execute_agent_step(
                    state=state,
                    role=Role.SENIOR,
                    action=ACTION_SENIOR_AUTOPILOT,
                    invoke_fn=lambda run_id: self.codex_adapter.invoke(Role.SENIOR, task_id, action_type="SENIOR_AUTOPILOT", task=task, profile=selected_profile, run_id=run_id),
                )

            # B. Planner Invocation (Codex)
            if state.state == WorkflowState.READY_FOR_PLANNING:
                attempts = self.planner_attempts.get(task_id, 0)
                if attempts >= self.config.max_planner_attempts_per_task:
                    stop_report = StopReport(
                        state=WorkflowState.REPEATED_AGENT_FAILURE,
                        task_id=task_id,
                        reason=f"Planner attempt limit ({self.config.max_planner_attempts_per_task}) exhausted for {task_id}",
                        recommended_next_action="Inspect task contract and manually draft or refine plan",
                        resume_command="ks-supervisor run --once --live",
                    )
                    self.write_stop_report(stop_report)
                    return state, stop_report

                return self._execute_agent_step(
                    state=state,
                    role=Role.PLANNER,
                    action=ACTION_PLANNING,
                    invoke_fn=lambda run_id: self.codex_adapter.invoke(Role.PLANNER, task_id, action_type="PLANNING", task=task, profile=selected_profile, run_id=run_id),
                )

            # C. Implementation / Fix Invocation (Antigravity Gemini)
            if state.state in {
                WorkflowState.PLAN_READY_FOR_IMPLEMENTATION,
                WorkflowState.DIRECT_IMPLEMENTATION,
                WorkflowState.IMPLEMENTATION_IN_PROGRESS,
                WorkflowState.FIX_REQUIRED,
            }:
                is_fix = state.state == WorkflowState.FIX_REQUIRED
                action = ACTION_FIX if is_fix else ACTION_IMPLEMENTATION
                if is_fix:
                    cycles = self.fix_cycles.get(task_id, 0)
                    if cycles >= self.config.max_fix_cycles_per_task:
                        stop_report = StopReport(
                            state=WorkflowState.REPEATED_AGENT_FAILURE,
                            task_id=task_id,
                            reason=f"Maximum FIX_REQUIRED cycles ({self.config.max_fix_cycles_per_task}) exhausted for {task_id}",
                            recommended_next_action="Senior engineer must review persistent blockers manually",
                            resume_command="ks-supervisor run --once --live",
                        )
                        self.write_stop_report(stop_report)
                        return state, stop_report
                else:
                    attempts = self.impl_attempts.get(task_id, 0)
                    if attempts >= self.config.max_impl_attempts_per_task:
                        stop_report = StopReport(
                            state=WorkflowState.REPEATED_AGENT_FAILURE,
                            task_id=task_id,
                            reason=f"Implementation attempt limit ({self.config.max_impl_attempts_per_task}) exhausted for {task_id}",
                            recommended_next_action="Review implementation blockers",
                            resume_command="ks-supervisor run --once --live",
                        )
                        self.write_stop_report(stop_report)
                        return state, stop_report

                canonical_paths = {
                    "task": str(find_task_file(self.config.tasks_dir, task_id).relative_to(self.config.repo_root)).replace("\\", "/") if find_task_file(self.config.tasks_dir, task_id) else f"docs/engineering/ai/tasks/{task_id}.md",
                    "report": f"docs/engineering/ai/reports/{task_id}-implementation.md",
                    "review": f"docs/engineering/ai/reviews/{task_id}-review.md",
                    "checkpoint": "docs/engineering/IMPLEMENTATION_CHECKPOINT.md",
                }
                plan_file = find_plan_file(self.config.plans_dir, task_id)
                if plan_file and plan_file.exists():
                    canonical_paths["plan"] = str(plan_file.relative_to(self.config.repo_root)).replace("\\", "/")

                dirty_files: List[str] = []
                if state.git_state:
                    dirty_files = list(state.git_state.modified_files) + list(state.git_state.untracked_files)

                verification = VerificationEvidence(self.config, task_id)
                verification_plan = verification.plan()
                try:
                    verification.freeze(self.current_run_id, verification_plan)
                except (OSError, ValueError) as exc:
                    report = StopReport(state=WorkflowState.REQUIRED_VERIFICATION_UNEXECUTABLE,
                                        task_id=task_id,
                                        reason=f"REQUIRED_VERIFICATION_UNEXECUTABLE: cannot freeze pre-launch plan ({type(exc).__name__})")
                    self.write_stop_report(report)
                    return state, report
                denied = [i for i in verification_plan["required_verification"] if not i["authorized"]]
                if denied or verification_plan["permission_policy"]["error"]:
                    report = StopReport(state=WorkflowState.REQUIRED_VERIFICATION_UNEXECUTABLE,
                                        task_id=task_id,
                                        reason="REQUIRED_VERIFICATION_UNEXECUTABLE: required bounded verification has no existing permitted equivalent",
                                        evidence={"run_id": self.current_run_id, "plan_path": str(verification.plan_path),
                                                  "unexecutable_checks": denied,
                                                  "permission_policy": verification_plan["permission_policy"]})
                    self.write_stop_report(report)
                    return state, report

                def observe_verification(event):
                    try:
                        verification.observe(event, self.current_run_id)
                    except (OSError, ValueError, TypeError, KeyError) as exc:
                        verification.gaps.append(f"Verification capture unavailable: {type(exc).__name__}")
                        verification.data["diagnostics"].append({"kind": "VERIFICATION_CAPTURE_UNAVAILABLE",
                                                                  "run_id": self.current_run_id,
                                                                  "error_type": type(exc).__name__})
                        try:
                            verification.save()
                        except OSError:
                            pass

                prompt = self.antigravity_adapter.build_prompt(
                    Role.IMPLEMENTATION,
                    task_id,
                    is_fix=is_fix,
                    task=task,
                    git_state=state.git_state,
                    canonical_paths=canonical_paths,
                    dirty_files=dirty_files,
                    verification_plan=verification_plan,
                    run_id=self.current_run_id,
                )

                hard_timeout = self.config.get_agent_hard_timeout(task.risk if task else None)
                if CommandPermissions().metadata() != verification_plan["permission_policy"]:
                    report = StopReport(state=WorkflowState.REQUIRED_VERIFICATION_UNEXECUTABLE,
                                        task_id=task_id,
                                        reason="REQUIRED_VERIFICATION_UNEXECUTABLE: provider policy changed after plan freeze",
                                        evidence={"run_id": self.current_run_id, "plan_path": str(verification.plan_path)})
                    self.write_stop_report(report)
                    return state, report

                def invoke_implementation(run_id):
                    result = self.antigravity_adapter.invoke(
                        Role.IMPLEMENTATION, task_id,
                        prompt=prompt + (
                            f"\nIf the existing report needs no content edits, validate all required current-content checks/evidence and emit this exact final-output line ONLY when report completion is verified: {self.report_validation_marker}\n"
                            "Do not emit it on a timeout, permission stop, missing verification, or remaining blocker. For FIX_REQUIRED, the Senior authority/no-op remediation guard takes precedence: validation requires observable correction/evidence addressing the latest remaining blockers, not generic passing checks. Preserve partial work.\n"
                            if self.report_validation_marker else ""
                        ),
                        profile=selected_profile, hard_timeout=hard_timeout,
                        idle_timeout=self.config.agent_idle_timeout_seconds, run_id=run_id,
                        verification_observer=observe_verification,
                        action=action,
                    )
                    result.stream_summary.update(verification_plan_path=str(verification.plan_path),
                                                 verification_attempts=verification.attempts)
                    return result

                return self._execute_agent_step(
                    state=state,
                    role=Role.IMPLEMENTATION,
                    action=action,
                    invoke_fn=invoke_implementation,
                )

            # D. Senior Review / Verification / Closeout Invocation (Codex)
            if state.state in {
                WorkflowState.IMPLEMENTED_AWAITING_REVIEW,
                WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION,
                WorkflowState.APPROVED_AWAITING_CLOSEOUT,
            }:
                action_type = "CLOSEOUT" if state.state == WorkflowState.APPROVED_AWAITING_CLOSEOUT else ("TARGETED_VERIFICATION" if state.state == WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION else "REVIEW")
                action = ACTION_CLOSEOUT if state.state == WorkflowState.APPROVED_AWAITING_CLOSEOUT else (ACTION_TARGETED_VERIFICATION if state.state == WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION else ACTION_REVIEW)

                def invoke_senior(run_id):
                    options = {}
                    if action == ACTION_TARGETED_VERIFICATION:
                        verification = VerificationEvidence(self.config, task_id)
                        plan = verification.plan()
                        verification.freeze(run_id, plan, provider="codex")
                        options["verification_plan"] = plan
                    return self.codex_adapter.invoke(Role.SENIOR, task_id, action_type=action_type,
                                                     task=task, profile=selected_profile, run_id=run_id, **options)

                return self._execute_agent_step(
                    state=state,
                    role=Role.SENIOR,
                    action=action,
                    invoke_fn=invoke_senior,
                )

            if state.assigned_role in {Role.SENIOR, Role.PLANNER, Role.IMPLEMENTATION}:
                report = StopReport(state=WorkflowState.AGENT_EXECUTION_NOT_OBSERVED, task_id=task_id,
                                    reason="AGENT_EXECUTION_NOT_OBSERVED: selected agent has no invocation route")
                self.write_stop_report(report)
                return state, report
            return state, None

    def _execute_targeted_verification(self, state, lock):
        from tools.ks_supervisor.targeted import canonical_argv, run_check
        task_id = state.active_task_id
        report_path = find_report_file(self.config.reports_dir, task_id)
        evidence = VerificationEvidence(self.config, task_id)
        plan = evidence.plan()
        self.last_action = ACTION_TARGETED_VERIFICATION

        def stop(kind, reason, records=None):
            report = StopReport(state=kind, task_id=task_id, reason=reason,
                                evidence={"run_id": self.current_run_id, "checks": records or [],
                                          "required_verification": evidence.plan()["required_verification"]},
                                recommended_next_action="Resolve the reported check or permission failure, then resume the bounded transition",
                                resume_command="python -m tools.ks_supervisor run --once --live")
            self.write_stop_report(report)
            return derive_workflow_state(self.config), report

        completion = pending_completion(self.config, task_id, report_path)
        if not completion or not report_completion_valid(self.config, task_id, report_path, pending=True):
            return stop(WorkflowState.TARGETED_VERIFICATION_REQUIRED, "Pending implementation provenance changed; no command executed")
        required = plan["required_verification"]
        try:
            if completion.get("legacy_invalidation_recovery"):
                original_path = self.config.runtime_dir / "completion_attestations" / f"{task_id}-{completion['run_id']}-legacy.json"
                if not original_path.exists():
                    with original_path.open("x", encoding="utf-8") as stream:
                        stream.write((self.config.runtime_dir / "completion_attestations" / f"{task_id}.json").read_text(encoding="utf-8"))
                write_completion(self.config, completion)
            if not self.config.enable_live_agents:
                return stop(WorkflowState.USER_DECISION_REQUIRED, "Deterministic verification requires the existing --live execution gate")
            if len(required) > 4 or plan["permission_policy"]["error"] or any(not i["authorized"] for i in required):
                return stop(WorkflowState.REQUIRED_VERIFICATION_UNEXECUTABLE, "Required bounded verification exceeds limits or existing permission policy")
            current_ids = {i["check_id"] for i in plan["required_verification"] + plan["reusable_verification"]}
            if not completion.get("verification_expected_checks") or set(completion["verification_expected_checks"]) != current_ids:
                return stop(WorkflowState.REQUIRED_VERIFICATION_UNEXECUTABLE, "Content-bound ledger lost expected checks; missing evidence cannot count as PASS")
            for item in required:
                canonical_argv(item["command"])
            evidence.freeze(self.current_run_id, plan, provider="supervisor")
            records = []
            deadline = time.monotonic() + min(600, self.config.agent_hard_timeout_default_seconds)
            for item in required:
                permissions = CommandPermissions()
                if (permissions.metadata() != plan["permission_policy"] or not permissions.authorized(item["command"])[0]):
                    return stop(WorkflowState.REQUIRED_VERIFICATION_UNEXECUTABLE, "Verification permission policy changed before execution", records)
                if (not report_completion_valid(self.config, task_id, report_path, pending=True)
                        or derive_workflow_state(self.config).assigned_role != Role.SUPERVISOR):
                    return stop(WorkflowState.TARGETED_VERIFICATION_REQUIRED, "Implementation or Senior authority changed before execution", records)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return stop(WorkflowState.TARGETED_VERIFICATION_REQUIRED, "Bounded verification time budget exhausted", records)
                record = run_check(self.config, evidence, item, self.current_run_id, remaining,
                                   lambda: lock.update_heartbeat(task_id=task_id, role=Role.SUPERVISOR.value))
                records.append(record)
                if record["outcome"] == "FAIL":
                    completion.update(status="VERIFICATION_FAILED", failed_verification=records,
                                      verifier_run_id=self.current_run_id)
                    write_completion(self.config, completion)
                    return stop(WorkflowState.FIX_REQUIRED, f"Targeted verification failed: {item['check_id']}: {item['command']}", records)
                if record["outcome"] != "PASS":
                    return stop(WorkflowState.TARGETED_VERIFICATION_REQUIRED, "Targeted verification unavailable; output retained", records)
            if (evidence.plan()["required_verification"]
                    or CommandPermissions().metadata() != plan["permission_policy"]
                    or not report_completion_valid(self.config, task_id, report_path, pending=True)
                    or derive_workflow_state(self.config).assigned_role != Role.SUPERVISOR):
                return stop(WorkflowState.TARGETED_VERIFICATION_REQUIRED, "Current-content verification or completion provenance changed", records)
            summary = {"run_id": self.current_run_id, "task_id": task_id,
                       "action": ACTION_TARGETED_VERIFICATION, "agent_calls": 0, "success": True,
                       "workflow_state_after": WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION.value, "checks": records}
            path = self.config.runtime_dir / "targeted_verification" / f"{self.current_run_id}.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
            completion.update(status="VERIFIED", verifier_run_id=self.current_run_id, targeted_verification=records)
            write_completion(self.config, completion)
            if not report_completion_valid(self.config, task_id, report_path):
                completion.update(status="UNCOMMITTED", success=False)
                write_completion(self.config, completion)
                return stop(WorkflowState.TARGETED_VERIFICATION_REQUIRED, "Completion changed during attestation publication", records)
            post_state = derive_workflow_state(self.config)
            self.current_verification_record = summary
            return post_state, None
        except (OSError, ValueError) as exc:
            return stop(WorkflowState.REQUIRED_VERIFICATION_UNEXECUTABLE,
                        f"Deterministic verification unavailable: {type(exc).__name__}")

    def has_current_verification_record(self):
        record = getattr(self, "current_verification_record", None)
        if not record or record.get("run_id") != self.current_run_id or not record.get("success"):
            return False
        try:
            path = self.config.runtime_dir / "targeted_verification" / f"{self.current_run_id}.json"
            stored = json.loads(path.read_text(encoding="utf-8"))
            report = find_report_file(self.config.reports_dir, record["task_id"])
            return (stored == record and stored["agent_calls"] == 0
                    and report_completion_valid(self.config, record["task_id"], report))
        except (OSError, ValueError, KeyError, TypeError):
            return False
