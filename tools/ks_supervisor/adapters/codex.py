"""KhataSathi Workflow Supervisor - Codex CLI Subprocess Adapter."""
from datetime import datetime, timezone
import json
import hashlib
from pathlib import Path
import subprocess
import time
from uuid import uuid4
from typing import Any, Dict, List, Optional

from tools.ks_supervisor.adapters.base import BaseAgentAdapter, sanitize_environment
from tools.ks_supervisor.config import SupervisorConfig
from tools.ks_supervisor.types import AgentResult, ExecutionMode, Role, TaskContract
from tools.ks_supervisor.verification import VerificationEvidence, senior_verification_prompt


def determine_codex_sandbox(
    role: Role,
    action_type: str = "",
    execution_mode: Optional[ExecutionMode] = None,
    is_read_only: bool = False,
) -> str:
    """Determine the precise Codex sandbox policy (`read-only` vs `workspace-write`).

    Rules:
    - Pure read-only inspection / router check / READ_ONLY_DIRECT -> read-only
    - SENIOR_AUTOPILOT (LOW-risk direct senior implementation/tests/closeout) -> workspace-write
    - PLANNER (authoring implementation plan artifact) -> workspace-write
    - Senior review producing/updating review artifact -> workspace-write
    - Senior closeout updating task/checkpoint/registry -> workspace-write
    - Pure read-only review check with zero writes -> read-only
    """
    if is_read_only or execution_mode == ExecutionMode.READ_ONLY_DIRECT:
        return "read-only"
    
    if action_type.upper() in {"ROUTER_INSPECTION", "READ_ONLY_REVIEW", "STATUS_INSPECTION"}:
        return "read-only"

    # Actions requiring repository/workflow writes
    if execution_mode == ExecutionMode.SENIOR_AUTOPILOT:
        return "workspace-write"
        
    if role == Role.PLANNER:
        return "workspace-write"

    if role == Role.SENIOR:
        # Senior reviews, task creation, blocker verification, and closeouts write workflow files
        return "workspace-write"

    return "read-only"


