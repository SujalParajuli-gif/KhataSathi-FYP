"""KhataSathi Workflow Supervisor - Configuration and Safety Limits."""
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional


@dataclass
class SupervisorConfig:
    """Configuration for workflow supervisor runtime."""
    # Repository root
    repo_root: Path = field(default_factory=lambda: Path(os.getcwd()).resolve())

    # Workflow paths (relative to repo_root)
    checkpoint_rel_path: str = "docs/engineering/IMPLEMENTATION_CHECKPOINT.md"
    task_registry_rel_path: str = "docs/engineering/ai/TASK_REGISTRY.md"
    master_plan_rel_path: str = "docs/engineering/KHATASATHI_MASTER_IMPLEMENTATION_PLAN_v1.2.md"
    tasks_dir_rel_path: str = "docs/engineering/ai/tasks"
    plans_dir_rel_path: str = "docs/engineering/ai/plans"
    reports_dir_rel_path: str = "docs/engineering/ai/reports"
    reviews_dir_rel_path: str = "docs/engineering/ai/reviews"
    backlog_rel_path: str = "docs/engineering/ai/BACKLOG.md"
    project_progress_rel_path: str = "docs/engineering/PROJECT_PROGRESS.md"
    hygiene_script_rel_path: str = ".agents/skills/repository-commit-hygiene/scripts/check_hygiene.py"

    # Ephemeral runtime directory inside .git (untracked)
    runtime_dir_rel_path: str = ".git/ks-runtime"

    # Feature Gates (Fail-safe MVP Defaults)
    enable_live_agents: bool = False       # Live AI subprocesses gated behind explicit flag
    enable_auto_commit: bool = False       # Auto-commit gated behind explicit flag
    allow_continuous: bool = False         # Autonomous multi-task loops disabled in MVP
    allow_ide_fallback: bool = False       # Experimental Antigravity IDE GUI fallback disabled

    # Retry limits & safety budgets (MVP defaults)
    max_planner_attempts_per_task: int = 1
    max_impl_attempts_per_task: int = 1
    max_fix_cycles_per_task: int = 2
    max_same_failure_signature: int = 2
    max_agent_crash_retries: int = 1
    max_tasks_per_run: int = 3

    # Timeouts in seconds
    agent_timeout_seconds: int = 600
    agent_idle_timeout_seconds: int = 180
    agent_hard_timeout_high_risk_seconds: int = 900
    agent_hard_timeout_default_seconds: int = 600
    doctor_timeout_seconds: int = 30
    antigravity_model_discovery_timeout_seconds: int = 60  # `agy models` inventory probe only
    antigravity_windows_command_line_limit_chars: int = 28000  # UTF-16 units including NUL; below CreateProcessW's limit
    lock_stale_timeout_seconds: int = 1800  # 30 minutes without heartbeat

    def get_agent_hard_timeout(self, risk: Optional[str] = None) -> int:
        """Return bounded hard execution timeout based on task risk tier."""
        if risk and str(risk).upper() == "HIGH":
            return self.agent_hard_timeout_high_risk_seconds
        return self.agent_hard_timeout_default_seconds

    # CLI Executables
    codex_bin: Optional[str] = field(default_factory=lambda: os.environ.get("CODEX_BIN", "codex"))
    antigravity_bin: Optional[str] = field(default_factory=lambda: os.environ.get("AGY_BIN", "agy"))

    # Environment scrubbing: forbidden substrings in child agent environments
    sensitive_env_prefixes: List[str] = field(default_factory=lambda: [
        "AWS_", "VPS_", "SSH_", "DEPLOY_", "PROD_", "PRODUCTION_",
        "RESTIC_", "BACKUP_SECRET", "CLOUDFLARE_", "DIGITALOCEAN_"
    ])

    @property
    def checkpoint_path(self) -> Path:
        return self.repo_root / self.checkpoint_rel_path

    @property
    def task_registry_path(self) -> Path:
        return self.repo_root / self.task_registry_rel_path

    @property
    def master_plan_path(self) -> Path:
        return self.repo_root / self.master_plan_rel_path

    @property
    def tasks_dir(self) -> Path:
        return self.repo_root / self.tasks_dir_rel_path

    @property
    def plans_dir(self) -> Path:
        return self.repo_root / self.plans_dir_rel_path

    @property
    def reports_dir(self) -> Path:
        return self.repo_root / self.reports_dir_rel_path

    @property
    def reviews_dir(self) -> Path:
        return self.repo_root / self.reviews_dir_rel_path

    @property
    def runtime_dir(self) -> Path:
        # If .git is a file (e.g. in a worktree), resolve the actual gitdir
        git_entry = self.repo_root / ".git"
        if git_entry.is_file():
            try:
                text = git_entry.read_text(encoding="utf-8").strip()
                if text.startswith("gitdir:"):
                    target = text[len("gitdir:"):].strip()
                    target_path = Path(target)
                    if not target_path.is_absolute():
                        target_path = (self.repo_root / target_path).resolve()
                    return target_path / "ks-runtime"
            except Exception:
                pass
        return self.repo_root / self.runtime_dir_rel_path

    @property
    def hygiene_script_path(self) -> Path:
        return self.repo_root / self.hygiene_script_rel_path
