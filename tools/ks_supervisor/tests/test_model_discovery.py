"""Fresh pre-launch inventory probes distinguish infrastructure failure from model absence."""
from contextlib import contextmanager
from datetime import datetime, timezone
import subprocess
from unittest.mock import patch

from tools.ks_supervisor.adapters.antigravity import AntigravityAdapter
from tools.ks_supervisor.adapters.codex import CodexAdapter
from tools.ks_supervisor.models import get_configured_profile, validate_profile_availability
from tools.ks_supervisor.repo import capture_repository_baseline
from tools.ks_supervisor.runner import SupervisorRunner
from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase
from tools.ks_supervisor.types import AgentResult, Role, WorkflowState


class TestModelDiscovery(BaseSupervisorTestCase):
    model = "gemini-3.7-flash-medium"

    def setUp(self):
        super().setUp()
        self.task_id = "TASK-2A-001"
        self.write_checkpoint(current_task=self.task_id, task_status="FIX_REQUIRED")
        self.write_task(self.task_id, status="FIX_REQUIRED", risk="HIGH", difficulty="8/10", title="Billing worksheet")
        self.config.antigravity_bin = "agy-fixture"
        self.config.enable_live_agents = True
        self.runner = SupervisorRunner(self.config)
        self.profile = get_configured_profile("gemini_fix", self.config)
        self.real_subprocess_run = subprocess.run
        self.probes = []
        self.gemini = patch.object(self.runner.antigravity_adapter, "invoke", side_effect=self.agent)
        self.gemini_mock = self.gemini.start()
        self.addCleanup(self.gemini.stop)
        codex = patch.object(self.runner.codex_adapter, "invoke", side_effect=AssertionError("Unexpected Codex fallback"))
        self.codex_mock = codex.start()
        self.addCleanup(codex.stop)

    def agent(self, *args, **kwargs):
        # Launch permission is tested without completing a task or calling a provider.
        return AgentResult(role=Role.IMPLEMENTATION, task_id=self.task_id, run_id=kwargs["run_id"],
                           provider="antigravity", model_name=kwargs["profile"].model, effort=kwargs["profile"].effort,
                           started_at=datetime.now(timezone.utc).isoformat(), success=False, exit_code=1,
                           process_completed=True, provider_reported_success=False, stdout="", stderr="fixture stop",
                           duration_seconds=1)

    def inventory(self, stdout=None, returncode=0, stderr=""):
        return subprocess.CompletedProcess(["agy-fixture", "models"], returncode,
                                           stdout if stdout is not None else f"{self.model}  Gemini 3.7 Flash (Medium)\n", stderr)

    @contextmanager
    def probe(self, response):
        def run(argv, **kwargs):
            if argv == ["agy-fixture", "models"]:
                self.probes.append(kwargs)
                if isinstance(response, Exception):
                    raise response
                return response(kwargs) if callable(response) else response
            return self.real_subprocess_run(argv, **kwargs)
        with patch("tools.ks_supervisor.adapters.antigravity.shutil.which", return_value="agy-fixture"), \
                patch.object(AntigravityAdapter, "check_availability", return_value={"available": True}), \
                patch("tools.ks_supervisor.adapters.antigravity.subprocess.run", side_effect=run), \
                patch("tools.ks_supervisor.runner.validate_profile_availability", side_effect=validate_profile_availability):
            yield

    def assert_prelaunch_stop(self, expected):
        before = capture_repository_baseline(self.config, self.task_id)
        budgets = (dict(self.runner.impl_attempts), dict(self.runner.fix_cycles), dict(self.runner.planner_attempts))
        state, stop = self.runner.run_step(execute_agents=True)
        self.assertEqual(stop.state, expected)
        self.assertEqual(state.state, WorkflowState.FIX_REQUIRED)
        self.gemini_mock.assert_not_called()
        self.codex_mock.assert_not_called()
        self.assertIsNone(self.runner.current_invocation)
        after = capture_repository_baseline(self.config, self.task_id)
        for field in ("branch", "head_sha", "porcelain", "file_hashes", "artifact_hashes", "staged_files"):
            self.assertEqual(getattr(before, field), getattr(after, field))
        self.assertEqual(budgets, (self.runner.impl_attempts, self.runner.fix_cycles, self.runner.planner_attempts))
        next_profile = self.runner.get_status().model_selection.profile
        self.assertEqual((next_profile.name, next_profile.provider, next_profile.model),
                         ("gemini_fix", "antigravity", self.model))
        return stop

    def test_successful_inventory_permits_selected_model_launch(self):
        with self.probe(self.inventory()):
            self.runner.run_step(execute_agents=True)
        self.gemini_mock.assert_called_once()
        self.assertEqual(self.gemini_mock.call_args.kwargs["profile"].model, self.model)
        self.assertEqual(self.probes[0]["timeout"], 60)
        self.codex_mock.assert_not_called()

    def test_probe_longer_than_old_bound_fits_new_bound_without_sleep(self):
        def takes_35_seconds(kwargs):
            if kwargs["timeout"] < 35:
                raise subprocess.TimeoutExpired(["agy-fixture", "models"], kwargs["timeout"])
            return self.inventory()
        with self.probe(takes_35_seconds):
            ok, message = validate_profile_availability(self.profile, self.config)
        self.assertTrue(ok, message)
        self.assertEqual(self.probes[0]["timeout"], 60)

    def test_discovery_timeout_stops_without_launch_mutation_or_escalation(self):
        timeout = subprocess.TimeoutExpired(["agy-fixture", "models"], 60, output=self.model)
        with self.probe(timeout):
            stop = self.assert_prelaunch_stop(WorkflowState.MODEL_DISCOVERY_TIMEOUT)
        self.assertIn("model availability could not be determined", stop.reason)
        self.assertNotIn("MODEL_NOT_AVAILABLE", stop.reason)
        self.assertIn("Do not change model profile solely because discovery timed out", stop.recommended_next_action)
        self.assertNotIn("Install", stop.recommended_next_action)
        self.assertNotIn("authenticate", stop.recommended_next_action)

    def test_successful_inventory_missing_model_is_only_availability_failure(self):
        with self.probe(self.inventory(stdout="gemini-other-model\n")):
            stop = self.assert_prelaunch_stop(WorkflowState.MODEL_NOT_AVAILABLE)
        self.assertIn("not in available models list", stop.reason)

    def test_discovery_nonzero_exit_fails_closed(self):
        with self.probe(self.inventory(returncode=2, stderr="provider connection failed")):
            stop = self.assert_prelaunch_stop(WorkflowState.MODEL_DISCOVERY_FAILED)
        self.assertIn("exit code 2", stop.reason)

    def test_auth_quota_and_rate_limit_discovery_errors_preserve_classification(self):
        for message in ("authentication required", "quota exceeded", "429 Too Many Requests"):
            with self.subTest(message=message), self.probe(self.inventory(returncode=1, stderr=message)):
                stop = self.assert_prelaunch_stop(WorkflowState.PROVIDER_QUOTA_OR_AUTH_REQUIRED)
                self.assertIn("PROVIDER_QUOTA_OR_AUTH_REQUIRED", stop.reason)

    def test_discovery_os_error_is_not_model_absence(self):
        with self.probe(OSError("cannot execute provider CLI")):
            self.assert_prelaunch_stop(WorkflowState.MODEL_DISCOVERY_FAILED)

    def test_unavailable_cli_and_unknown_provider_are_not_inventory_absence(self):
        with patch.object(AntigravityAdapter, "check_availability", return_value={"available": False, "error": "CLI missing"}), \
                patch("tools.ks_supervisor.runner.validate_profile_availability", side_effect=validate_profile_availability):
            self.assert_prelaunch_stop(WorkflowState.MODEL_DISCOVERY_FAILED)
        self.profile.provider = "unknown-provider"
        ok, reason = validate_profile_availability(self.profile, self.config)
        self.assertFalse(ok)
        self.assertTrue(reason.startswith("MODEL_DISCOVERY_FAILED:"))
        with patch.object(CodexAdapter, "check_availability", return_value={"available": False, "error": "CLI missing"}):
            ok, reason = validate_profile_availability(get_configured_profile("codex_reviewer", self.config), self.config)
        self.assertFalse(ok)
        self.assertTrue(reason.startswith("MODEL_DISCOVERY_FAILED:"))

    def test_configured_discovery_bound_does_not_change_other_limits(self):
        self.config.antigravity_model_discovery_timeout_seconds = 75
        with self.probe(self.inventory()):
            self.assertTrue(validate_profile_availability(self.profile, self.config)[0])
        self.assertEqual(self.probes[0]["timeout"], 75)
        self.assertEqual((self.config.doctor_timeout_seconds, self.config.agent_timeout_seconds,
                          self.config.agent_idle_timeout_seconds, self.config.get_agent_hard_timeout("HIGH"),
                          self.config.get_agent_hard_timeout("MEDIUM")), (30, 600, 180, 900, 600))

    def test_each_validation_refreshes_inventory_without_stale_cache(self):
        with self.probe(self.inventory()):
            self.assertTrue(validate_profile_availability(self.profile, self.config)[0])
        with self.probe(self.inventory(stdout="gemini-other-model\n")):
            ok, reason = validate_profile_availability(self.profile, self.config)
        self.assertFalse(ok)
        self.assertTrue(reason.startswith("MODEL_NOT_AVAILABLE:"))
        self.assertEqual(len(self.probes), 2)