class CodexAdapter(BaseAgentAdapter):
    """Adapter for interacting with Codex CLI (`codex exec`) across workflow roles."""

    def __init__(self, config: SupervisorConfig):
        super().__init__(config)
        self.bin_name = self.config.codex_bin or "codex"

    def check_availability(self) -> Dict[str, Any]:
        """Verify if codex CLI is available and query its version and sandbox modes."""
        try:
            res = subprocess.run(
                [self.bin_name, "--version"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.config.doctor_timeout_seconds,
            )
            if res.returncode == 0:
                version_str = res.stdout.strip() or res.stderr.strip()
                return {
                    "available": True,
                    "status": "READY",
                    "version": version_str,
                    "binary": self.bin_name,
                    "supported_sandboxes": ["read-only", "workspace-write"],
                }
            return {
                "available": False,
                "status": "NOT_READY",
                "error": f"Exit code {res.returncode}: {res.stderr.strip()}",
                "binary": self.bin_name,
            }
        except FileNotFoundError:
            return {
                "available": False,
                "status": "NOT_READY",
                "error": f"Binary '{self.bin_name}' not found on PATH",
                "binary": self.bin_name,
            }
        except Exception as e:
            return {"available": False, "status": "NOT_READY", "error": str(e), "binary": self.bin_name}

    def build_prompt(
        self,
        role: Role,
        task_id: str,
        action_type: str = "",
        task: Optional[TaskContract] = None,
        context: Optional[str] = None,
        verification_plan: Optional[dict] = None,
        run_id: str = "",
        evidence_location: str = "",
    ) -> str:
        """Construct deterministic role instructions for Codex based on active action."""
        if task and task.execution_mode == ExecutionMode.SENIOR_AUTOPILOT and action_type not in {"REVIEW", "TARGETED_VERIFICATION"}:
            return (
                f"You are operating as the KhataSathi Senior Autopilot for bounded LOW-risk task {task_id}.\n"
                f"Follow /AGENTS.md Section 8 & 20 and the active task contract at docs/engineering/ai/tasks/{task_id}*.md.\n"
                f"Instructions:\n"
                f"1. Implement the minimal robust change satisfying the task acceptance criteria.\n"
                f"2. Run all required tests and checks.\n"
                f"3. Write the implementation report at docs/engineering/ai/reports/{task_id}-implementation.md.\n"
                f"4. Conduct self-review and, if clean, perform closeout updates as authorized by AGENTS.md.\n"
                f"5. Halt immediately on PLAN/REPO DRIFT, missing requirements, or hygiene issues."
            )
        elif role == Role.PLANNER:
            return (
                f"You are operating as the KhataSathi Senior Implementation Planner for task {task_id}.\n"
                f"Follow /AGENTS.md, the khatasathi-implementation-planner skill, and the active task contract under docs/engineering/ai/tasks/.\n"
                f"Your goal: produce an execution-ready implementation plan at docs/engineering/ai/plans/{task_id}-plan.md.\n"
                f"Do not implement code; only produce the bounded implementation plan artifact."
            )
        elif role == Role.SENIOR:
            if action_type == "TASK_DEFINITION":
                return (
                    "Use the khatasathi-workflow-router NO_ACTIVE_TASK path under AGENTS.md.\n"
                    "Re-read checkpoint NEXT_SAFE_ACTION, task registry, backlog and relevant frozen roadmap.\n"
                    "Scope only the next authorized complete deliverable; create its bounded contract, "
                    "register it READY and update checkpoint and progress dashboard.\n"
                    "Preserve all ACCEPTED task statuses and history. Do not implement application code, "
                    "reopen accepted work, commit, push, merge, deploy or execute migrations.\n"
                    "If no safe task is determinable, report NEXT_TASK_UNRESOLVED with the specific missing authority."
                )
            if action_type == "TARGETED_VERIFICATION":
                return (
                    f"You are operating as the KhataSathi Senior Reviewer for targeted verification of task {task_id}.\n"
                    f"Follow /AGENTS.md Section 12 (After blocker fixes).\n"
                    f"Verify ONLY previously listed blockers and direct regressions. Do NOT restart full review.\n"
                    f"Update review file at docs/engineering/ai/reviews/{task_id}-review.md.\n"
                    f"If all blockers are resolved with zero remaining blockers, record decision as APPROVED and return ACCEPTED.\n"
                    f"Stop after review. Do not plan, implement, closeout, commit, or begin another task."
                    + senior_verification_prompt(verification_plan, run_id, evidence_location)
                )
            elif action_type == "CLOSEOUT":
                return (
                    f"You are operating as the KhataSathi Senior Engineer performing closeout for APPROVED task {task_id}.\n"
                    f"Follow /AGENTS.md Section 13.\n"
                    f"1. Mark the task ACCEPTED in task contract docs/engineering/ai/tasks/{task_id}*.md.\n"
                    f"2. Update docs/engineering/ai/TASK_REGISTRY.md.\n"
                    f"3. Update docs/engineering/IMPLEMENTATION_CHECKPOINT.md.\n"
                    f"4. Record any non-blocking or out-of-scope findings in docs/engineering/ai/BACKLOG.md."
                )
            else:
                return (
                    f"You are operating as the KhataSathi Senior Reviewer for task {task_id}.\n"
                    f"Follow /AGENTS.md Section 12 Senior Review.\n"
                    f"1. Read task contract, implementation plan, implementation report, diff, and run required tests.\n"
                    f"2. Write review file at docs/engineering/ai/reviews/{task_id}-review.md.\n"
                    f"3. Classify all findings strictly into BLOCKER (B-1, etc.), NON-BLOCKING, OUT OF SCOPE, or QUESTION.\n"
                    f"4. Record canonical decision APPROVED with zero blockers and return ACCEPTED, otherwise FIX_REQUIRED.\n"
                    f"Stop after review. Do not plan, implement, closeout, commit, or begin another task."
                )
        else:
            return context or f"Execute KhataSathi senior action for task {task_id} according to /AGENTS.md."

    def invoke(
        self,
        role: Role,
        task_id: str,
        prompt: Optional[str] = None,
        action_type: str = "",
        task: Optional[TaskContract] = None,
        is_read_only: bool = False,
        profile: Optional[Any] = None,
        run_id: str = "",
        verification_plan: Optional[dict] = None,
    ) -> AgentResult:
        """Invoke `codex exec` non-interactively with exact action-determined sandbox mode and explicit model profile."""
        start_time = time.time()
        run_id = run_id or uuid4().hex
        started_at = datetime.now(timezone.utc).isoformat()
        evidence_location = ""
        if role == Role.SENIOR and action_type == "TARGETED_VERIFICATION":
            if verification_plan is None:
                verification = VerificationEvidence(self.config, task_id)
                verification_plan = verification.plan()
                verification.freeze(run_id, verification_plan, provider="codex")
            evidence_location = str(self.config.runtime_dir / "verification_plans" / f"{run_id}.json")
        final_prompt = prompt or self.build_prompt(role, task_id, action_type=action_type, task=task,
                                                 verification_plan=verification_plan, run_id=run_id,
                                                 evidence_location=evidence_location)
        if prompt and role == Role.SENIOR and action_type == "TARGETED_VERIFICATION":
            final_prompt += senior_verification_prompt(verification_plan, run_id, evidence_location)
        if action_type == "TARGETED_VERIFICATION":
            report = self.config.reports_dir / f"{task_id}-implementation.md"
            correction = hashlib.sha256(report.read_bytes()).hexdigest() if report.exists() else ""
            final_prompt += (
                "\nUpdate the canonical review with a final section in exactly this format:\n"
                "## Current targeted verification\n"
                f"Run ID: {run_id}\nCorrection report SHA256: {correction}\n"
                "Decision: APPROVED or FIX REQUIRED (choose one)\n"
                "Remaining blockers: 0 for approval, otherwise list remaining B-N IDs\n"
                "Evidence: Describe targeted checks, correction content/revision, results and limits.\n"
                "Record APPROVED only with zero blocking findings. If blockers remain, record FIX REQUIRED. "
                "This invocation must update the review and stop before closeout or commit. "
                "Do not use the implementation report as Senior authority."
            )
        
        # Prepare output artifact path for the last message
        output_dir = self.config.runtime_dir / "codex_runs"
        output_dir.mkdir(parents=True, exist_ok=True)
        last_msg_file = output_dir / f"{task_id}_{role.value}_{run_id}_last.txt"

        def read_final_message() -> str:
            try:
                return last_msg_file.read_text(encoding="utf-8", errors="replace") if last_msg_file.exists() else ""
            except OSError:
                return ""
        
        # Determine sandbox mode from the actual workflow action
        exec_mode = task.execution_mode if task else None
        sandbox_mode = determine_codex_sandbox(
            role=role,
            action_type=action_type,
            execution_mode=exec_mode,
            is_read_only=is_read_only,
        )

        cmd = [
            self.bin_name,
            "exec",
            "-C",
            str(self.config.repo_root),
            "-s",
            sandbox_mode,
            "--ephemeral",
            "--color",
            "never",
            "-o",
            str(last_msg_file),
        ]

        # Apply explicit model profile options
        model_name = profile.model if profile else "gpt-6.1-sol"
        effort_val = profile.effort if profile else "medium"
        
        cmd.extend(["-m", model_name])
        cmd.extend(["-c", f'model_reasoning_effort="{effort_val}"'])

        cmd.append(final_prompt)

        env = sanitize_environment(self.config)
        token_usage: Dict[str, Any] = {}

        try:
            res = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
                timeout=self.config.agent_timeout_seconds,
            )
            duration = time.time() - start_time
            process_completed = True
            provider_reported_success = res.returncode == 0
            
            # Read last message if written
            stdout = res.stdout
            last_msg_content = read_final_message()
            if last_msg_content:
                stdout += f"\n--- Last Agent Output ---\n{last_msg_content}"

            return AgentResult(
                role=role,
                run_id=run_id,
                started_at=started_at,
                final_message_path=str(last_msg_file),
                task_id=task_id,
                exit_code=res.returncode,
                stdout=stdout,
                final_message=last_msg_content,
                stderr=res.stderr,
                duration_seconds=duration,
                success=provider_reported_success,
                process_completed=process_completed,
                provider_reported_success=provider_reported_success,
                error_message=None if provider_reported_success else f"Codex exec exited with code {res.returncode}: {res.stderr[:200]}",
                provider="codex",
                model_name=model_name,
                effort=effort_val,
                token_usage=token_usage,
                cmd_argv=cmd,
            )
        except subprocess.TimeoutExpired as exc:
            duration = time.time() - start_time
            return AgentResult(
                role=role,
                run_id=run_id,
                started_at=started_at,
                final_message_path=str(last_msg_file),
                task_id=task_id,
                exit_code=124,
                final_message=read_final_message(),
                stdout=(exc.stdout or b"").decode("utf-8", "replace") if isinstance(exc.stdout, bytes) else (exc.stdout or ""),
                stderr=(exc.stderr or b"").decode("utf-8", "replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "Codex execution timed out"),
                timed_out=True,
                timeout_kind="hard_limit",
                duration_seconds=duration,
                success=False,
                process_completed=False,
                provider_reported_success=False,
                error_message=f"Codex timed out after {self.config.agent_timeout_seconds}s",
                provider="codex",
                model_name=model_name,
                effort=effort_val,
                cmd_argv=cmd,
            )
        except Exception as e:
            duration = time.time() - start_time
            return AgentResult(
                role=role,
                run_id=run_id,
                started_at=started_at,
                final_message_path=str(last_msg_file),
                task_id=task_id,
                exit_code=1,
                stdout="",
                final_message=read_final_message(),
                stderr=str(e),
                duration_seconds=duration,
                success=False,
                process_completed=False,
                provider_reported_success=False,
                error_message=str(e),
                provider="codex",
                model_name=model_name,
                effort=effort_val,
                cmd_argv=cmd,
            )
