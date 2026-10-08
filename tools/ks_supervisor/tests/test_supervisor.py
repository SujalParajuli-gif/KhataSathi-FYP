"""KhataSathi Workflow Supervisor - Comprehensive Deterministic Test Suite."""
import json
from datetime import datetime, timezone
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from tools.ks_supervisor.adapters.antigravity import AntigravityAdapter
from tools.ks_supervisor.adapters.base import sanitize_environment
from tools.ks_supervisor.adapters.codex import CodexAdapter, determine_codex_sandbox
from tools.ks_supervisor.config import SupervisorConfig
from tools.ks_supervisor.doctor import run_doctor
from tools.ks_supervisor.lock import SupervisorLock, is_pid_alive
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
from tools.ks_supervisor.runner import (
    ACTION_FIX,
    ACTION_IMPLEMENTATION,
    ACTION_PLANNING,
    ACTION_REVIEW,
    NO_OBSERVABLE_AGENT_EFFECT,
    POSTCONDITION_VIOLATION,
    SupervisorRunner,
    evaluate_postconditions,
)
from tools.ks_supervisor.state import derive_workflow_state
from tools.ks_supervisor.types import (
    AgentResult,
    CheckpointData,
    ExecutionMode,
    GitState,
    RepositoryBaseline,
    RepositoryDelta,
    Role,
    TaskContract,
    WorkflowState,
)


class BaseSupervisorTestCase(unittest.TestCase):
    """Base test case setting up an isolated fixture repository."""

    def setUp(self):
        original_popen = subprocess.Popen

        def bounded_test_subprocess(argv, *args, **kwargs):
            if isinstance(argv, (list, tuple)) and argv:
                binary = Path(str(argv[0])).stem.lower()
                if ((binary.startswith("codex") and "exec" in argv)
                        or (binary in {"agy", "antigravity", "antigravity-ide"}
                            and any(flag in argv for flag in ("-p", "--print", "chat")))):
                    raise AssertionError("Unmocked live provider execution is forbidden in supervisor tests")
            return original_popen(argv, *args, **kwargs)

        provider_guard = patch("subprocess.Popen", side_effect=bounded_test_subprocess)
        provider_guard.start()
        self.addCleanup(provider_guard.stop)
        # Runtime fixtures mock agent execution. Model validation creates a separate adapter,
        # so instance mocks cannot isolate registry probes. Dedicated model tests call the
        # real validator directly or override this runner boundary with an unavailable result.
        availability = patch("tools.ks_supervisor.runner.validate_profile_availability",
                             return_value=(True, "fixture model available"))
        availability.start()
        self.addCleanup(availability.stop)
        self.temp_dir = tempfile.mkdtemp(prefix="ks-sup-test-")
        self.repo_root = Path(self.temp_dir)
        self.config = SupervisorConfig(repo_root=self.repo_root)

        # Create standard directory layout
        self.config.tasks_dir.mkdir(parents=True, exist_ok=True)
        self.config.plans_dir.mkdir(parents=True, exist_ok=True)
        self.config.reports_dir.mkdir(parents=True, exist_ok=True)
        self.config.reviews_dir.mkdir(parents=True, exist_ok=True)
        self.config.runtime_dir.mkdir(parents=True, exist_ok=True)

        # Initialize mock git repository
        run_git(self.repo_root, "init", "-b", "feat/phase-1a-test")
        run_git(self.repo_root, "config", "user.name", "Test Agent")
        run_git(self.repo_root, "config", "user.email", "test@khatasathi.local")

        # Create canonical files
        (self.repo_root / "AGENTS.md").write_text("# KhataSathi AI Agent Entry Point\n", encoding="utf-8")
        (self.repo_root / "GEMINI.md").write_text("# KhataSathi Gemini Instructions\n", encoding="utf-8")
        (self.repo_root / "README.md").write_text("# KhataSathi Root\n", encoding="utf-8")
        (self.config.master_plan_path.parent).mkdir(parents=True, exist_ok=True)
        self.config.master_plan_path.write_text("# Master Plan v1.2 R2\n", encoding="utf-8")

        # Initial commit
        run_git(self.repo_root, "add", ".")
        run_git(self.repo_root, "commit", "-m", "Initial test commit")

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def write_checkpoint(
        self,
        workflow_version: str = "2 (Workflow v2 active)",
        current_task: str = "TASK-01-001",
        task_status: str = "READY",
        branch: str = "feat/phase-1a-test",
    ):
        content = f"""# KhataSathi Implementation Checkpoint
```yaml
WORKFLOW_VERSION_EFFECTIVE: "{workflow_version}"
MASTER_PLAN_VERSION: "1.2"
CURRENT_PHASE: "1A"
CURRENT_TASK: "{current_task}"
CURRENT_TASK_STATUS: "{task_status}"
CURRENT_WORK_BRANCH: "{branch}"
LAST_ACCEPTED_TASK: "TASK-00-001"
```
"""
        self.config.checkpoint_path.write_text(content, encoding="utf-8")

    def write_task(
        self,
        task_id: str = "TASK-01-001",
        title: str = "Test Feature Task",
        status: str = "READY",
        planning_required: str = "NO",
        execution_mode: str = "DIRECT_IMPLEMENTATION",
        branch: str = "feat/phase-1a-test",
        risk: str = "MEDIUM",
        difficulty: str = "5/10",
        delivery_outcome: str = "",
        acceptance_criteria: str = "- [ ] AC-1: Feature works.",
    ) -> Path:
        content = f"""# {task_id} — {title}

Status: {status}
Difficulty: {difficulty}
Risk: {risk}
Planning Required: {planning_required}
Execution Mode: {execution_mode}
Senior Review Required: YES
Phase: 1A
Branch / worktree: {branch}
Assigned role: Implementation agent
Delivery outcome: {delivery_outcome}

## Goal
Implement test feature.

## Acceptance criteria
{acceptance_criteria}
"""
        path = self.config.tasks_dir / f"{task_id}-test.md"
        path.write_text(content, encoding="utf-8")
        return path


