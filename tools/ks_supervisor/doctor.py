"""KhataSathi Workflow Supervisor - Diagnostic & Health Check Tooling."""
from dataclasses import dataclass, field
import os
from pathlib import Path
import platform
import shutil
import sys
from typing import Any, Dict, List, Tuple

from tools.ks_supervisor.adapters.antigravity import AntigravityAdapter
from tools.ks_supervisor.adapters.codex import CodexAdapter
from tools.ks_supervisor.config import SupervisorConfig
from tools.ks_supervisor.lock import SupervisorLock
from tools.ks_supervisor.repo import get_git_state, parse_checkpoint, run_git


@dataclass
class CheckResult:
    """Result of an individual doctor check."""
    name: str
    status: str  # PASS, WARN, FAIL
    message: str
    details: Dict[str, Any] = field(default_factory=dict)


def run_doctor(config: SupervisorConfig) -> Tuple[bool, List[CheckResult]]:
    """Perform deterministic system, repository, and environment diagnostic checks."""
    results: List[CheckResult] = []
    overall_pass = True

    # 1. Python Environment Check
    py_ver = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    if sys.version_info >= (3, 10):
        results.append(CheckResult(
            name="Python Environment",
            status="PASS",
            message=f"Python {py_ver} on {platform.system()} ({platform.machine()})",
            details={"version": py_ver, "os": platform.system()},
        ))
    else:
        results.append(CheckResult(
            name="Python Environment",
            status="FAIL",
            message=f"Python {py_ver} is unsupported; Python 3.10+ is required",
            details={"version": py_ver},
        ))
        overall_pass = False

    # 2. Git Repository & Branch Check
    code, git_top, _ = run_git(config.repo_root, "rev-parse", "--show-toplevel")
    if code == 0 and git_top:
        git_state = get_git_state(config.repo_root)
        branch_status = "PASS"
        msg = f"Repository root: {git_top} (branch: '{git_state.branch}', HEAD: {git_state.head_sha[:8]})"
        
        # Check if accidentally on protected/stable branch
        if git_state.branch in {"UI/UX-fixes-after-production", "main", "master"}:
            branch_status = "WARN"
            msg += f" - CAUTION: Currently on protected branch '{git_state.branch}'"
            
        results.append(CheckResult(
            name="Git Repository",
            status=branch_status,
            message=msg,
            details={
                "root": git_top,
                "branch": git_state.branch,
                "head": git_state.head_sha,
                "is_clean": git_state.is_clean,
                "modified_count": len(git_state.modified_files),
                "staged_count": len(git_state.staged_files),
            },
        ))
    else:
        results.append(CheckResult(
            name="Git Repository",
            status="FAIL",
            message=f"Directory '{config.repo_root}' is not a valid Git repository",
        ))
        overall_pass = False

    # 3. Required Workflow Files
    required_files = [
        ("AGENTS.md", config.repo_root / "AGENTS.md"),
        ("GEMINI.md", config.repo_root / "GEMINI.md"),
        ("IMPLEMENTATION_CHECKPOINT.md", config.checkpoint_path),
        ("TASK_REGISTRY.md", config.task_registry_path),
        ("Master Plan v1.2", config.master_plan_path),
        ("Commit Hygiene Script", config.hygiene_script_path),
        ("Workflow Router Skill", config.repo_root / ".agents/skills/khatasathi-workflow-router/SKILL.md"),
    ]

    missing_files = []
    for label, path in required_files:
        if not path.exists():
            missing_files.append(label)

    if not missing_files:
        results.append(CheckResult(
            name="Workflow Files",
            status="PASS",
            message=f"All {len(required_files)} canonical workflow files are present",
        ))
    else:
        results.append(CheckResult(
            name="Workflow Files",
            status="FAIL",
            message=f"Missing required workflow files: {', '.join(missing_files)}",
            details={"missing": missing_files},
        ))
        overall_pass = False

    # 4. Checkpoint & Workflow v2 Validation
    checkpoint = parse_checkpoint(config.checkpoint_path)
    if checkpoint.workflow_version_effective:
        if checkpoint.is_v2_active:
            results.append(CheckResult(
                name="Workflow Version",
                status="PASS",
                message=f"Workflow v2 active ('{checkpoint.workflow_version_effective}')",
                details={
                    "current_task": checkpoint.current_task,
                    "task_status": checkpoint.current_task_status,
                    "phase": checkpoint.current_phase,
                },
            ))
        else:
            results.append(CheckResult(
                name="Workflow Version",
                status="WARN",
                message=f"Workflow v2 is not active: '{checkpoint.workflow_version_effective}'",
                details={"version": checkpoint.workflow_version_effective},
            ))
    else:
        results.append(CheckResult(
            name="Workflow Version",
            status="FAIL",
            message="Unable to read WORKFLOW_VERSION_EFFECTIVE from checkpoint",
        ))
        overall_pass = False

    # 5. Codex CLI Adapter Availability (Senior & Planner)
    codex_adapter = CodexAdapter(config)
    codex_info = codex_adapter.check_availability()
    if codex_info["available"]:
        results.append(CheckResult(
            name="Codex CLI (Senior/Planner)",
            status="PASS",
            message=f"Available: {codex_info.get('version', 'OK')} ({codex_info.get('binary')}) [sandboxes: read-only, workspace-write]",
            details=codex_info,
        ))
    else:
        results.append(CheckResult(
            name="Codex CLI (Senior/Planner)",
            status="WARN",
            message=f"Unavailable: {codex_info.get('error')} ({codex_info.get('binary')})",
            details=codex_info,
        ))

    # 6. Antigravity Headless CLI Adapter (Implementation)
    antigravity_adapter = AntigravityAdapter(config)
    antigravity_info = antigravity_adapter.check_availability()
    if antigravity_info["available"]:
        models_ok, models_list, models_err = antigravity_adapter.get_available_models()
        if models_ok:
            antigravity_info["available_models"] = models_list
            results.append(CheckResult(
                name="Antigravity Headless CLI (agy)",
                status="PASS",
                message=f"Available: {antigravity_info.get('version', 'OK')} ({antigravity_info.get('binary')}) [{len(models_list)} models verified via `agy models`]",
                details=antigravity_info,
            ))
        else:
            antigravity_info["models_error"] = models_err
            results.append(CheckResult(
                name="Antigravity Headless CLI (agy)",
                status="WARN",
                message=f"Available ({antigravity_info.get('binary')}), but `agy models` query failed: {models_err}",
                details=antigravity_info,
            ))
    else:
        # Explicit NOT READY diagnostic for implementation live path
        results.append(CheckResult(
            name="Antigravity Headless CLI (agy)",
            status="WARN",
            message=f"IMPLEMENTATION AGENT LIVE PATH: NOT READY - {antigravity_info.get('error')}",
            details=antigravity_info,
        ))

    # 7. Exclusive Supervisor Lock Capability
    try:
        lock = SupervisorLock(config, task_id="DOCTOR_TEST", role="DOCTOR")
        if lock.acquire():
            lock.update_heartbeat()
            lock.release()
            results.append(CheckResult(
                name="Runtime Lock Subsystem",
                status="PASS",
                message=f"OS file lock test succeeded at {config.runtime_dir}",
                details={"runtime_dir": str(config.runtime_dir)},
            ))
        else:
            results.append(CheckResult(
                name="Runtime Lock Subsystem",
                status="FAIL",
                message="Failed to acquire test lock (may be held by another process)",
            ))
            overall_pass = False
    except Exception as e:
        results.append(CheckResult(
            name="Runtime Lock Subsystem",
            status="FAIL",
            message=f"Lock subsystem exception: {e}",
        ))
        overall_pass = False

    # 8. Feature Gates Status Summary
    gate_summary = (
        f"Live AI: {'ENABLED' if config.enable_live_agents else 'GATED (disabled)'} | "
        f"Auto-Commit: {'ENABLED' if config.enable_auto_commit else 'GATED (disabled)'} | "
        f"Continuous: {'ENABLED' if config.allow_continuous else 'GATED (disabled)'}"
    )
    results.append(CheckResult(
        name="Safety Feature Gates",
        status="PASS",
        message=gate_summary,
        details={
            "enable_live_agents": config.enable_live_agents,
            "enable_auto_commit": config.enable_auto_commit,
            "allow_continuous": config.allow_continuous,
        },
    ))

    return overall_pass, results
