"""Current invocation evidence and targeted Senior transition regressions."""
from datetime import datetime, timezone, timedelta
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from contextlib import redirect_stdout
from unittest.mock import patch

from tools.ks_supervisor.cli import cmd_run
from tools.ks_supervisor.runner import SupervisorRunner
from tools.ks_supervisor.types import AgentInvocation, AgentResult, Role, WorkflowState
from tools.ks_supervisor.completion import completion_record, write_completion
from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase


class TestExecutionEvidence(BaseSupervisorTestCase):
    task_id = "TASK-2A-001"

    def setUp(self):
        super().setUp()
        self.write_checkpoint(current_task=self.task_id, task_status="FIX_REQUIRED")
        self.write_task(self.task_id, status="FIX_REQUIRED", risk="HIGH")
        self.review = self.config.reviews_dir / f"{self.task_id}-review.md"
        self.report = self.config.reports_dir / f"{self.task_id}-implementation.md"
        self.review.write_text("# Initial review\nFIX REQUIRED\nB-1: Missing guard\n", encoding="utf-8")
        self.report.write_text("# Report\nCOMPLETE\nBlocker fixes\nB-1: fixed guard\n", encoding="utf-8")
        os.utime(self.review, (time.time() - 20, time.time() - 20))
        os.utime(self.report, (time.time() - 10, time.time() - 10))
        self.seed_completion()
        self.config.enable_live_agents = True
        self.runner = SupervisorRunner(self.config)
        self.availability = patch("tools.ks_supervisor.runner.validate_profile_availability", return_value=(True, "fixture"))
        self.availability.start()
        self.addCleanup(self.availability.stop)

    def seed_completion(self):
        invocation = AgentInvocation("fixture-completed", self.task_id, "FIX_REQUIRED",
                                     "FIX_REQUIRED_REMEDIATION", Role.IMPLEMENTATION,
                                     "antigravity", "gemini-3.7-flash-medium", "medium", "fixture",
                                     datetime.now(timezone.utc).isoformat())
        result = AgentResult(Role.IMPLEMENTATION, self.task_id, 0, "", "", 1, True,
                             process_completed=True, provider_reported_success=True,
                             postconditions_valid=True, workflow_transition_valid=True,
                             run_id=invocation.run_id)
        record = completion_record(self.config, invocation, self.report, result)
        record.update(status="VERIFIED", workflow_state_after="FIX_AWAITING_TARGETED_VERIFICATION")
        write_completion(self.config, record)

    def result(self, identity, **overrides):
        fields = dict(role=Role.SENIOR, task_id=self.task_id, exit_code=0, stdout="Senior final output", stderr="",
                      duration_seconds=1, success=True, process_completed=True, provider_reported_success=True,
                      provider="codex", model_name="gpt-6.1-sol", effort="high", run_id=identity,
                      started_at=datetime.now(timezone.utc).isoformat())
        fields.update(overrides)
        return AgentResult(**fields)

    def evidence(self, run_id, decision="APPROVED", remaining="0"):
        digest = hashlib.sha256(self.report.read_bytes()).hexdigest()
        return ("## Current targeted verification\n"
                f"Run ID: {run_id}\nCorrection report SHA256: {digest}\n"
                f"Decision: {decision}\nRemaining blockers: {remaining}\n"
                "Evidence: Verified B-1 guard against current correction; deterministic fixture passes.\n")

    def run_senior(self, fn):
        with patch.object(self.runner.codex_adapter, "invoke", side_effect=fn):
            return self.runner.run_step(execute_agents=True)

    def diagnostics(self):
        last = json.loads((self.config.runtime_dir / "last_agent_run.json").read_text())
        event = json.loads((self.config.runtime_dir / "session.jsonl").read_text().splitlines()[-1])
        for item in (last, event):
            self.assertEqual(item["run_id"], self.runner.current_run_id)
            self.assertEqual(item["verifier_run_id"], self.runner.current_run_id)
        return last, event

    def test_codex_subprocess_and_successful_senior_telemetry(self):
        """Run the real adapter with only the Codex subprocess replaced."""
        adapter = self.runner.codex_adapter
        adapter.bin_name = "fixture-codex"
        original_run = subprocess.run
        commands = []
        def subprocess_fixture(cmd, **kwargs):
            if cmd[0] != "fixture-codex":
                return original_run(cmd, **kwargs)
            commands.append(cmd)
            self.assertEqual(cmd[1], "exec")
            self.assertEqual(cmd[cmd.index("-m") + 1], "gpt-6.1-sol")
            self.assertIn('model_reasoning_effort="high"', cmd)
            self.assertTrue(kwargs["capture_output"])
            self.assertIn(self.runner.current_run_id, cmd[-1])
            output = Path(cmd[cmd.index("-o") + 1])
            self.assertIn(self.runner.current_run_id, output.name)
            output.write_text("Current final Senior message", encoding="utf-8")
            self.review.write_text(self.evidence(self.runner.current_run_id), encoding="utf-8")
            return subprocess.CompletedProcess(cmd, 0, "stdout evidence", "stderr evidence")
        with patch("tools.ks_supervisor.adapters.codex.subprocess.run", side_effect=subprocess_fixture):
            state, stop = self.runner.run_step(execute_agents=True)
        self.assertIsNone(stop)
        self.assertEqual(state.state, WorkflowState.APPROVED_AWAITING_CLOSEOUT)
        self.assertEqual(len(commands), 1)
        last, event = self.diagnostics()
        self.assertEqual(last["final_message"], "Current final Senior message")
        self.assertIn("stderr evidence", last["stderr_snippet"])
        self.assertNotEqual(event["review_sha256_before"], event["review_sha256_after"])
        self.assertTrue(last["success"])
        self.assertTrue(self.runner.has_current_execution_record())

    def test_targeted_remaining_blockers_return_to_implementation(self):
        def agent(*args, **kwargs):
            # Preserve historical approval text to prove the current decision is authoritative.
            self.review.write_text("# History\nPreviously APPROVED\n" + self.evidence(kwargs["run_id"], "FIX REQUIRED", "B-1"), encoding="utf-8")
            return self.result(kwargs["run_id"])
        state, stop = self.run_senior(agent)
        self.assertIsNone(stop)
        self.assertEqual(state.state, WorkflowState.FIX_REQUIRED)
        self.assertEqual(state.assigned_role, Role.IMPLEMENTATION)
        self.assertTrue(self.diagnostics()[0]["success"])

    def test_noop_unchanged_canonical_review_fails(self):
        state, stop = self.run_senior(lambda *a, **k: self.result(k["run_id"]))
        self.assertEqual(stop.state, WorkflowState.SENIOR_REVIEW_NO_EFFECT)
        self.assertEqual(state.state, WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION)
        self.assertFalse(self.diagnostics()[0]["success"])
        self.assertFalse(self.runner.has_current_execution_record())

    def test_review_hash_change_and_current_evidence_required(self):
        for mode in ("report_only", "other_review", "missing_run", "wrong_correction", "same_state", "unchanged_hash"):
            with self.subTest(mode=mode):
                original = "# Review\nFIX REQUIRED\nB-1: guard\n"
                self.review.write_text(original, encoding="utf-8")
                os.utime(self.review, (time.time()-20, time.time()-20))
                self.seed_completion()
                def agent(*args, **kwargs):
                    evidence = self.evidence(kwargs["run_id"])
                    if mode == "report_only":
                        self.report.write_text(self.report.read_text() + "\nfix evidence\n")
                    elif mode == "other_review":
                        (self.config.reviews_dir / "TASK-OTHER-review.md").write_text(evidence)
                    elif mode == "missing_run":
                        self.review.write_text(evidence.replace(kwargs["run_id"], "old-run"))
                    elif mode == "wrong_correction":
                        self.review.write_text(evidence.replace(hashlib.sha256(self.report.read_bytes()).hexdigest(), "old-hash"))
                    elif mode == "same_state":
                        self.review.write_text(original + "\nNew comment, no decision\n")
                        os.utime(self.review, (time.time()-20, time.time()-20))
                    else:
                        os.utime(self.review, None)  # timestamp-only update is insufficient
                    return self.result(kwargs["run_id"])
                _, stop = self.run_senior(agent)
                self.assertEqual(stop.state, WorkflowState.SENIOR_REVIEW_NO_EFFECT)
                self.assertFalse(self.diagnostics()[0]["success"])

    def test_identity_mismatches_rejected(self):
        for overrides in ({"run_id": "old"}, {"provider": "antigravity"}, {"role": Role.IMPLEMENTATION},
                          {"task_id": "TASK-OTHER"}, {"model_name": "wrong-model"}, {"effort": "wrong-effort"}, {"started_at": "invalid"},
                          {"started_at": (datetime.now(timezone.utc)-timedelta(days=1)).isoformat()}):
            with self.subTest(overrides=overrides):
                def agent(*args, **kwargs):
                    self.review.write_text(self.evidence(kwargs["run_id"]))
                    return self.result(kwargs["run_id"], **overrides)
                _, stop = self.run_senior(agent)
                expected = (WorkflowState.SUPERVISOR_INVOCATION_IDENTITY_MISMATCH if "model_name" in overrides or "effort" in overrides
                            else WorkflowState.AGENT_EXECUTION_NOT_OBSERVED)
                self.assertEqual(stop.state, expected)
                self.assertFalse(self.diagnostics()[0]["success"])

    def test_stale_gemini_result_cannot_satisfy_missing_codex(self):
        self.report.write_text("# Report\nINCOMPLETE\n")
        def gemini(*args, **kwargs):
            self.report.write_text("# Report\nCOMPLETE\nBlocker fixes\nB-1: fixed guard\n")
            return self.result(kwargs["run_id"], role=Role.IMPLEMENTATION, provider="antigravity", model_name=kwargs["profile"].model, effort=kwargs["profile"].effort)
        with patch.object(self.runner.antigravity_adapter, "invoke", side_effect=gemini):
            state, stop = self.runner.run_step(execute_agents=True)
        self.assertIsNone(stop)
        self.assertEqual(state.state, WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION)
        old, _ = self.diagnostics()
        self.assertEqual(old["provider"], "antigravity")
        _, stop = self.run_senior(lambda *a, **k: None)
        self.assertEqual(stop.state, WorkflowState.AGENT_EXECUTION_NOT_OBSERVED)
        current, event = self.diagnostics()
        self.assertEqual(current["provider"], "codex")
        self.assertNotEqual(current["run_id"], old["run_id"])
        self.assertFalse(event["success"])
        self.assertFalse(self.runner.has_current_execution_record())

    def test_failure_paths_always_record_telemetry(self):
        cases = ("nonzero", "timeout", "permission", "provider", "exception")
        for case in cases:
            with self.subTest(case=case):
                def agent(*args, **kwargs):
                    if case == "exception":
                        raise PermissionError("fixture spawn denied")
                    return self.result(kwargs["run_id"], success=False, exit_code=124 if case == "timeout" else 1,
                                       timed_out=case == "timeout", soft_permission_denial=case == "permission",
                                       auth_or_quota_failure=case == "provider")
                _, stop = self.run_senior(agent)
                self.assertIsNotNone(stop)
                self.assertFalse(self.diagnostics()[0]["success"])

    def test_telemetry_write_failure_fails_closed(self):
        def agent(*args, **kwargs):
            self.review.write_text(self.evidence(kwargs["run_id"]))
            return self.result(kwargs["run_id"])
        with patch.object(self.runner, "_record_session_telemetry", side_effect=OSError("fixture full disk")):
            _, stop = self.run_senior(agent)
        self.assertEqual(stop.state, WorkflowState.AGENT_EXECUTION_NOT_OBSERVED)
        self.assertIn("telemetry", stop.reason)
        self.assertFalse(self.runner.has_current_execution_record())

    def test_skipped_live_execution_cli_never_prints_step_complete(self):
        state = self.runner.get_status()
        for live in (False, True):
            with self.subTest(live=live), redirect_stdout(io.StringIO()) as output:
                with patch("tools.ks_supervisor.cli.SupervisorRunner", return_value=self.runner), patch.object(
                        self.runner, "run_step", return_value=(state, None)):
                    code = cmd_run(self.config, once=True, live=live)
                self.assertNotIn("[STEP COMPLETE]", output.getvalue())
                self.assertEqual(code, 1 if live else 0)

    def test_success_claim_without_completed_process_fails(self):
        def agent(*args, **kwargs):
            self.review.write_text(self.evidence(kwargs["run_id"]))
            return self.result(kwargs["run_id"], process_completed=False)
        _, stop = self.run_senior(agent)
        self.assertEqual(stop.state, WorkflowState.AGENT_RESULT_MISMATCH)
        self.assertFalse(self.diagnostics()[0]["success"])

    def test_codex_adapter_failure_outputs_and_unique_message_paths(self):
        adapter = self.runner.codex_adapter
        # Availability and profile selection are already covered; reuse the actual selected profile.
        profile = self.runner.get_status().model_selection.profile
        outcomes = [subprocess.CompletedProcess(["codex"], 7, "failed stdout", "failed stderr"),
                    subprocess.TimeoutExpired(["codex"], 1, output=b"partial stdout", stderr=b"partial stderr"),
                    PermissionError("fixture permission denied")]
        paths = []
        for index, outcome in enumerate(outcomes):
            with self.subTest(index=index):
                kwargs = {"side_effect": outcome} if isinstance(outcome, Exception) else {"return_value": outcome}
                with patch("tools.ks_supervisor.adapters.codex.subprocess.run", **kwargs):
                    result = adapter.invoke(Role.SENIOR, self.task_id, prompt="fixture", profile=profile, run_id=f"fixture-{index}")
                self.assertEqual(result.run_id, f"fixture-{index}")
                self.assertFalse(result.success)
                self.assertIn(f"fixture-{index}", result.final_message_path)
                paths.append(result.final_message_path)
                if index == 0:
                    self.assertEqual(result.exit_code, 7)
                    self.assertTrue(result.process_completed)
                    self.assertEqual(result.stdout, "failed stdout")
                elif index == 1:
                    self.assertTrue(result.timed_out)
                    self.assertEqual(result.stdout, "partial stdout")
                    self.assertEqual(result.stderr, "partial stderr")
        self.assertEqual(len(set(paths)), 3)

    def run_cli(self, provider, agent):
        with redirect_stdout(io.StringIO()) as output, patch("tools.ks_supervisor.cli.SupervisorRunner", return_value=self.runner), patch.object(
                self.runner.codex_adapter if provider == "codex" else self.runner.antigravity_adapter,
                "invoke", side_effect=agent):
            code = cmd_run(self.config, once=True, live=True)
        return code, output.getvalue()

    def test_cli_gemini_executed_codex_next(self):
        self.report.write_text("# Report\nINCOMPLETE\n", encoding="utf-8")
        def agent(*args, **kwargs):
            # Header is emitted before the mocked subprocess begins.
            self.assertIn("EXECUTED TRANSITION", sys.stdout.getvalue())
            self.report.write_text("# Report\nCOMPLETE\nBlocker fixes\nB-1: fixed guard\n", encoding="utf-8")
            return self.result(kwargs["run_id"], role=Role.IMPLEMENTATION, provider="antigravity",
                               model_name=kwargs["profile"].model, effort=kwargs["profile"].effort)
        code, output = self.run_cli("antigravity", agent)
        self.assertEqual(code, 0, output)
        executed, remaining = output.split("EXECUTED TRANSITION", 1)[1].split("\n RESULT", 1)
        self.assertIn("Before State:   FIX_REQUIRED", executed)
        self.assertIn("Role:           IMPLEMENTATION", executed)
        self.assertIn("Provider:       Antigravity", executed)
        self.assertIn("Model:          gemini-3.7-flash-medium", executed)
        self.assertIn("Action:         FIX_REQUIRED_REMEDIATION", executed)
        self.assertNotIn("Codex", executed)
        next_section = remaining.split("NEXT TRANSITION", 1)[1]
        self.assertIn("Assigned Role:  SENIOR", next_section)
        self.assertIn("gpt-6.1-sol", next_section)
        self.assertIn("After State:    FIX_AWAITING_TARGETED_VERIFICATION", remaining)
        self.assertIn("[STEP COMPLETE] Verified Antigravity IMPLEMENTATION", output)
        self.assertNotIn("[STEP COMPLETE] Verified Codex", output)
        last, event = self.diagnostics()
        for item in (last, event):
            self.assertIn(f"Run ID:         {item['run_id']}", executed)
            self.assertEqual(item["invocation"]["model"], "gemini-3.7-flash-medium")

    def test_cli_codex_executed_gemini_next(self):
        def agent(*args, **kwargs):
            self.review.write_text(self.evidence(kwargs["run_id"], "FIX REQUIRED", "B-1"), encoding="utf-8")
            return self.result(kwargs["run_id"])
        code, output = self.run_cli("codex", agent)
        self.assertEqual(code, 0, output)
        executed, remaining = output.split("EXECUTED TRANSITION", 1)[1].split("\n RESULT", 1)
        self.assertIn("Before State:   FIX_AWAITING_TARGETED_VERIFICATION", executed)
        self.assertIn("Role:           SENIOR", executed)
        self.assertIn("Provider:       Codex", executed)
        self.assertIn("Model:          gpt-6.1-sol", executed)
        self.assertIn("Action:         TARGETED_VERIFICATION", executed)
        self.assertNotIn("Antigravity", executed)
        self.assertIn("After State:    FIX_REQUIRED", remaining)
        next_section = remaining.split("NEXT TRANSITION", 1)[1]
        self.assertIn("Assigned Role:  IMPLEMENTATION", next_section)
        self.assertIn("gemini-3.7-flash-medium", next_section)
        self.assertIn("[STEP COMPLETE] Verified Codex SENIOR", output)
        self.assertTrue(self.runner.has_current_execution_record())

    def test_completion_rejects_invocation_and_record_identity_mismatches(self):
        from dataclasses import replace, FrozenInstanceError
        def agent(*args, **kwargs):
            self.review.write_text(self.evidence(kwargs["run_id"]), encoding="utf-8")
            return self.result(kwargs["run_id"])
        _, stop = self.run_senior(agent)
        self.assertIsNone(stop)
        invocation = self.runner.current_invocation
        with self.assertRaises(FrozenInstanceError):
            invocation.model = "other"
        for field, wrong in (("run_id", "old"), ("role", Role.IMPLEMENTATION), ("provider", "antigravity"),
                             ("model", "other"), ("workflow_state_before", "FIX_REQUIRED"), ("action", "IMPLEMENTATION")):
            with self.subTest(field=field):
                self.runner.current_invocation = replace(invocation, **{field: wrong})
                self.assertFalse(self.runner.has_current_execution_record())
        self.runner.current_invocation = invocation
        for filename in ("last_agent_run.json", "session.jsonl"):
            path = self.config.runtime_dir / filename
            original = path.read_text(encoding="utf-8")
            for field in ("run_id", "role", "provider", "model", "workflow_state_before", "action", "invocation", "final_message_path"):
                with self.subTest(filename=filename, field=field):
                    item = json.loads(original.splitlines()[-1]) if filename.endswith("jsonl") else json.loads(original)
                    item[field] = "wrong"
                    path.write_text(json.dumps(item) + "\n", encoding="utf-8")
                    self.assertFalse(self.runner.has_current_execution_record())
            path.write_text(original, encoding="utf-8")
        self.assertTrue(self.runner.has_current_execution_record())

    def test_cli_mismatched_invocation_fails_without_step_complete(self):
        from dataclasses import replace
        original_step = self.runner.run_step
        def step(*args, **kwargs):
            state, stop = original_step(*args, **kwargs)
            self.runner.current_invocation = replace(self.runner.current_invocation, model="wrong-model")
            return state, stop
        def agent(*args, **kwargs):
            self.review.write_text(self.evidence(kwargs["run_id"]), encoding="utf-8")
            return self.result(kwargs["run_id"])
        with patch.object(self.runner, "run_step", side_effect=step):
            code, output = self.run_cli("codex", agent)
        self.assertEqual(code, 1)
        self.assertIn("SUPERVISOR_INVOCATION_IDENTITY_MISMATCH", output)
        self.assertNotIn("[STEP COMPLETE]", output)