class TestStateDerivationAndPrecedence(BaseSupervisorTestCase):
    """Test deterministic state derivation and reconciliation against stale labels."""

    def test_workflow_v1_boundary(self):
        self.write_checkpoint(workflow_version="1 (current old workflow)")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.state, WorkflowState.ACTIVATION_BOUNDARY_OLD_WORKFLOW)
        self.assertTrue(state.is_hard_stop)

    def test_ambiguous_workflow_version(self):
        self.write_checkpoint(workflow_version="2 or 1")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.state, WorkflowState.CANNOT_DETERMINE_WORKFLOW_STATE)
        self.assertTrue(state.is_hard_stop)

    def test_missing_workflow_version(self):
        self.write_checkpoint(workflow_version="")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.state, WorkflowState.CANNOT_DETERMINE_WORKFLOW_STATE)
        self.assertTrue(state.is_hard_stop)

    def test_no_active_task(self):
        self.write_checkpoint(current_task="")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.state, WorkflowState.NO_ACTIVE_TASK)
        self.assertEqual(state.assigned_role, Role.SENIOR)

    def test_plan_repo_drift_missing_task_file(self):
        self.write_checkpoint(current_task="TASK-MISSING-001")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.state, WorkflowState.PLAN_REPO_DRIFT)
        self.assertTrue(state.is_hard_stop)

    def test_dependency_blocked(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="BLOCKED")
        self.write_task("TASK-01-001", status="BLOCKED")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.state, WorkflowState.DEPENDENCY_BLOCKED)
        self.assertTrue(state.is_hard_stop)

    def test_user_decision_required(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="USER_DECISION_REQUIRED")
        self.write_task("TASK-01-001", status="USER_DECISION_REQUIRED")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.state, WorkflowState.USER_DECISION_REQUIRED)
        self.assertTrue(state.is_hard_stop)

    def test_ready_for_planning(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", planning_required="YES", execution_mode="PLANNED_IMPLEMENTATION", risk="HIGH")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.state, WorkflowState.READY_FOR_PLANNING)
        self.assertEqual(state.assigned_role, Role.PLANNER)

    def test_plan_ready_for_implementation(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", planning_required="YES", execution_mode="PLANNED_IMPLEMENTATION", risk="HIGH")
        (self.config.plans_dir / "TASK-01-001-plan.md").write_text("# Plan\nDetails...", encoding="utf-8")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.state, WorkflowState.PLAN_READY_FOR_IMPLEMENTATION)
        self.assertEqual(state.assigned_role, Role.IMPLEMENTATION)

    def test_direct_implementation(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", planning_required="NO", execution_mode="DIRECT_IMPLEMENTATION")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.state, WorkflowState.DIRECT_IMPLEMENTATION)
        self.assertEqual(state.assigned_role, Role.IMPLEMENTATION)

    def test_senior_autopilot_role_routing(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", planning_required="NO", execution_mode="SENIOR_AUTOPILOT", risk="LOW")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.state, WorkflowState.DIRECT_IMPLEMENTATION)
        self.assertEqual(state.assigned_role, Role.SENIOR)

    def test_stale_checkpoint_label_reconciled_by_complete_report(self):
        # Checkpoint is stale ("READY" / "IN_PROGRESS"), but complete report exists
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", status="IN_PROGRESS")
        (self.config.reports_dir / "TASK-01-001-implementation.md").write_text(
            "# Report\nStatus: COMPLETE — AWAITING SENIOR REVIEW\n", encoding="utf-8"
        )
        state = derive_workflow_state(self.config)
        # Report takes precedence over stale checkpoint READY
        self.assertEqual(state.state, WorkflowState.IMPLEMENTED_AWAITING_REVIEW)
        self.assertEqual(state.assigned_role, Role.SENIOR)

    def test_stale_checkpoint_label_reconciled_by_approved_review(self):
        # Checkpoint says IN_PROGRESS, but review is APPROVED with 0 blockers
        self.write_checkpoint(current_task="TASK-01-001", task_status="IN_PROGRESS")
        self.write_task("TASK-01-001", status="IN_PROGRESS")
        (self.config.reviews_dir / "TASK-01-001-review.md").write_text(
            "# Review\nDecision: APPROVED\nZero BLOCKERS.\n", encoding="utf-8"
        )
        state = derive_workflow_state(self.config)
        self.assertEqual(state.state, WorkflowState.APPROVED_AWAITING_CLOSEOUT)
        self.assertEqual(state.assigned_role, Role.SENIOR)


class TestAntigravityHeadlessRequirements(BaseSupervisorTestCase):
    """Test Antigravity headless requirements and soft permission denial detection."""

    def test_missing_agy_fails_availability_check(self):
        # When agy is not installed or pointing to non-existent bin
        self.config.antigravity_bin = "non_existent_agy_bin"
        self.config.allow_ide_fallback = False
        adapter = AntigravityAdapter(self.config)
        info = adapter.check_availability()
        self.assertFalse(info["available"])
        self.assertEqual(info["status"], "NOT_READY")

    def test_antigravity_ide_does_not_satisfy_headless_requirement_by_default(self):
        # Even if IDE binary exists, allow_ide_fallback=False rejects it
        self.config.allow_ide_fallback = False
        adapter = AntigravityAdapter(self.config)
        with patch.object(adapter, "_resolve_binary", return_value="C:/path/to/antigravity-ide.cmd"):
            info = adapter.check_availability()
            self.assertFalse(info["available"])
            self.assertIn("official headless CLI ('agy') is required", info["error"])

    def test_soft_permission_denial_detected(self):
        adapter = AntigravityAdapter(self.config)
        denied_samples = [
            "tool execution was denied by policy: write permission required",
            "Error: access denied to path backend/src/types.ts",
            "Operation not permitted: cannot edit without user confirmation",
            "prompted for approval and denied",
        ]
        for sample in denied_samples:
            self.assertTrue(adapter.check_for_soft_permission_denials(sample), f"Failed for {sample}")

        safe_output = "Build passed. 15 tests executed with exit code 0."
        self.assertFalse(adapter.check_for_soft_permission_denials(safe_output))


class TestCodexSandboxModes(unittest.TestCase):
    """Test precise Codex sandbox mode mapping according to Workflow v2 actions."""

    def test_pure_read_only_assessment_uses_read_only(self):
        mode = determine_codex_sandbox(role=Role.SENIOR, action_type="ROUTER_INSPECTION")
        self.assertEqual(mode, "read-only")

    def test_read_only_direct_mode_uses_read_only(self):
        mode = determine_codex_sandbox(role=Role.SENIOR, execution_mode=ExecutionMode.READ_ONLY_DIRECT)
        self.assertEqual(mode, "read-only")

    def test_senior_autopilot_uses_workspace_write(self):
        mode = determine_codex_sandbox(role=Role.SENIOR, execution_mode=ExecutionMode.SENIOR_AUTOPILOT)
        self.assertEqual(mode, "workspace-write")

    def test_planner_uses_workspace_write(self):
        mode = determine_codex_sandbox(role=Role.PLANNER, action_type="PLANNING")
        self.assertEqual(mode, "workspace-write")

    def test_senior_review_with_artifact_writes_uses_workspace_write(self):
        mode = determine_codex_sandbox(role=Role.SENIOR, action_type="REVIEW")
        self.assertEqual(mode, "workspace-write")

    def test_senior_closeout_uses_workspace_write(self):
        mode = determine_codex_sandbox(role=Role.SENIOR, action_type="CLOSEOUT")
        self.assertEqual(mode, "workspace-write")

    def test_pure_read_only_review_uses_read_only(self):
        mode = determine_codex_sandbox(role=Role.SENIOR, action_type="READ_ONLY_REVIEW", is_read_only=True)
        self.assertEqual(mode, "read-only")


class TestFeatureGatesAndDryRunSafety(BaseSupervisorTestCase):
    """Test safety feature gates and non-destructive dry-run behavior."""

    def test_default_config_disables_live_ai_and_auto_commit(self):
        config = SupervisorConfig()
        self.assertFalse(config.enable_live_agents)
        self.assertFalse(config.enable_auto_commit)
        self.assertFalse(config.allow_continuous)

    def test_live_agent_execution_is_gated_when_not_explicitly_enabled(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", planning_required="NO")
        
        # Config has enable_live_agents = False
        self.config.enable_live_agents = False
        runner = SupervisorRunner(self.config)
        
        state, stop_report = runner.run_step(dry_run=False, execute_agents=True)
        self.assertIsNotNone(stop_report)
        self.assertEqual(stop_report.state, WorkflowState.USER_DECISION_REQUIRED)
        self.assertIn("Live AI agent execution is gated in MVP", stop_report.reason)

    def test_auto_commit_is_gated_when_not_explicitly_enabled(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="ACCEPTED")
        task_file = self.write_task("TASK-01-001", status="ACCEPTED")
        
        self.config.enable_auto_commit = False
        runner = SupervisorRunner(self.config)
        task = parse_task_contract(task_file)
        git_state = GitState(branch="feat/phase-1a-test", is_clean=False, modified_files=["code.py"])

        success, msg = runner.execute_auto_commit(task, git_state)
        self.assertFalse(success)
        self.assertIn("auto-commit is disabled", msg.lower())

    def test_dry_run_invokes_zero_agents_and_writes_no_files(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", planning_required="YES", execution_mode="PLANNED_IMPLEMENTATION", risk="HIGH")
        
        runner = SupervisorRunner(self.config)
        initial_head = get_git_state(self.repo_root).head_sha
        
        state, stop_report = runner.run_step(dry_run=True)
        self.assertEqual(state.state, WorkflowState.READY_FOR_PLANNING)
        self.assertEqual(state.assigned_role, Role.PLANNER)
        self.assertIsNone(stop_report)
        
        # Verify no plan file was created during dry run
        plan_file = self.config.plans_dir / "TASK-01-001-plan.md"
        self.assertFalse(plan_file.exists())
        self.assertEqual(get_git_state(self.repo_root).head_sha, initial_head)


class TestLockingAndRecovery(BaseSupervisorTestCase):
    """Test exclusive locking, contention, and dead PID recovery."""

    def test_exclusive_lock_and_release(self):
        lock = SupervisorLock(self.config, task_id="TASK-01", role="TEST")
        self.assertTrue(lock.acquire())
        meta = lock.get_lock_metadata()
        self.assertEqual(meta["task_id"], "TASK-01")
        self.assertEqual(meta["pid"], os.getpid())

        # Second lock fails
        lock2 = SupervisorLock(self.config, task_id="TASK-02", role="SECOND")
        self.assertFalse(lock2.acquire())

        lock.release()
        self.assertIsNone(lock.get_lock_metadata())
        self.assertTrue(lock2.acquire())
        lock2.release()

    def test_stale_lock_recovery_dead_pid(self):
        fake_meta = {
            "run_id": "stale-run-id",
            "pid": 999999,
            "hostname": "fake-host",
            "task_id": "STALE-TASK",
            "current_role": "DEAD_ROLE",
            "start_time": "2020-01-01T00:00:00Z",
            "heartbeat": "2020-01-01T00:00:00Z",
        }
        meta_file = self.config.runtime_dir / "supervisor.lock.json"
        meta_file.write_text(json.dumps(fake_meta), encoding="utf-8")

        lock = SupervisorLock(self.config, task_id="RECOVERED-TASK", role="RECOVERED")
        self.assertTrue(lock.acquire())
        meta = lock.get_lock_metadata()
        self.assertEqual(meta["task_id"], "RECOVERED-TASK")
        lock.release()


class TestPostAgentVerification(BaseSupervisorTestCase):
    """Test strict post-agent verification for missing artifacts and failures."""

    def test_planner_success_without_plan_file_triggers_mismatch(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", planning_required="YES")
        
        runner = SupervisorRunner(self.config)
        state = derive_workflow_state(self.config)
        
        # Mock agent returning exit code 0 but NOT writing the plan file
        fake_result = AgentResult(
            role=Role.PLANNER,
            task_id="TASK-01-001",
            exit_code=0,
            stdout="Agent output text saying done",
            process_completed=True,
            stderr="",
            duration_seconds=1.0,
            success=True,
        )
        
        mismatch_report = runner.verify_post_agent_state(state, fake_result, Role.PLANNER)
        self.assertIsNotNone(mismatch_report)
        self.assertEqual(mismatch_report.state, WorkflowState.AGENT_RESULT_MISMATCH)
        self.assertIn("without creating required non-empty plan artifact", mismatch_report.reason)


class TestModelSelectionAndSafety(BaseSupervisorTestCase):
    """Test deterministic model selection, profile overrides, fail-closed safety, and telemetry."""

    def test_read_only_direct_selects_codex_router(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", execution_mode="READ_ONLY_DIRECT", risk="LOW")
        state = derive_workflow_state(self.config)
        self.assertIsNotNone(state.model_selection)
        self.assertEqual(state.model_selection.provider, "Codex")
        self.assertEqual(state.model_selection.profile.name, "codex_router")
        self.assertEqual(state.model_selection.effort, "low")
        self.assertIn("read-only", state.model_selection.selection_reason.lower())


    def test_senior_autopilot_selects_codex_autopilot_profile(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", execution_mode="SENIOR_AUTOPILOT", risk="LOW", planning_required="NO")
        state = derive_workflow_state(self.config)
        self.assertIsNotNone(state.model_selection)
        self.assertEqual(state.model_selection.provider, "Codex")
        self.assertEqual(state.model_selection.profile.name, "codex_senior_autopilot")
        self.assertEqual(state.model_selection.effort, "medium")
        self.assertIn("senior autopilot", state.model_selection.selection_reason.lower())

    def test_planner_action_selects_codex_planner_profile(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", planning_required="YES", execution_mode="PLANNED_IMPLEMENTATION", risk="HIGH")
        state = derive_workflow_state(self.config)
        self.assertIsNotNone(state.model_selection)
        self.assertEqual(state.model_selection.provider, "Codex")
        self.assertEqual(state.model_selection.profile.name, "codex_planner")
        self.assertEqual(state.model_selection.effort, "high")
        self.assertIn("planning", state.model_selection.selection_reason.lower())

    def test_senior_review_selects_codex_reviewer_profiles(self):
        # Medium risk review
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", risk="MEDIUM")
        (self.config.reports_dir / "TASK-01-001-implementation.md").write_text(
            "# Report\nStatus: COMPLETE — AWAITING SENIOR REVIEW\n", encoding="utf-8"
        )
        state_med = derive_workflow_state(self.config)
        self.assertIsNotNone(state_med.model_selection)
        self.assertEqual(state_med.model_selection.provider, "Codex")
        self.assertEqual(state_med.model_selection.profile.name, "codex_reviewer")
        self.assertEqual(state_med.model_selection.effort, "medium")

        # High risk review
        self.write_task("TASK-01-001", risk="HIGH")
        state_high = derive_workflow_state(self.config)
        self.assertIsNotNone(state_high.model_selection)
        self.assertEqual(state_high.model_selection.provider, "Codex")
        self.assertEqual(state_high.model_selection.profile.name, "codex_reviewer_high_risk")
        self.assertEqual(state_high.model_selection.effort, "high")

    def test_normal_gemini_implementation_profile(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", planning_required="NO", execution_mode="DIRECT_IMPLEMENTATION", risk="MEDIUM")
        state = derive_workflow_state(self.config)
        self.assertIsNotNone(state.model_selection)
        self.assertEqual(state.model_selection.provider, "Antigravity")
        self.assertEqual(state.model_selection.profile.name, "gemini_implementation")
        self.assertEqual(state.model_selection.profile.model, "gemini-3.7-flash-medium")
        self.assertEqual(state.model_selection.effort, "medium")

    def test_high_risk_gemini_implementation_profile(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", planning_required="YES", execution_mode="PLANNED_IMPLEMENTATION", risk="HIGH", difficulty="9/10")
        (self.config.plans_dir / "TASK-01-001-plan.md").write_text("# Plan\nDetails...", encoding="utf-8")
        state = derive_workflow_state(self.config)
        self.assertIsNotNone(state.model_selection)
        self.assertEqual(state.model_selection.provider, "Antigravity")
        self.assertEqual(state.model_selection.profile.name, "gemini_high_risk_implementation")
        self.assertEqual(state.model_selection.profile.model, "gemini-3.8-flash-high")
        self.assertEqual(state.model_selection.effort, "high")

    def test_fix_required_selects_fix_profile_cycle_0(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", risk="MEDIUM")
        (self.config.reports_dir / "TASK-01-001-implementation.md").write_text(
            "# Report\nStatus: COMPLETE\n", encoding="utf-8"
        )
        (self.config.reviews_dir / "TASK-01-001-review.md").write_text(
            "# Review\nDecision: CHANGES_REQUESTED\nFindings:\n- BLOCKER: Broken validation\n", encoding="utf-8"
        )
        state = derive_workflow_state(self.config, fix_cycle=0)
        self.assertEqual(state.state, WorkflowState.FIX_REQUIRED)
        self.assertEqual(state.assigned_role, Role.IMPLEMENTATION)
        self.assertIsNotNone(state.model_selection)
        self.assertEqual(state.model_selection.provider, "Antigravity")
        self.assertEqual(state.model_selection.profile.name, "gemini_fix")
        self.assertEqual(state.model_selection.profile.model, "gemini-3.7-flash-medium")
        self.assertEqual(state.model_selection.effort, "medium")
        self.assertEqual(state.model_selection.escalation_level, 0)

    def test_fix_required_bounded_escalation_cycle_1(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", risk="MEDIUM")
        (self.config.reports_dir / "TASK-01-001-implementation.md").write_text(
            "# Report\nStatus: COMPLETE\n", encoding="utf-8"
        )
        (self.config.reviews_dir / "TASK-01-001-review.md").write_text(
            "# Review\nDecision: CHANGES_REQUESTED\nFindings:\n- BLOCKER: Broken validation\n", encoding="utf-8"
        )
        state = derive_workflow_state(self.config, fix_cycle=1)
        self.assertEqual(state.state, WorkflowState.FIX_REQUIRED)
        self.assertIsNotNone(state.model_selection)
        self.assertEqual(state.model_selection.provider, "Antigravity")
        self.assertEqual(state.model_selection.profile.name, "gemini_escalation")
        self.assertEqual(state.model_selection.profile.model, "gemini-3.8-flash-high")
        self.assertEqual(state.model_selection.effort, "high")
        self.assertEqual(state.model_selection.escalation_level, 1)
        self.assertIn("escalation", state.model_selection.selection_reason.lower())

    def test_model_selection_cannot_alter_workflow_v2_routing(self):
        # Even if environment configures an override, workflow routing authority (state & role) is unchanged
        with patch.dict(os.environ, {"KS_MODEL_GEMINI_IMPLEMENTATION": "custom-gemini-test"}):
            self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
            self.write_task("TASK-01-001", planning_required="YES", risk="HIGH")
            state = derive_workflow_state(self.config)
            # Must remain READY_FOR_PLANNING for Role.PLANNER regardless of implementation profile override
            self.assertEqual(state.state, WorkflowState.READY_FOR_PLANNING)
            self.assertEqual(state.assigned_role, Role.PLANNER)

    def test_model_config_cannot_turn_high_risk_task_into_autopilot(self):
        # A HIGH risk task cannot become SENIOR_AUTOPILOT even if execution mode field attempted it
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", execution_mode="SENIOR_AUTOPILOT", risk="HIGH", planning_required="YES")
        state = derive_workflow_state(self.config)
        # Router requires planning for HIGH risk, ignoring autopilot request
        self.assertEqual(state.state, WorkflowState.READY_FOR_PLANNING)
        self.assertEqual(state.assigned_role, Role.PLANNER)
        self.assertEqual(state.model_selection.profile.name, "codex_planner")

    def test_user_profile_overrides_via_env(self):
        with patch.dict(
            os.environ,
            {
                "KS_MODEL_CODEX_ROUTER": "custom-codex-fast",
                "KS_EFFORT_CODEX_ROUTER": "medium",
            },
        ):
            self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
            self.write_task("TASK-01-001", execution_mode="READ_ONLY_DIRECT", risk="LOW")
            state = derive_workflow_state(self.config)
            self.assertEqual(state.model_selection.model_name, "custom-codex-fast")
            self.assertEqual(state.model_selection.effort, "medium")

    def test_fail_closed_on_unavailable_explicit_model(self):
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", planning_required="NO", risk="MEDIUM")

        self.config.enable_live_agents = True
        runner = SupervisorRunner(self.config)

        # Patch validate_profile_availability to return unavailable
        with patch(
            "tools.ks_supervisor.runner.validate_profile_availability",
            return_value=(False, "MODEL_NOT_AVAILABLE: Antigravity model absent from successfully returned inventory"),
        ):
            state, stop_report = runner.run_step(dry_run=False, execute_agents=True)
            self.assertIsNotNone(stop_report)
            self.assertEqual(stop_report.state, WorkflowState.MODEL_NOT_AVAILABLE)
            self.assertIn("MODEL_NOT_AVAILABLE", stop_report.reason)
            self.assertIn("Antigravity", stop_report.reason)
            self.assertEqual(stop_report.evidence["provider"], "antigravity")

    def test_agy_models_validation_matching_and_unmatched(self):
        from tools.ks_supervisor.models import get_configured_profile, validate_profile_availability

        profile = get_configured_profile("gemini_implementation", self.config)
        
        # Test 1: Model present in agy models output
        with patch.object(
            AntigravityAdapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "agy"},
        ), patch.object(
            AntigravityAdapter,
            "get_available_models",
            return_value=(True, ["gemini-3.7-flash-medium", "gemini-3.8-flash-high"], None),
        ):
            ok, msg = validate_profile_availability(profile, self.config)
            self.assertTrue(ok)
            self.assertIn("Verified available on Antigravity", msg)

        # Test 2: Model NOT present in agy models output -> Fail-closed
        with patch.object(
            AntigravityAdapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "agy"},
        ), patch.object(
            AntigravityAdapter,
            "get_available_models",
            return_value=(True, ["gemini-3.6-flash-low"], None),
        ):
            ok, msg = validate_profile_availability(profile, self.config)
            self.assertFalse(ok)
            self.assertIn("MODEL_NOT_AVAILABLE", msg)
            self.assertIn("not in available models list", msg)

    def test_antigravity_command_construction(self):
        adapter = AntigravityAdapter(self.config)
        from tools.ks_supervisor.models import get_configured_profile
        profile = get_configured_profile("gemini_implementation", self.config)

        def make_proc():
            proc = MagicMock()
            proc.pid = 9999
            proc.returncode = 0
            proc.poll.side_effect = [None, 0]
            proc.stdout.readline.side_effect = ['{"type":"result","usage":{}}\n', ""]
            proc.stderr.readline.side_effect = [""]
            return proc

        with patch.object(
            adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "C:/agy/bin/agy.exe", "is_headless": True},
        ), patch("subprocess.Popen", side_effect=lambda *args, **kwargs: make_proc()) as mock_subproc:
            res = adapter.invoke(Role.IMPLEMENTATION, "TASK-01-001", prompt="Do test task", profile=profile)
            
            self.assertTrue(res.success)
            mock_subproc.assert_called_once()
            call_cmd = mock_subproc.call_args[0][0]
            
            # Pin the existing CLI project whose grants the planner checks.
            expected_prefix = ["C:/agy/bin/agy.exe", "-p", "Do test task", "--mode", "accept-edits", "--project", "default-cli-project", "--model", "gemini-3.7-flash-medium", "--effort", "medium", "--output-format", "stream-json"]
            self.assertEqual(call_cmd, expected_prefix)

            # Verify read-only / planner mode uses --mode plan
            mock_subproc.reset_mock()
            res_plan = adapter.invoke(Role.PLANNER, "TASK-01-001", prompt="Plan task", profile=profile, is_read_only=True)
            self.assertTrue(res_plan.success)
            call_cmd_plan = mock_subproc.call_args[0][0]
            expected_plan = ["C:/agy/bin/agy.exe", "-p", "Plan task", "--mode", "plan", "--project", "default-cli-project", "--model", "gemini-3.7-flash-medium", "--effort", "medium", "--output-format", "stream-json"]
            self.assertEqual(call_cmd_plan, expected_plan)

    def test_provider_auth_or_quota_failure_classification(self):
        adapter = AntigravityAdapter(self.config)
        
        # Test error patterns detection
        samples = [
            ("Error: 429 Too Many Requests: quota exceeded for current billing cycle", True),
            ("Authentication required. Please run `agy auth login` to authenticate.", True),
            ("Resource_exhausted: User plan limit reached", True),
            ("All 12 unit tests passed cleanly.", False),
        ]
        for text, expected in samples:
            is_quota, reason = adapter.check_for_auth_or_quota_failure("", stderr=text, exit_code=1)
            self.assertEqual(is_quota, expected, f"Failed for text: {text}")

        # Test supervisor halts on quota failure without retries
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", planning_required="NO", risk="MEDIUM")

        self.config.enable_live_agents = True
        runner = SupervisorRunner(self.config)

        # Mock adapter returning quota failure
        with patch.object(
            runner.antigravity_adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "agy", "is_headless": True},
        ), patch.object(
            runner.antigravity_adapter,
            "get_available_models",
            return_value=(True, ["gemini-3.7-flash-medium", "gemini-3.8-flash-high"], None),
        ), patch.object(
            runner.antigravity_adapter,
            "invoke",
            side_effect=lambda *args, **kwargs: AgentResult(
                run_id=kwargs["run_id"], started_at=datetime.now(timezone.utc).isoformat(),
                role=Role.IMPLEMENTATION,
                task_id="TASK-01-001",
                exit_code=1,
                stdout="",
                stderr="Error: 429 Too Many Requests - quota exceeded",
                duration_seconds=0.5,
                success=False,
                error_message="PROVIDER_QUOTA_OR_AUTH_REQUIRED: Provider quota exceeded or plan limit reached",
                auth_or_quota_failure=True,
                provider="antigravity",
                model_name="gemini-3.7-flash-medium",
                effort="medium",
            ),
        ):
            state, stop_report = runner.run_step(dry_run=False, execute_agents=True)
            self.assertIsNotNone(stop_report)
            self.assertEqual(stop_report.state, WorkflowState.PROVIDER_QUOTA_OR_AUTH_REQUIRED)
            self.assertIn("Provider quota or authentication required", stop_report.reason)

    def test_antigravity_stream_json_telemetry_parsing(self):
        from tools.ks_supervisor.adapters.antigravity import parse_antigravity_stream_json

        raw_output = """{"type": "init", "session_id": "session-123"}
{"type": "message", "content": "Working on file..."}
{"type": "result", "status": "success", "usage": {"input_tokens": 1200, "output_tokens": 450, "total_tokens": 1650}}
"""
        session_id, is_denial, usage = parse_antigravity_stream_json(raw_output)
        self.assertEqual(session_id, "session-123")
        self.assertFalse(is_denial)
        self.assertEqual(usage, {"input_tokens": 1200, "output_tokens": 450, "total_tokens": 1650})



class TestBaselineDeltaAndObservableEffect(BaseSupervisorTestCase):
    """Test repository baseline capture, delta computation, and fail-closed NO-OP rejection."""

    def test_baseline_and_delta_computation_with_preexisting_dirty_files(self):
        # 1. Create and commit an initial file
        app_file = self.repo_root / "src" / "existing.ts"
        app_file.parent.mkdir(parents=True, exist_ok=True)
        app_file.write_text("console.log('v1');\n", encoding="utf-8")
        run_git(self.repo_root, "add", ".")
        run_git(self.repo_root, "commit", "-m", "Add initial existing.ts")

        # 2. Make working tree pre-dirty (1 modified, 1 untracked)
        app_file.write_text("console.log('v1-pre-existing-edit');\n", encoding="utf-8")
        untracked = self.repo_root / "src" / "preexisting_untracked.ts"
        untracked.write_text("// untracked before agent run\n", encoding="utf-8")

        # 3. Capture baseline BEFORE agent run
        pre_baseline = capture_repository_baseline(self.config, "TASK-01-001", "IMPLEMENTATION_IN_PROGRESS")
        self.assertIn("src/existing.ts", pre_baseline.modified_files)
        self.assertIn("src/preexisting_untracked.ts", pre_baseline.untracked_files)

        # 4. Simulate a NO-OP agent (files untouched)
        post_baseline_noop = capture_repository_baseline(self.config, "TASK-01-001", "IMPLEMENTATION_IN_PROGRESS")
        delta_noop = compute_repository_delta(pre_baseline, post_baseline_noop, self.config.repo_root)

        # Pre-existing dirty files MUST NOT be attributed as agent edits
        self.assertFalse(delta_noop.observable_effect)
        self.assertEqual(delta_noop.modified_files, [])
        self.assertEqual(delta_noop.new_files, [])
        self.assertEqual(delta_noop.deleted_files, [])

        # 5. Simulate an agent that DOES modify a pre-existing dirty file
        app_file.write_text("console.log('v2-agent-modified');\n", encoding="utf-8")
        post_baseline_edit = capture_repository_baseline(self.config, "TASK-01-001", "IMPLEMENTATION_IN_PROGRESS")
        delta_edit = compute_repository_delta(pre_baseline, post_baseline_edit, self.config.repo_root)

        self.assertTrue(delta_edit.observable_effect)
        self.assertEqual(delta_edit.modified_files, ["src/existing.ts"])

        # 6. Simulate an agent that creates a report file
        report_file = self.config.reports_dir / "TASK-01-001-implementation.md"
        report_file.write_text("# Implementation Report\nStatus: COMPLETE\n", encoding="utf-8")
        post_baseline_report = capture_repository_baseline(self.config, "TASK-01-001", "IMPLEMENTATION_IN_PROGRESS")
        delta_report = compute_repository_delta(pre_baseline, post_baseline_report, self.config.repo_root)

        self.assertTrue(delta_report.observable_effect)
        self.assertTrue(any(a.startswith("report:") for a in delta_report.changed_workflow_artifacts))

    def test_noop_agent_run_fails_with_no_observable_effect_without_burning_retries(self):
        """A run that exits 0 with zero file/evidence changes must fail closed without burning fix_cycles."""
        self.write_checkpoint(current_task="TASK-01-001", task_status="FIX_REQUIRED")
        self.write_task("TASK-01-001", planning_required="NO", risk="HIGH")

        # Existing review file indicating blocker
        review_file = self.config.reviews_dir / "TASK-01-001-review.md"
        review_file.write_text("# Review\nVerdict: CHANGES_REQUIRED\n- BLOCKER: missing null guard\n", encoding="utf-8")

        # Existing report file
        report_file = self.config.reports_dir / "TASK-01-001-implementation.md"
        report_file.write_text("# Report\nStatus: INCOMPLETE\n", encoding="utf-8")

        self.config.enable_live_agents = True
        runner = SupervisorRunner(self.config)

        # Mock adapter returning exit 0, but creating NO workspace modifications
        with patch.object(
            runner.antigravity_adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "agy", "is_headless": True},
        ), patch.object(
            runner.antigravity_adapter,
            "get_available_models",
            return_value=(True, ["gemini-3.7-flash-medium", "gemini-3.8-flash-high"], None),
        ), patch.object(
            runner.antigravity_adapter,
            "invoke",
            side_effect=lambda *args, **kwargs: AgentResult(
                run_id=kwargs["run_id"], started_at=datetime.now(timezone.utc).isoformat(),
                role=Role.IMPLEMENTATION,
                task_id="TASK-01-001",
                exit_code=0,
                stdout='{"type":"result","usage":{}}',
                stderr="",
                duration_seconds=24.0,
                success=True,
                process_completed=True,
                provider_reported_success=True,
                provider="antigravity",
                model_name="gemini-3.7-flash-medium",
                effort="medium",
            ),
        ):
            state, stop_report = runner.run_step(dry_run=False, execute_agents=True)

            # Must fail closed as AGENT_RESULT_MISMATCH
            self.assertIsNotNone(stop_report)
            self.assertEqual(stop_report.state, WorkflowState.AGENT_RESULT_MISMATCH)
            self.assertIn("NO_OBSERVABLE_AGENT_EFFECT", stop_report.reason)

            # Must NOT burn the fix cycle retry limit on a pure no-op!
            self.assertEqual(runner.fix_cycles.get("TASK-01-001", 0), 0)

            # Verify diagnostic log was persisted under .git/ks-runtime/last_agent_run.json
            last_run_file = self.config.runtime_dir / "last_agent_run.json"
            self.assertTrue(last_run_file.exists())
            diag_data = json.loads(last_run_file.read_text(encoding="utf-8"))
            self.assertEqual(diag_data["exit_code"], 0)
            self.assertFalse(diag_data["observable_repo_effect"])
            self.assertEqual(diag_data["delta"]["observable_effect"], False)

    def test_fix_required_remediation_with_actual_changes_advances_and_consumes_cycle(self):
        """When an agent fixes blockers and updates code/report, the fix cycle is consumed and state advances."""
        self.write_checkpoint(current_task="TASK-01-001", task_status="FIX_REQUIRED")
        self.write_task("TASK-01-001", planning_required="NO", risk="HIGH")

        review_file = self.config.reviews_dir / "TASK-01-001-review.md"
        review_file.write_text("# Review\nVerdict: CHANGES_REQUIRED\n- BLOCKER: missing null guard\n", encoding="utf-8")

        report_file = self.config.reports_dir / "TASK-01-001-implementation.md"
        report_file.write_text("# Report\nStatus: INCOMPLETE\n", encoding="utf-8")

        code_file = self.repo_root / "src" / "handler.ts"
        code_file.parent.mkdir(parents=True, exist_ok=True)
        code_file.write_text("// original\n", encoding="utf-8")
        run_git(self.repo_root, "add", ".")
        run_git(self.repo_root, "commit", "-m", "Add handler.ts")

        self.config.enable_live_agents = True
        runner = SupervisorRunner(self.config)

        def mock_fix_work(*args, **kwargs):
            # Agent actually makes changes to code and updates report
            code_file.write_text("// fixed null guard\n", encoding="utf-8")
            report_file.write_text(
                "# Implementation Report\n\n"
                "## Status\nCOMPLETE\n\n"
                "## Blocker fixes\n"
                "- B-1: Fixed null guard in handler.ts\n\n"
                "## Tests/checks run and results\n"
                "- pnpm test: PASS\n\n"
                "## Acceptance criteria status\n"
                "- [x] AC-1: Feature works.\n\n"
                "## Unresolved BLOCKERS\nNone\n",
                encoding="utf-8",
            )
            # Ensure report mtime is strictly newer than review mtime
            rev_mtime = review_file.stat().st_mtime
            os.utime(str(report_file), (rev_mtime + 10, rev_mtime + 10))
            return AgentResult(
                run_id=kwargs["run_id"], started_at=datetime.now(timezone.utc).isoformat(),
                role=Role.IMPLEMENTATION,
                task_id="TASK-01-001",
                exit_code=0,
                stdout='{"type":"result","usage":{"total_tokens":500}}',
                stderr="",
                duration_seconds=15.0,
                success=True,
                process_completed=True,
                provider_reported_success=True,
                provider="antigravity",
                model_name="gemini-3.7-flash-medium",
                effort="medium",
            )

        with patch.object(
            runner.antigravity_adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "agy", "is_headless": True},
        ), patch.object(
            runner.antigravity_adapter,
            "get_available_models",
            return_value=(True, ["gemini-3.7-flash-medium", "gemini-3.8-flash-high"], None),
        ), patch.object(
            runner.antigravity_adapter,
            "invoke",
            side_effect=mock_fix_work,
        ):
            state, stop_report = runner.run_step(dry_run=False, execute_agents=True)

            # Must succeed with no stop report
            self.assertIsNone(stop_report)
            # Fix cycle MUST be consumed
            self.assertEqual(runner.fix_cycles.get("TASK-01-001", 0), 1)
            # State must transition to FIX_AWAITING_TARGETED_VERIFICATION
            self.assertEqual(state.state, WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION)

    def test_postcondition_boundary_violations(self):
        """Agents violating boundary invariants (e.g. implementation modifying review) must be rejected."""
        # 1. Implementation modifying senior review artifact
        delta_viol = RepositoryDelta(
            modified_files=["docs/engineering/ai/reviews/TASK-01-001-review.md"],
            changed_workflow_artifacts=["review:TASK-01-001"],
            observable_effect=True,
        )
        init_state = derive_workflow_state(self.config)
        pc = evaluate_postconditions(ACTION_FIX, init_state, init_state, delta_viol)
        self.assertFalse(pc.postconditions_valid)
        self.assertIn("Implementation agent modified the senior review artifact", pc.violations)

        # 2. Planner modifying application files
        delta_plan_viol = RepositoryDelta(
            new_files=["src/new_code.ts"],
            observable_effect=True,
        )
        pc_plan = evaluate_postconditions(ACTION_PLANNING, init_state, init_state, delta_plan_viol)
        self.assertFalse(pc_plan.postconditions_valid)
        self.assertIn("Planner modified application files", pc_plan.violations)


class TestPermissionDenialAndPromptPacket(BaseSupervisorTestCase):
    """Test headless permission-denial detection, zero-burn retry isolation, and compact prompt packet."""

    def test_exit_zero_success_with_denied_actions_stops_as_agent_permission_required(self):
        """Exit code 0 with final status SUCCESS but non-empty denied_actions must stop as AGENT_PERMISSION_REQUIRED."""
        self.write_checkpoint(current_task="TASK-2A-001", task_status="FIX_REQUIRED")
        self.write_task("TASK-2A-001", planning_required="NO", risk="HIGH")

        self.config.enable_live_agents = True
        runner = SupervisorRunner(self.config)

        # Mock adapter returning exit 0, provider SUCCESS, but denied_actions populated
        with patch.object(
            runner.antigravity_adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "agy", "is_headless": True},
        ), patch.object(
            runner.antigravity_adapter,
            "get_available_models",
            return_value=(True, ["gemini-3.7-flash-medium", "gemini-3.8-flash-high"], None),
        ), patch.object(
            runner.antigravity_adapter,
            "invoke",
            side_effect=lambda *args, **kwargs: AgentResult(
                run_id=kwargs["run_id"], started_at=datetime.now(timezone.utc).isoformat(),
                role=Role.IMPLEMENTATION,
                task_id="TASK-2A-001",
                exit_code=0,
                stdout='{"type":"result","status":"SUCCESS","denied_actions":["command / RunCommand"]}',
                stderr="",
                duration_seconds=24.0,
                success=False,
                process_completed=True,
                provider_reported_success=False,
                soft_permission_denial=True,
                denied_actions=["command / RunCommand"],
                error_message="AGENT_PERMISSION_REQUIRED: Headless mode auto-denied permission for: command / RunCommand",
                provider="antigravity",
                model_name="gemini-3.7-flash-medium",
                effort="medium",
            ),
        ):
            state, stop_report = runner.run_step(dry_run=False, execute_agents=True)

            self.assertIsNotNone(stop_report)
            self.assertEqual(stop_report.state, WorkflowState.AGENT_PERMISSION_REQUIRED)
            self.assertNotEqual(stop_report.state, WorkflowState.AGENT_RESULT_MISMATCH)
            self.assertIn("AGENT_PERMISSION_REQUIRED", stop_report.reason)
            self.assertIn("command / RunCommand", stop_report.evidence["denied_actions"])

            # Counter must NOT be incremented
            self.assertEqual(runner.fix_cycles.get("TASK-2A-001", 0), 0)
            self.assertEqual(runner.impl_attempts.get("TASK-2A-001", 0), 0)

            # Check diagnostics recorded
            last_run_file = self.config.runtime_dir / "last_agent_run.json"
            self.assertTrue(last_run_file.exists())
            diag_data = json.loads(last_run_file.read_text(encoding="utf-8"))
            self.assertEqual(diag_data["denied_actions"], ["command / RunCommand"])
            self.assertTrue(diag_data["soft_permission_denial"])

    def test_stderr_auto_denial_detected_by_adapter(self):
        """Stderr containing headless auto-denial must set soft_permission_denial and clear success."""
        adapter = AntigravityAdapter(self.config)
        stderr_msg = "a tool required the \"command\" permission that headless mode cannot prompt for, so it was auto-denied"
        
        has_denial, actions = adapter.check_for_permission_denials(stderr_msg)
        self.assertTrue(has_denial)
        self.assertTrue(any("command" in a for a in actions))

        def make_denial_proc():
            proc = MagicMock()
            proc.pid = 9999
            proc.returncode = 0
            proc.poll.side_effect = [None, 0]
            proc.stdout.readline.side_effect = ['{"type":"result","status":"SUCCESS","usage":{}}\n', ""]
            proc.stderr.readline.side_effect = [stderr_msg + "\n", ""]
            return proc

        with patch.object(
            adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "C:/agy/bin/agy.exe", "is_headless": True},
        ), patch("subprocess.Popen", side_effect=lambda *args, **kwargs: make_denial_proc()):
            res = adapter.invoke(Role.IMPLEMENTATION, "TASK-2A-001")
            
            # provider_reported_success must not override the denial
            self.assertFalse(res.success)
            self.assertFalse(res.provider_reported_success)
            self.assertTrue(res.soft_permission_denial)
            self.assertTrue(len(res.denied_actions) > 0)
            self.assertIn("AGENT_PERMISSION_REQUIRED", res.error_message)

    def test_provider_success_with_no_denials_and_repo_effect_succeeds(self):
        """Provider SUCCESS with no denied actions and observable repo effect advances state."""
        self.write_checkpoint(current_task="TASK-2A-001", task_status="FIX_REQUIRED")
        self.write_task("TASK-2A-001", planning_required="NO", risk="HIGH")

        code_file = self.repo_root / "src" / "index.ts"
        code_file.parent.mkdir(parents=True, exist_ok=True)
        code_file.write_text("// original\n", encoding="utf-8")
        run_git(self.repo_root, "add", ".")
        run_git(self.repo_root, "commit", "-m", "Initial index.ts")

        report_file = self.config.reports_dir / "TASK-2A-001-implementation.md"
        report_file.write_text("# Report\nStatus: INCOMPLETE\n", encoding="utf-8")

        review_file = self.config.reviews_dir / "TASK-2A-001-review.md"
        review_file.write_text("# Review\nVerdict: CHANGES_REQUIRED\n- B-1: fix bug\n", encoding="utf-8")

        self.config.enable_live_agents = True
        runner = SupervisorRunner(self.config)

        def mock_clean_fix(*args, **kwargs):
            code_file.write_text("// fixed\n", encoding="utf-8")
            report_file.write_text("# Implementation Report\n\nStatus: COMPLETE\n\n## Blocker fixes\n- B-1: fixed bug\n", encoding="utf-8")
            os.utime(str(report_file), (review_file.stat().st_mtime + 10, review_file.stat().st_mtime + 10))
            return AgentResult(
                run_id=kwargs["run_id"], started_at=datetime.now(timezone.utc).isoformat(),
                role=Role.IMPLEMENTATION,
                task_id="TASK-2A-001",
                exit_code=0,
                stdout='{"type":"result","status":"SUCCESS","usage":{"total_tokens":300}}',
                stderr="",
                duration_seconds=10.0,
                success=True,
                process_completed=True,
                provider_reported_success=True,
                soft_permission_denial=False,
                denied_actions=[],
                provider="antigravity",
                model_name="gemini-3.7-flash-medium",
                effort="medium",
            )

        with patch.object(
            runner.antigravity_adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "agy", "is_headless": True},
        ), patch.object(
            runner.antigravity_adapter,
            "get_available_models",
            return_value=(True, ["gemini-3.7-flash-medium", "gemini-3.8-flash-high"], None),
        ), patch.object(
            runner.antigravity_adapter,
            "invoke",
            side_effect=mock_clean_fix,
        ):
            state, stop_report = runner.run_step(dry_run=False, execute_agents=True)
            self.assertIsNone(stop_report)
            self.assertEqual(runner.fix_cycles.get("TASK-2A-001", 0), 1)
            self.assertEqual(state.state, WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION)

    def test_generated_prompt_navigation_rules_and_shell_prohibition(self):
        """Prompt packet must explicitly mandate workspace discovery tools and forbid shell listing."""
        adapter = AntigravityAdapter(self.config)
        prompt = adapter.build_prompt(
            Role.IMPLEMENTATION,
            "TASK-2A-001",
            is_fix=True,
            review_blockers="- B-1: Fix missing null guard\n- B-2: Fix transaction rollback",
            canonical_paths={
                "task": "docs/engineering/ai/tasks/TASK-2A-001-billing.md",
                "report": "docs/engineering/ai/reports/TASK-2A-001-implementation.md",
                "review": "docs/engineering/ai/reviews/TASK-2A-001-review.md",
                "checkpoint": "docs/engineering/IMPLEMENTATION_CHECKPOINT.md",
            },
        )

        # 1. Must explicitly prefer built-in workspace discovery tools
        self.assertIn("list_dir", prompt)
        self.assertIn("find_by_name", prompt)
        self.assertIn("grep_search", prompt)
        self.assertIn("view_file", prompt)

        # 2. Must explicitly discourage/prohibit shell commands for navigation
        self.assertIn("Get-ChildItem", prompt)
        self.assertIn("dir", prompt)
        self.assertIn("ls", prompt)
        self.assertIn("Do NOT use `Get-ChildItem`, `dir`, `ls`", prompt)

        # 3. Missing report file does NOT encourage shell directory listing
        self.assertIn("A missing optional workflow artifact is NOT fatal", prompt)
        self.assertIn("docs/engineering/ai/reports/TASK-2A-001-implementation.md", prompt)

        # 4. Contains exact blockers
        self.assertIn("B-1: Fix missing null guard", prompt)
        self.assertIn("B-2: Fix transaction rollback", prompt)

    def test_narrow_command_permissions_and_no_dangerously_skip_permissions(self):
        """Antigravity invocation must never include --dangerously-skip-permissions."""
        adapter = AntigravityAdapter(self.config)
        proc = MagicMock()
        proc.pid = 9999
        proc.returncode = 0
        proc.poll.side_effect = [None, 0]
        proc.stdout.readline.side_effect = ['{"type":"result"}\n', ""]
        proc.stderr.readline.side_effect = [""]

        with patch.object(
            adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "C:/agy/bin/agy.exe", "is_headless": True},
        ), patch("subprocess.Popen", return_value=proc) as mock_subproc:
            adapter.invoke(Role.IMPLEMENTATION, "TASK-2A-001", prompt="test prompt")
            
            call_cmd = mock_subproc.call_args[0][0]
            self.assertNotIn("--dangerously-skip-permissions", call_cmd)
            self.assertIn("--mode", call_cmd)
            self.assertIn("accept-edits", call_cmd)


class TestStreamingAndProgressAwareTimeouts(BaseSupervisorTestCase):
    """Test incremental streaming, partial output retention, and progress-aware timeouts."""

    def test_partial_stdout_events_survive_hard_timeout(self):
        """When process times out, partial stdout NDJSON events must be retained and parsed."""
        adapter = AntigravityAdapter(self.config)
        event1 = json.dumps({"type": "step_start", "step_index": 1})
        event2 = json.dumps({"type": "tool_call", "name": "replace_file_content", "path": "src/app.py"})
        event3 = json.dumps({"type": "usage", "total_tokens": 450})

        proc = MagicMock()
        proc.pid = 9999
        proc.returncode = None
        proc.poll.return_value = None  # Process stays alive until terminated
        proc.stdout.readline.side_effect = [f"{event1}\n", f"{event2}\n", f"{event3}\n", ""]
        proc.stderr.readline.side_effect = [""]

        with patch.object(
            adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "C:/agy/bin/agy.exe", "is_headless": True},
        ), patch("subprocess.Popen", return_value=proc), patch(
            "tools.ks_supervisor.adapters.antigravity.terminate_process_tree"
        ) as mock_term:
            res = adapter.invoke(
                Role.IMPLEMENTATION,
                "TASK-2A-001",
                hard_timeout=0.2,
                idle_timeout=10.0,
            )

            mock_term.assert_called_once_with(proc)
            self.assertEqual(res.exit_code, 124)
            self.assertTrue(res.timed_out)
            self.assertEqual(res.timeout_kind, "hard_limit")
            self.assertIn("replace_file_content", res.stdout)
            self.assertEqual(res.events_received, 3)
            self.assertEqual(res.last_step_index, 1)
            self.assertEqual(res.last_tool_name, "replace_file_content")
            self.assertEqual(res.last_tool_target, "src/app.py")
            self.assertIsNotNone(res.last_activity_at)

            # Runtime stream file must exist and contain the events
            stream_file = self.config.runtime_dir / "current_agent_stream.jsonl"
            self.assertTrue(stream_file.exists())
            stream_content = stream_file.read_text(encoding="utf-8")
            self.assertIn("replace_file_content", stream_content)

    def test_partial_stderr_survives_timeout(self):
        """Stderr lines emitted before timeout must be captured in AgentResult and stderr log."""
        adapter = AntigravityAdapter(self.config)

        proc = MagicMock()
        proc.pid = 9999
        proc.returncode = None
        proc.poll.return_value = None
        proc.stdout.readline.side_effect = [""]
        proc.stderr.readline.side_effect = ["Compiling TypeScript modules...\n", "Error: unexpected token in file.ts\n", ""]

        with patch.object(
            adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "C:/agy/bin/agy.exe", "is_headless": True},
        ), patch("subprocess.Popen", return_value=proc), patch(
            "tools.ks_supervisor.adapters.antigravity.terminate_process_tree"
        ):
            res = adapter.invoke(
                Role.IMPLEMENTATION,
                "TASK-2A-001",
                hard_timeout=0.2,
                idle_timeout=10.0,
            )

            self.assertEqual(res.exit_code, 124)
            self.assertIn("unexpected token in file.ts", res.stderr)

            # Runtime stderr log must exist and contain the text
            stderr_file = self.config.runtime_dir / "current_agent_stderr.log"
            self.assertTrue(stderr_file.exists())
            self.assertIn("unexpected token", stderr_file.read_text(encoding="utf-8"))

    def test_idle_timeout_classification(self):
        """When no stream activity arrives for idle_timeout, timeout_kind must be 'idle'."""
        adapter = AntigravityAdapter(self.config)

        proc = MagicMock()
        proc.pid = 9999
        proc.returncode = None
        proc.poll.return_value = None
        proc.stdout.readline.side_effect = [""]
        proc.stderr.readline.side_effect = [""]

        with patch.object(
            adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "C:/agy/bin/agy.exe", "is_headless": True},
        ), patch("subprocess.Popen", return_value=proc), patch(
            "tools.ks_supervisor.adapters.antigravity.terminate_process_tree"
        ):
            res = adapter.invoke(
                Role.IMPLEMENTATION,
                "TASK-2A-001",
                hard_timeout=10.0,
                idle_timeout=0.15,
            )

            self.assertEqual(res.exit_code, 124)
            self.assertTrue(res.timed_out)
            self.assertEqual(res.timeout_kind, "idle")
            self.assertIn("timed out (idle)", res.error_message)

    def test_observable_repo_delta_survives_timeout_classification(self):
        """When agent times out after making real repo changes, stop report classifies as AGENT_EXECUTION_TIMEOUT with progress."""
        self.write_checkpoint(current_task="TASK-2A-001", task_status="FIX_REQUIRED")
        self.write_task("TASK-2A-001", planning_required="NO", risk="HIGH")

        code_file = self.repo_root / "src" / "index.ts"
        code_file.parent.mkdir(parents=True, exist_ok=True)
        code_file.write_text("// initial\n", encoding="utf-8")
        run_git(self.repo_root, "add", ".")
        run_git(self.repo_root, "commit", "-m", "Commit index.ts")

        self.config.enable_live_agents = True
        runner = SupervisorRunner(self.config)

        def mock_timed_out_with_progress(*args, **kwargs):
            code_file.write_text("// partially modified before timeout\n", encoding="utf-8")
            return AgentResult(
                run_id=kwargs["run_id"], started_at=datetime.now(timezone.utc).isoformat(),
                role=Role.IMPLEMENTATION,
                provider="antigravity",
                task_id="TASK-2A-001",
                exit_code=124,
                stdout='{"type":"tool_call","tool":"edit_file","target":"src/index.ts"}\n',
                stderr="Execution reached timeout limit",
                duration_seconds=900.0,
                success=False,
                process_completed=False,
                provider_reported_success=False,
                timed_out=True,
                timeout_kind="hard_limit",
                events_received=1,
                last_step_index=3,
                last_tool_name="edit_file",
                last_tool_target="src/index.ts",
                last_activity_at="2026-10-06T00:00:00Z",
                observable_repo_effect=True,
            )

        with patch.object(
            runner.antigravity_adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "C:/agy/bin/agy.exe", "is_headless": True},
        ), patch.object(runner.antigravity_adapter, "invoke", side_effect=mock_timed_out_with_progress):
            state, stop_report = runner.run_step(execute_agents=True)

            self.assertIsNotNone(stop_report)
            self.assertEqual(stop_report.state, WorkflowState.AGENT_EXECUTION_TIMEOUT)
            self.assertIn("agent made observable progress but did not complete", stop_report.reason)
            self.assertTrue(stop_report.evidence["observable_repo_effect"])
            self.assertEqual(stop_report.evidence["timeout_kind"], "hard_limit")
            self.assertEqual(stop_report.evidence["last_tool_name"], "edit_file")

            # Check that last_agent_run.json contains the rich diagnostics
            last_run_file = self.config.runtime_dir / "last_agent_run.json"
            self.assertTrue(last_run_file.exists())
            data = json.loads(last_run_file.read_text(encoding="utf-8"))
            self.assertTrue(data["timed_out"])
            self.assertEqual(data["timeout_kind"], "hard_limit")
            self.assertEqual(data["last_tool_name"], "edit_file")
            self.assertIn("edit_file", data["stdout_snippet"])
            self.assertTrue(data["delta"]["observable_effect"])

    def test_productive_timeout_does_not_consume_fix_cycles_budget(self):
        """A productive timeout must NOT increment fix_cycles or impl_attempts failure budget."""
        self.write_checkpoint(current_task="TASK-2A-001", task_status="FIX_REQUIRED")
        self.write_task("TASK-2A-001", planning_required="NO", risk="HIGH")

        code_file = self.repo_root / "src" / "index.ts"
        code_file.parent.mkdir(parents=True, exist_ok=True)
        code_file.write_text("// initial\n", encoding="utf-8")
        run_git(self.repo_root, "add", ".")
        run_git(self.repo_root, "commit", "-m", "Commit index.ts")

        self.config.enable_live_agents = True
        runner = SupervisorRunner(self.config)
        self.assertEqual(runner.fix_cycles.get("TASK-2A-001", 0), 0)

        def mock_timeout(*args, **kwargs):
            code_file.write_text("// partial changes\n", encoding="utf-8")
            return AgentResult(
                run_id=kwargs["run_id"], started_at=datetime.now(timezone.utc).isoformat(),
                role=Role.IMPLEMENTATION,
                provider="antigravity",
                task_id="TASK-2A-001",
                exit_code=124,
                stdout="",
                stderr="",
                duration_seconds=900.0,
                success=False,
                process_completed=False,
                provider_reported_success=False,
                timed_out=True,
                timeout_kind="hard_limit",
                observable_repo_effect=True,
            )

        with patch.object(
            runner.antigravity_adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "C:/agy/bin/agy.exe", "is_headless": True},
        ), patch.object(runner.antigravity_adapter, "invoke", side_effect=mock_timeout):
            runner.run_step(execute_agents=True)
            # Budget must NOT have been incremented
            self.assertEqual(runner.fix_cycles.get("TASK-2A-001", 0), 0)

    def test_idle_timeout_without_changes_reported_as_timeout(self):
        """Idle timeout with no repository changes is classified as AGENT_EXECUTION_TIMEOUT stall."""
        self.write_checkpoint(current_task="TASK-2A-001", task_status="FIX_REQUIRED")
        self.write_task("TASK-2A-001", planning_required="NO", risk="HIGH")

        self.config.enable_live_agents = True
        runner = SupervisorRunner(self.config)

        def mock_idle_stall(*args, **kwargs):
            return AgentResult(
                run_id=kwargs["run_id"], started_at=datetime.now(timezone.utc).isoformat(),
                role=Role.IMPLEMENTATION,
                provider="antigravity",
                task_id="TASK-2A-001",
                exit_code=124,
                stdout="",
                stderr="Process stalled",
                duration_seconds=180.0,
                success=False,
                process_completed=False,
                provider_reported_success=False,
                timed_out=True,
                timeout_kind="idle",
                observable_repo_effect=False,
            )

        with patch.object(
            runner.antigravity_adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "C:/agy/bin/agy.exe", "is_headless": True},
        ), patch.object(runner.antigravity_adapter, "invoke", side_effect=mock_idle_stall):
            state, stop_report = runner.run_step(execute_agents=True)
            self.assertIsNotNone(stop_report)
            self.assertEqual(stop_report.state, WorkflowState.AGENT_EXECUTION_TIMEOUT)
            self.assertIn("agent timed out (idle) without producing observable changes", stop_report.reason)
            self.assertFalse(stop_report.evidence["observable_repo_effect"])

    def test_secret_redaction_in_stream_and_stderr(self):
        """Secrets matching credential patterns must be redacted in stream and stderr files."""
        adapter = AntigravityAdapter(self.config)
        secret_line = '{"type":"log","token":"ya29.a0AfH6SMC1234567890abcdef"}\n'
        synthetic_bearer = "test-bearer-redaction-fixture-1234567890"
        stderr_line = f'Authorization: bearer {synthetic_bearer}\n'

        proc = MagicMock()
        proc.pid = 9999
        proc.returncode = 0
        proc.poll.side_effect = [None, 0]
        proc.stdout.readline.side_effect = [secret_line, ""]
        proc.stderr.readline.side_effect = [stderr_line, ""]

        with patch.object(
            adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "C:/agy/bin/agy.exe", "is_headless": True},
        ), patch("subprocess.Popen", return_value=proc):
            adapter.invoke(Role.IMPLEMENTATION, "TASK-2A-001")

            stream_file = self.config.runtime_dir / "current_agent_stream.jsonl"
            stderr_file = self.config.runtime_dir / "current_agent_stderr.log"

            stream_text = stream_file.read_text(encoding="utf-8")
            self.assertNotIn("ya29.a0AfH6SMC1234567890abcdef", stream_text)
            self.assertIn("<redacted-oauth-token>", stream_text)

            stderr_text = stderr_file.read_text(encoding="utf-8")
            self.assertNotIn(synthetic_bearer, stderr_text)
            self.assertIn("<redacted>", stderr_text)

    def test_continuation_prompt_construction(self):
        """build_prompt with dirty_files includes Continuation from Existing Working Tree section."""
        adapter = AntigravityAdapter(self.config)
        prompt = adapter.build_prompt(
            Role.IMPLEMENTATION,
            "TASK-2A-001",
            is_fix=True,
            review_blockers="- B-1: fix purchase invoice calculation",
            dirty_files=["backend/src/services/purchase.ts", "backend/src/models/purchase.ts"],
        )

        self.assertIn("### Continuation from Existing Working Tree (CRITICAL)", prompt)
        self.assertIn("- `backend/src/services/purchase.ts`", prompt)
        self.assertIn("- `backend/src/models/purchase.ts`", prompt)
        self.assertIn("Inspect the existing partial implementation and working tree diff first", prompt)
        self.assertIn("Preserve valid completed work", prompt)
