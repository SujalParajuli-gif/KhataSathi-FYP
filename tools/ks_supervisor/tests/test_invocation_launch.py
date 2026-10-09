"""Mocked Windows launch boundaries; never issue oversized or live agent calls."""
from contextlib import contextmanager, redirect_stdout
import io
import json
from pathlib import Path
import subprocess
from unittest.mock import MagicMock, patch

from tools.ks_supervisor.adapters.antigravity import invocation_size
from tools.ks_supervisor.cli import cmd_run
from tools.ks_supervisor.completion import report_completion_valid
from tools.ks_supervisor.permissions import CLI_PROJECT, CommandPermissions
from tools.ks_supervisor.runner import ACTION_FIX, SupervisorRunner
from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase
from tools.ks_supervisor.types import Role, WorkflowState
from tools.ks_supervisor.verification import VerificationEvidence, compact_verification_plan


class TestInvocationLaunch(BaseSupervisorTestCase):
    command = "pnpm --dir frontend exec playwright test tests/browser/spec.ts"

    def setUp(self):
        super().setUp()
        self.task_id = "TASK-2A-001"
        self.write_checkpoint(current_task=self.task_id, task_status="FIX_REQUIRED")
        self.write_task(self.task_id, status="FIX_REQUIRED", risk="HIGH", difficulty="8/10")
        spec = self.repo_root / "frontend/tests/browser/spec.ts"
        spec.parent.mkdir(parents=True)
        spec.write_text("// preserved spec\n")
        self.report = self.config.reports_dir / f"{self.task_id}-implementation.md"
        self.report.write_text("# Report\nCOMPLETE\nBlocker fixes\nB-5/B-7 evidence\n")
        self.review = self.config.reviews_dir / f"{self.task_id}-review.md"
        self.review.write_text("# Senior\n## Current targeted verification\nRun ID: senior-fixture\n"
                               "Decision: FIX REQUIRED\nRemaining blockers: B-5, B-7\n")
        home = self.repo_root / "fixture-home"
        settings = home / ".gemini/antigravity-cli/settings.json"
        self.policy_path = home / f".gemini/config/projects/{CLI_PROJECT}.json"
        settings.parent.mkdir(parents=True)
        self.policy_path.parent.mkdir(parents=True)
        settings.write_text('{}')
        self.policy_path.write_text(json.dumps({"id": CLI_PROJECT, "permissionGrants": {
            "permissionGrants": {"allow": [f"command({self.command})"]}}}))
        home_patch = patch("tools.ks_supervisor.permissions.Path.home", return_value=home)
        home_patch.start()
        self.addCleanup(home_patch.stop)
        self.runner = SupervisorRunner(self.config)
        self.adapter = self.runner.antigravity_adapter
        self.config.enable_live_agents = True
        self.evidence = VerificationEvidence(self.config, self.task_id)
        for state in ("ACTIVE", "DONE"):
            self.evidence.observe({"step_update": {"step_index": 1, "state": state, "tool_name": "run_command",
                "tool_info": {"parameters": {"CommandLine": self.command}, "output": "15 passed", "exit_code": 0}}}, "earlier-pass")

    def large_plan(self):
        plan = self.evidence.plan()
        item = plan["reusable_verification"][0]
        item["covered_files"] = {f"frontend/source-{i}.ts": f"{i:064x}" for i in range(2000)}
        item["target_sha256"] = "TARGET-FINGERPRINT"
        item["result_sha256"] = "RESULT-FINGERPRINT"
        plan["permission_policy"]["sources_sha256"] = {"private-policy-source": "POLICY-FINGERPRINT"}
        return plan

    @contextmanager
    def provider(self, error=None, exit_code=0):
        proc = MagicMock()
        proc.pid, proc.returncode = 9999, exit_code
        proc.poll.side_effect = [None, exit_code]
        proc.stdout.readline.side_effect = ['{"type":"result","usage":{}}\n', ""]
        proc.stderr.readline.side_effect = [""]
        original = subprocess.Popen
        calls = []
        def popen(argv, *args, **kwargs):
            if argv[0] != "agy-fixture":
                return original(argv, *args, **kwargs)
            calls.append(argv)
            if error:
                raise error
            return proc
        with patch.object(self.adapter, "check_availability", return_value={"available": True,
                         "binary": "agy-fixture", "is_headless": True}), \
                patch("tools.ks_supervisor.adapters.antigravity.sys.platform", "win32"), \
                patch("subprocess.Popen", side_effect=popen):
            yield calls

    def invoke(self, prompt):
        profile = self.runner.get_status().model_selection.profile
        return self.adapter.invoke(Role.IMPLEMENTATION, self.task_id, prompt=prompt,
                                   profile=profile, run_id="launch-fixture", action=ACTION_FIX)

    def protected(self):
        return {p: p.read_bytes() for root in (self.config.tasks_dir, self.config.reports_dir,
                self.config.reviews_dir, self.repo_root / "frontend") for p in root.rglob('*') if p.is_file()} | {
                    self.config.checkpoint_path: self.config.checkpoint_path.read_bytes(),
                    self.evidence.path: self.evidence.path.read_bytes(),
                    self.policy_path: self.policy_path.read_bytes()}

    def assert_preserved(self, before):
        for path, data in before.items():
            self.assertEqual(path.read_bytes(), data, str(path))
        self.assertEqual(self.runner.get_status().state, WorkflowState.FIX_REQUIRED)
        self.assertFalse(report_completion_valid(self.config, self.task_id, self.report))
        self.assertEqual(self.runner.fix_cycles, {})

    def test_large_maps_are_excluded_from_compact_prompt(self):
        plan = self.large_plan()
        prompt = self.adapter.build_prompt(Role.IMPLEMENTATION, self.task_id, is_fix=True,
                                          verification_plan=plan, run_id="compact-run")
        for value in ("covered_files", "source-1000.ts", "TARGET-FINGERPRINT", "RESULT-FINGERPRINT",
                      "POLICY-FINGERPRINT", "sources_sha256"):
            self.assertNotIn(value, prompt)
        for value in ("compact-run", self.command, "reusable", "Content identity valid", "check_id", "B-5, B-7"):
            self.assertIn(value, prompt)
        self.assertIn("Evidence validity is calculated by the supervisor", prompt)

    def test_full_frozen_plan_still_contains_complete_provenance(self):
        plan = self.large_plan()
        self.evidence.freeze("full-plan-run", plan)
        full = json.loads(self.evidence.plan_path.read_text())
        self.assertEqual(full["run_id"], "full-plan-run")
        self.assertEqual(full["plan"], plan)
        self.assertEqual(len(full["plan"]["reusable_verification"][0]["covered_files"]), 2000)

    def test_many_invalidation_paths_have_bounded_prompt_summary(self):
        plan = self.large_plan()
        item = dict(plan["reusable_verification"][0], status="required", authorized=True,
                    invalidated_by=[f"frontend/changed-{i}.ts" for i in range(2000)])
        plan["required_verification"] = [item]
        summary = compact_verification_plan(plan, "bounded-run")
        self.assertLess(len(json.dumps(summary)), 2000)
        self.assertIn("2000 covered inputs", summary["required_verification"][0]["reason"])
        self.assertNotIn("changed-1999.ts", json.dumps(summary))

    def test_normal_compacted_invocation_below_windows_bound_and_one_process(self):
        prompt = self.adapter.build_prompt(Role.IMPLEMENTATION, self.task_id, is_fix=True,
                                          verification_plan=self.large_plan(), run_id="launch-fixture")
        with self.provider() as calls:
            result = self.invoke(prompt)
        self.assertEqual(len(calls), 1)
        self.assertTrue(result.process_started)
        self.assertTrue(result.success)
        metrics = result.stream_summary["invocation_size"]
        self.assertEqual(metrics["serialized_argv_chars"], len(subprocess.list2cmdline(calls[0])))
        self.assertLess(metrics["serialized_argv_utf16_units"] + 1, metrics["configured_limit"])
        self.assertEqual((result.provider, result.model_name, result.effort),
                         ("antigravity", "gemini-3.7-flash-medium", "medium"))

    def test_over_limit_stops_before_subprocess_or_stream_file_changes(self):
        before = self.protected()
        self.config.runtime_dir.mkdir(parents=True, exist_ok=True)
        stream = self.config.runtime_dir / "current_agent_stream.jsonl"
        stream.write_text("preserved stream")
        with self.provider() as calls:
            result = self.invoke('quoted " text ' * 4000)
        self.assertEqual(calls, [])
        self.assertFalse(result.process_started)
        self.assertEqual(result.infrastructure_failure, WorkflowState.AGENT_INVOCATION_TOO_LARGE)
        self.assertEqual(stream.read_text(), "preserved stream")
        self.assert_preserved(before)
        size = result.stream_summary["invocation_size"]
        self.assertEqual(size["action"], ACTION_FIX)
        self.assertEqual(size["provider"], "antigravity")
        self.assertEqual(size["model"], "gemini-3.7-flash-medium")
        self.assertGreater(size["serialized_argv_chars"], size["configured_limit"])

    def test_windows_preflight_accounts_for_utf16_and_terminating_null(self):
        prompt = "\U0001f680" * 200
        argv = ["agy-fixture", "-p", prompt, "--mode", "accept-edits", "--project", CLI_PROJECT,
                "--model", "gemini-3.7-flash-medium", "--effort", "medium", "--output-format", "stream-json"]
        size = invocation_size(argv, prompt, 28000)
        self.config.antigravity_windows_command_line_limit_chars = size["serialized_argv_chars"] + 1
        with self.provider() as calls:
            result = self.invoke(prompt)
        self.assertEqual(calls, [])
        self.assertEqual(result.infrastructure_failure, WorkflowState.AGENT_INVOCATION_TOO_LARGE)
        self.assertGreater(size["serialized_argv_utf16_units"], size["serialized_argv_chars"])

    def test_configured_limit_cannot_remove_windows_safety_margin(self):
        self.config.antigravity_windows_command_line_limit_chars = 40000
        with self.provider() as calls:
            result = self.invoke("small prompt")
        self.assertEqual(calls, [])
        self.assertEqual(result.infrastructure_failure, WorkflowState.AGENT_INVOCATION_TOO_LARGE)

    def test_winerror_206_is_explicit_launch_failure(self):
        error = OSError("[WinError 206] The filename or extension is too long")
        error.winerror = 206
        before = self.protected()
        with self.provider(error=error) as calls:
            result = self.invoke("small prompt")
        self.assertEqual(len(calls), 1)
        self.assertFalse(result.process_started)
        self.assertEqual(result.infrastructure_failure, WorkflowState.AGENT_LAUNCH_FAILED)
        self.assertEqual(result.stream_summary["launch_winerror"], 206)
        self.assert_preserved(before)

    def test_runner_launch_failure_preserves_state_evidence_and_records_lifecycle(self):
        before = self.protected()
        with self.provider(error=OSError("[WinError 206] filename too long")) as calls:
            state, stop = self.runner.run_step(execute_agents=True)
        self.assertEqual(len(calls), 1)
        self.assertEqual(stop.state, WorkflowState.AGENT_LAUNCH_FAILED)
        self.assertEqual(state.state, WorkflowState.FIX_REQUIRED)
        self.assert_preserved(before)
        self.assertEqual(len(VerificationEvidence(self.config, self.task_id).plan()["reusable_verification"]), 1)
        telemetry = json.loads((self.config.runtime_dir / "last_agent_run.json").read_text())
        self.assertEqual(telemetry["infrastructure_failure"], "AGENT_LAUNCH_FAILED")
        self.assertFalse(telemetry["process_started"])
        self.assertFalse(telemetry["success"])
        self.assertFalse(telemetry["postconditions_valid"])
        self.assertFalse(telemetry["workflow_transition_valid"])
        self.assertEqual(telemetry["workflow_state_after"], "FIX_REQUIRED")

    def test_runner_preflight_failure_has_zero_process_calls_and_preserves_frozen_plan(self):
        before = self.protected()
        with patch.object(self.adapter, "build_prompt", return_value="oversized " * 5000), self.provider() as calls:
            _, stop = self.runner.run_step(execute_agents=True)
        self.assertEqual(calls, [])
        self.assertEqual(stop.state, WorkflowState.AGENT_INVOCATION_TOO_LARGE)
        self.assert_preserved(before)
        plan = json.loads((self.config.runtime_dir / "verification_plans" / f"{self.runner.current_run_id}.json").read_text())
        self.assertTrue(plan["plan"]["reusable_verification"][0]["covered_files"])

    def test_launched_provider_failure_is_execution_failure(self):
        before = self.protected()
        with self.provider(exit_code=7) as calls:
            _, stop = self.runner.run_step(execute_agents=True)
        self.assertEqual(len(calls), 1)
        self.assertEqual(stop.state, WorkflowState.AGENT_EXECUTION_FAILED)
        self.assertTrue(self.runner.current_agent_result.process_started)
        self.assert_preserved(before)

    def test_cli_never_prints_step_complete_on_preflight_or_launch_failure(self):
        contract = self.config.tasks_dir / f"{self.task_id}-test.md"
        with contract.open("a") as stream:
            stream.write("\nExpected Usage: HIGH\nImplementation Owner: GEMINI\nDelegation Reason: Bounded expensive independent implementation fixture.\n")
        for kind in ("preflight", "launch"):
            with self.subTest(kind=kind):
                prompt = "too long " * 5000 if kind == "preflight" else "small prompt"
                error = OSError("[WinError 206] filename too long") if kind == "launch" else None
                with patch.object(self.adapter, "build_prompt", return_value=prompt), \
                        patch("tools.ks_supervisor.cli.SupervisorRunner", return_value=self.runner), \
                        self.provider(error=error) as calls, redirect_stdout(io.StringIO()) as output:
                    code = cmd_run(self.config, once=True, live=True)
                self.assertEqual(code, 1)
                self.assertNotIn("[STEP COMPLETE]", output.getvalue())
                self.assertNotIn("AGENT_RESULT_MISMATCH", output.getvalue())
                self.assertEqual(len(calls), 0 if kind == "preflight" else 1)

    def test_permission_policy_remains_unchanged_and_test_fast_denied(self):
        before = self.policy_path.read_bytes()
        with self.provider(error=OSError("fixture launch failure")):
            self.runner.run_step(execute_agents=True)
        self.assertEqual(self.policy_path.read_bytes(), before)
        self.assertFalse(CommandPermissions().authorized("pnpm --dir backend run test:fast")[0])

    def test_success_claim_cannot_certify_an_explicitly_unstarted_process(self):
        with self.provider():
            result = self.invoke("small prompt")
        result.process_started = False
        stop = self.runner.verify_post_agent_state(self.runner.get_status(), result, Role.IMPLEMENTATION, action=ACTION_FIX)
        self.assertEqual(stop.state, WorkflowState.AGENT_EXECUTION_NOT_OBSERVED)
        self.assertFalse(report_completion_valid(self.config, self.task_id, self.report))

    def test_contradictory_launch_failure_flags_do_not_become_provider_result_mismatch(self):
        with self.provider(error=OSError("fixture launch failure")):
            result = self.invoke("small prompt")
        result.success = True  # Impossible flags must fail closed without claiming a launched agent.
        stop = self.runner.verify_post_agent_state(self.runner.get_status(), result, Role.IMPLEMENTATION, action=ACTION_FIX)
        self.assertEqual(stop.state, WorkflowState.AGENT_EXECUTION_NOT_OBSERVED)