class TestModelSelectionAndCostOptimization(BaseSupervisorTestCase):
    """Test cost and latency optimization, 3.7-flash-medium defaults, and VERY_HIGH_RISK predicate."""

    def test_low_implementation_selects_37_flash_medium(self):
        """LOW risk implementation selects gemini_implementation with gemini-3.7-flash-medium / medium."""
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", risk="LOW", difficulty="3/10", planning_required="NO")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.model_selection.profile.name, "gemini_implementation")
        self.assertEqual(state.model_selection.profile.model, "gemini-3.7-flash-medium")
        self.assertEqual(state.model_selection.effort, "medium")

    def test_medium_implementation_selects_37_flash_medium(self):
        """MEDIUM risk implementation selects gemini_implementation with gemini-3.7-flash-medium / medium."""
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task("TASK-01-001", risk="MEDIUM", difficulty="5/10", planning_required="NO")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.model_selection.profile.name, "gemini_implementation")
        self.assertEqual(state.model_selection.profile.model, "gemini-3.7-flash-medium")
        self.assertEqual(state.model_selection.effort, "medium")

    def test_high_difficulty_8_ordinary_implementation_selects_37_flash_medium(self):
        """Ordinary HIGH risk task with difficulty 8/10 does not meet VERY_HIGH_RISK and selects gemini-3.7-flash-medium."""
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task(
            "TASK-01-001",
            risk="HIGH",
            difficulty="8/10",
            title="Billing worksheet, customer context and saved-sale paper recording",
            planning_required="YES",
            execution_mode="PLANNED_IMPLEMENTATION",
        )
        (self.config.plans_dir / "TASK-01-001-plan.md").write_text("# Plan\nDetails...", encoding="utf-8")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.model_selection.profile.name, "gemini_implementation")
        self.assertEqual(state.model_selection.profile.model, "gemini-3.7-flash-medium")
        self.assertEqual(state.model_selection.effort, "medium")

    def test_high_difficulty_8_fix_required_continuation_selects_37_flash_medium(self):
        """HIGH difficulty 8 task in FIX_REQUIRED continuation selects gemini_fix with gemini-3.7-flash-medium / medium."""
        self.write_checkpoint(current_task="TASK-2A-001", task_status="FIX_REQUIRED")
        self.write_task(
            "TASK-2A-001",
            risk="HIGH",
            difficulty="8/10",
            title="Billing worksheet, customer context and saved-sale paper recording",
            planning_required="NO",
        )
        state = derive_workflow_state(self.config, fix_cycle=0)
        self.assertEqual(state.state, WorkflowState.FIX_REQUIRED)
        self.assertEqual(state.model_selection.profile.name, "gemini_fix")
        self.assertEqual(state.model_selection.profile.model, "gemini-3.7-flash-medium")
        self.assertEqual(state.model_selection.effort, "medium")
        self.assertIn("does not meet VERY_HIGH_RISK threshold", state.model_selection.selection_reason)

    def test_high_difficulty_9_qualifying_selects_38_flash_high(self):
        """HIGH risk task with difficulty >= 9 qualifies for gemini-3.8-flash-high."""
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task(
            "TASK-01-001",
            risk="HIGH",
            difficulty="9/10",
            title="Distributed consensus state reconciliation",
            planning_required="YES",
            execution_mode="PLANNED_IMPLEMENTATION",
        )
        (self.config.plans_dir / "TASK-01-001-plan.md").write_text("# Plan\nDetails...", encoding="utf-8")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.model_selection.profile.name, "gemini_high_risk_implementation")
        self.assertEqual(state.model_selection.profile.model, "gemini-3.8-flash-high")
        self.assertEqual(state.model_selection.effort, "high")

    def test_schema_migration_critical_high_task_selects_38_flash_high(self):
        """HIGH risk task involving schema/database migrations qualifies for gemini-3.8-flash-high."""
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task(
            "TASK-01-001",
            risk="HIGH",
            difficulty="7/10",
            title="Execute database schema migration for customer balance table",
            planning_required="YES",
            execution_mode="PLANNED_IMPLEMENTATION",
        )
        (self.config.plans_dir / "TASK-01-001-plan.md").write_text("# Plan\nDetails...", encoding="utf-8")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.model_selection.profile.name, "gemini_high_risk_implementation")
        self.assertEqual(state.model_selection.profile.model, "gemini-3.8-flash-high")
        self.assertEqual(state.model_selection.effort, "high")

    def test_auth_security_critical_high_task_selects_38_flash_high(self):
        """HIGH risk task touching authentication/security boundary qualifies for gemini-3.8-flash-high."""
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task(
            "TASK-01-001",
            risk="HIGH",
            difficulty="7/10",
            title="Implement authentication boundary and credential encryption",
            planning_required="YES",
            execution_mode="PLANNED_IMPLEMENTATION",
        )
        (self.config.plans_dir / "TASK-01-001-plan.md").write_text("# Plan\nDetails...", encoding="utf-8")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.model_selection.profile.name, "gemini_high_risk_implementation")
        self.assertEqual(state.model_selection.profile.model, "gemini-3.8-flash-high")
        self.assertEqual(state.model_selection.effort, "high")

    def test_irreversible_financial_mutation_critical_high_task_selects_38_flash_high(self):
        """HIGH risk task with irreversible financial ledger or payment posting mutation qualifies for gemini-3.8-flash-high."""
        self.write_checkpoint(current_task="TASK-01-001", task_status="READY")
        self.write_task(
            "TASK-01-001",
            risk="HIGH",
            difficulty="7/10",
            title="Financial ledger mutation and payment posting integrity",
            planning_required="YES",
            execution_mode="PLANNED_IMPLEMENTATION",
        )
        (self.config.plans_dir / "TASK-01-001-plan.md").write_text("# Plan\nDetails...", encoding="utf-8")
        state = derive_workflow_state(self.config)
        self.assertEqual(state.model_selection.profile.name, "gemini_high_risk_implementation")
        self.assertEqual(state.model_selection.profile.model, "gemini-3.8-flash-high")
        self.assertEqual(state.model_selection.effort, "high")

    def test_permission_denial_does_not_escalate_model(self):
        """A permission denial does NOT increment fix cycle or escalate model profile."""
        self.write_checkpoint(current_task="TASK-2A-001", task_status="FIX_REQUIRED")
        self.write_task("TASK-2A-001", risk="HIGH", difficulty="8/10", title="Billing worksheet")
        self.config.enable_live_agents = True
        runner = SupervisorRunner(self.config)

        # Before run
        state_before = runner.get_status()
        self.assertEqual(state_before.model_selection.profile.model, "gemini-3.7-flash-medium")

        with patch.object(
            runner.antigravity_adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "agy", "is_headless": True},
        ), patch.object(
            runner.antigravity_adapter,
            "get_available_models",
            return_value=(True, ["gemini-3.7-flash-medium", "gemini-3.8-flash-high"], None),
        ), patch.object(
            runner.antigravity_adapter,
            "invoke",
            side_effect=lambda *args, **kwargs: AgentResult(
                run_id=kwargs["run_id"], started_at=datetime.now(timezone.utc).isoformat(),
                role=Role.IMPLEMENTATION,
                task_id="TASK-2A-001",
                exit_code=0,
                stdout='{"type":"result","status":"SUCCESS","denied_actions":["command / RunCommand"]}',
                stderr="",
                duration_seconds=5.0,
                success=False,
                process_completed=True,
                provider_reported_success=False,
                soft_permission_denial=True,
                denied_actions=["command / RunCommand"],
                error_message="AGENT_PERMISSION_REQUIRED: Headless auto-denial",
                provider="antigravity",
                model_name="gemini-3.7-flash-medium",
                effort="medium",
            ),
        ):
            _, stop_report = runner.run_step(execute_agents=True)
            self.assertEqual(stop_report.state, WorkflowState.AGENT_PERMISSION_REQUIRED)

        # Next turn check
        state_after = runner.get_status()
        self.assertEqual(state_after.model_selection.profile.model, "gemini-3.7-flash-medium")
        self.assertEqual(state_after.model_selection.profile.name, "gemini_fix")
        self.assertEqual(runner.fix_cycles.get("TASK-2A-001", 0), 0)

    def test_productive_timeout_does_not_escalate_model(self):
        """A productive timeout does NOT consume fix cycle budget or escalate model profile."""
        self.write_checkpoint(current_task="TASK-2A-001", task_status="FIX_REQUIRED")
        self.write_task("TASK-2A-001", risk="HIGH", difficulty="8/10", title="Billing worksheet")
        code_file = self.repo_root / "src" / "index.ts"
        code_file.parent.mkdir(parents=True, exist_ok=True)
        code_file.write_text("// original\n", encoding="utf-8")
        run_git(self.repo_root, "add", ".")
        run_git(self.repo_root, "commit", "-m", "Commit index.ts")

        self.config.enable_live_agents = True
        runner = SupervisorRunner(self.config)

        def mock_timeout(*args, **kwargs):
            code_file.write_text("// partial changes\n", encoding="utf-8")
            return AgentResult(
                run_id=kwargs["run_id"], started_at=datetime.now(timezone.utc).isoformat(),
                role=Role.IMPLEMENTATION,
                provider="antigravity",
                task_id="TASK-2A-001",
                exit_code=124,
                stdout="",
                stderr="Timeout",
                duration_seconds=900.0,
                success=False,
                process_completed=False,
                provider_reported_success=False,
                timed_out=True,
                timeout_kind="hard_limit",
                observable_repo_effect=True,
            )

        with patch.object(
            runner.antigravity_adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "agy", "is_headless": True},
        ), patch.object(
            runner.antigravity_adapter,
            "get_available_models",
            return_value=(True, ["gemini-3.7-flash-medium", "gemini-3.8-flash-high"], None),
        ), patch.object(runner.antigravity_adapter, "invoke", side_effect=mock_timeout):
            _, stop_report = runner.run_step(execute_agents=True)
            self.assertEqual(stop_report.state, WorkflowState.AGENT_EXECUTION_TIMEOUT)

        state_after = runner.get_status()
        self.assertEqual(state_after.model_selection.profile.model, "gemini-3.7-flash-medium")
        self.assertEqual(runner.fix_cycles.get("TASK-2A-001", 0), 0)

    def test_quota_auth_failure_does_not_escalate_model(self):
        """A quota or authentication failure does NOT escalate model profile."""
        self.write_checkpoint(current_task="TASK-2A-001", task_status="FIX_REQUIRED")
        self.write_task("TASK-2A-001", risk="HIGH", difficulty="8/10", title="Billing worksheet")
        self.config.enable_live_agents = True
        runner = SupervisorRunner(self.config)

        with patch.object(
            runner.antigravity_adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "agy", "is_headless": True},
        ), patch.object(
            runner.antigravity_adapter,
            "get_available_models",
            return_value=(True, ["gemini-3.7-flash-medium", "gemini-3.8-flash-high"], None),
        ), patch.object(
            runner.antigravity_adapter,
            "invoke",
            side_effect=lambda *args, **kwargs: AgentResult(
                run_id=kwargs["run_id"], started_at=datetime.now(timezone.utc).isoformat(),
                role=Role.IMPLEMENTATION,
                task_id="TASK-2A-001",
                exit_code=1,
                stdout="",
                stderr="429 Too Many Requests: quota exceeded",
                duration_seconds=1.0,
                success=False,
                error_message="PROVIDER_QUOTA_OR_AUTH_REQUIRED: Quota exceeded",
                auth_or_quota_failure=True,
                provider="antigravity",
                model_name="gemini-3.7-flash-medium",
                effort="medium",
            ),
        ):
            _, stop_report = runner.run_step(execute_agents=True)
            self.assertEqual(stop_report.state, WorkflowState.PROVIDER_QUOTA_OR_AUTH_REQUIRED)

        state_after = runner.get_status()
        self.assertEqual(state_after.model_selection.profile.model, "gemini-3.7-flash-medium")
        self.assertEqual(runner.fix_cycles.get("TASK-2A-001", 0), 0)

    def test_genuine_capability_failure_escalates_to_gemini_escalation(self):
        """When an observable fix attempt has completed and senior review requires another fix cycle, model escalates to gemini_escalation."""
        self.write_checkpoint(current_task="TASK-01-001", task_status="FIX_REQUIRED")
        self.write_task("TASK-01-001", risk="HIGH", difficulty="8/10", title="Billing worksheet")
        (self.config.reports_dir / "TASK-01-001-implementation.md").write_text("# Report\nStatus: COMPLETE\n", encoding="utf-8")
        (self.config.reviews_dir / "TASK-01-001-review.md").write_text("# Review\nDecision: CHANGES_REQUESTED\n- BLOCKER: Logic bug\n", encoding="utf-8")

        # Simulate fix_cycle == 1 (one full previous cycle completed)
        state = derive_workflow_state(self.config, fix_cycle=1)
        self.assertEqual(state.state, WorkflowState.FIX_REQUIRED)
        self.assertEqual(state.model_selection.profile.name, "gemini_escalation")
        self.assertEqual(state.model_selection.profile.model, "gemini-3.8-flash-high")
        self.assertEqual(state.model_selection.effort, "high")
        self.assertTrue(state.model_selection.is_escalated)

    def test_task_2a_001_dry_run_selects_37_flash_medium(self):
        """Current TASK-2A-001 dry-run deterministically selects gemini_fix with gemini-3.7-flash-medium."""
        self.write_checkpoint(current_task="TASK-2A-001", task_status="FIX_REQUIRED")
        self.write_task(
            "TASK-2A-001",
            risk="HIGH",
            difficulty="8/10",
            title="Billing worksheet, customer context and saved-sale paper recording",
            planning_required="YES",
            execution_mode="PLANNED_IMPLEMENTATION",
        )
        runner = SupervisorRunner(self.config)
        state, stop_report = runner.run_step(dry_run=True)
        self.assertIsNone(stop_report)
        self.assertEqual(state.model_selection.provider, "Antigravity")
        self.assertEqual(state.model_selection.profile.name, "gemini_fix")
        self.assertEqual(state.model_selection.profile.model, "gemini-3.7-flash-medium")
        self.assertEqual(state.model_selection.effort, "medium")


class TestDevServerProhibitionAndBoundedVerification(BaseSupervisorTestCase):
    """Test persistent dev server prohibition, bounded verification guidance, and narrow permissions."""

    def test_implementation_prompt_prohibits_persistent_dev_servers_by_default(self):
        """Implementation and fix prompts must strictly prohibit persistent dev servers."""
        adapter = AntigravityAdapter(self.config)

        # Test DIRECT_IMPLEMENTATION
        prompt_impl = adapter.build_prompt(Role.IMPLEMENTATION, "TASK-01-001", is_fix=False)
        self.assertIn("Persistent Development Servers Strictly Prohibited", prompt_impl)
        self.assertIn("pnpm --dir backend run dev", prompt_impl)
        self.assertIn("pnpm --dir frontend run dev", prompt_impl)
        self.assertIn("npm run dev", prompt_impl)
        self.assertIn("Headless execution will auto-deny persistent dev-server commands", prompt_impl)
        self.assertIn("Do NOT start persistent development servers", prompt_impl)

        # Test FIX_REQUIRED
        prompt_fix = adapter.build_prompt(Role.IMPLEMENTATION, "TASK-01-001", is_fix=True)
        self.assertIn("Persistent Development Servers Strictly Prohibited", prompt_fix)
        self.assertIn("pnpm --dir backend run dev", prompt_fix)
        self.assertIn("pnpm --dir frontend run dev", prompt_fix)
        self.assertIn("npm run dev", prompt_fix)
        self.assertIn("Headless execution will auto-deny persistent dev-server commands", prompt_fix)
        self.assertIn("Do NOT start persistent development servers", prompt_fix)

    def test_successful_bounded_verification_leads_to_evidence_report(self):
        """Prompt instructs agent that successful bounded checks lead directly to updating the implementation report."""
        adapter = AntigravityAdapter(self.config)

        prompt = adapter.build_prompt(
            Role.IMPLEMENTATION, "TASK-2A-001", is_fix=True,
            completed_verifications=[
                "backend build (`pnpm --dir backend run build`) PASSED on fixture revision",
                "targeted Playwright tests: 18/18 passed on fixture revision",
            ],
        )
        self.assertIn("Existing Verification Evidence (Validate Before Reuse)", prompt)
        self.assertIn("backend build (`pnpm --dir backend run build`) PASSED", prompt)
        self.assertIn("targeted Playwright tests: 18/18 passed on fixture revision", prompt)
        self.assertIn("verify their recorded content/target and continued validity", prompt)
        self.assertIn("record the existing successful evidence in the implementation report and finish", prompt)
        self.assertIn("STOP further exploratory verification immediately", prompt)
        self.assertIn("Proceed directly to the Workflow v2 implementation-evidence/report step", prompt)

    def test_shared_command_policy_covers_implementation_fix_and_continuations(self):
        adapter = AntigravityAdapter(self.config)
        for is_fix in (False, True):
            for continuation in (False, True):
                with self.subTest(is_fix=is_fix, continuation=continuation):
                    prompt = adapter.build_prompt(
                        Role.IMPLEMENTATION, "TASK-01-001", is_fix=is_fix,
                        dirty_files=["backend/src/handler.ts"] if continuation else None,
                    )
                    self.assertEqual(prompt.count("COMMAND EXECUTION RULE:"), 1)
                    self.assertIn("Run every shell verification command as a separate `run_command` invocation", prompt)
                    self.assertIn("Never chain commands using `;`, `&&`, `||`, pipes (`|`), shell command grouping, or equivalent multi-command shell syntax", prompt)
                    self.assertIn("Invoke each allowed backend build, backend test, frontend typecheck, Playwright, lint, or git inspection command independently", prompt)
                    self.assertIn("Do not rerun already-passed, still-valid checks merely to create a combined/final verification command", prompt)
                    self.assertIn("After a relevant code change, rerun only the affected required bounded verification, individually", prompt)
                    self.assertIn("retain unaffected valid evidence", prompt)
                    self.assertIn("Missing, failed, or unverifiable required evidence still requires an individual bounded check", prompt)
                    self.assertIn("recorded content/revision and runtime target match the current relevant content", prompt)
                    self.assertIn("no subsequent relevant change invalidates that evidence", prompt)
                    self.assertIn("After a permission stop or timeout, inspect the current dirty worktree", prompt)
                    self.assertIn("preserve valid partial work, and continue from it rather than restarting the task", prompt)
                    self.assertIn("Do not broaden permissions, use destructive git, push/merge/deploy, or access configured production databases/VPS", prompt)
                    self.assertIn("Use built-in workspace discovery tools ONLY", prompt)
                    self.assertIn("Do NOT start persistent development servers", prompt)
                    self.assertIn("the supervisor has a bounded, managed server lifecycle", prompt)
                    self.assertNotIn("--dangerously-skip-permissions", prompt)
                    self.assertNotIn("command(*)", prompt)

    def test_task_id_alone_does_not_assert_previous_checks_passed(self):
        adapter = AntigravityAdapter(self.config)
        for is_fix in (False, True):
            with self.subTest(is_fix=is_fix):
                prompt = adapter.build_prompt(Role.IMPLEMENTATION, "TASK-2A-001", is_fix=is_fix)
                self.assertNotIn("PASSED", prompt)
                self.assertNotIn("39/39 passed", prompt)
                self.assertNotIn("15/15 passed", prompt)
                self.assertNotIn("The supervisor confirms", prompt)
                self.assertIn("Inspect the existing report and working tree diff before relying on earlier results", prompt)

    def test_run_dev_not_in_allowed_command_families(self):
        """The bounded verification command families must only allow build, typecheck, targeted tests, Playwright, git diff/status."""
        adapter = AntigravityAdapter(self.config)
        prompt = adapter.build_prompt(Role.IMPLEMENTATION, "TASK-01-001", is_fix=True)

        # Extract bounded verification section
        self.assertIn("Bounded Verification & Early Completion Rules", prompt)
        # Verify allowed families
        self.assertIn("build (`pnpm --dir backend run build`, etc.)", prompt)
        self.assertIn("typecheck (`pnpm --dir frontend run typecheck`, etc.)", prompt)
        self.assertIn("targeted tests", prompt)
        self.assertIn("Playwright tests", prompt)
        self.assertIn("git diff/check/status", prompt)

        # Ensure run dev is NOT among permitted operations
        allowed_segment = prompt[prompt.index("Bounded Verification & Early Completion Rules"):prompt.index("### Required Behavior")]
        self.assertNotIn("run dev", allowed_segment.split("Do NOT attempt persistent server startup")[0])

    def test_current_permission_architecture_remains_narrow(self):
        """Permissions must never be broadened to wildcard or dangerous skips, and run dev auto-denial triggers AGENT_PERMISSION_REQUIRED."""
        adapter = AntigravityAdapter(self.config)

        # 1. No dangerous skips
        proc = MagicMock()
        proc.pid = 9999
        proc.returncode = 0
        proc.poll.side_effect = [None, 0]
        proc.stdout.readline.side_effect = ['{"type":"result"}\n', ""]
        proc.stderr.readline.side_effect = [""]

        with patch.object(
            adapter,
            "check_availability",
            return_value={"available": True, "status": "READY", "binary": "C:/agy/bin/agy.exe", "is_headless": True},
        ), patch("subprocess.Popen", return_value=proc) as mock_subproc:
            adapter.invoke(Role.IMPLEMENTATION, "TASK-2A-001", prompt="test")
            call_cmd = mock_subproc.call_args[0][0]
            self.assertNotIn("--dangerously-skip-permissions", call_cmd)
            self.assertNotIn("command(*)", " ".join(call_cmd))

        # 2. auto-denial of dev server is caught by soft permission denial check
        dev_server_denial = (
            'permission check failed for command "pnpm --dir backend run dev": '
            'user denied permission to run command:\npnpm --dir backend run dev\n'
            'Do not attempt to circumvent this denial by rephrasing the command'
        )
        has_denial, actions = adapter.check_for_permission_denials(dev_server_denial)
        self.assertTrue(has_denial)


if __name__ == "__main__":
    unittest.main()



