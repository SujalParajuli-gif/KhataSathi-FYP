"""Report freshness requires successful supervisor-owned completion provenance."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import time
from unittest.mock import patch

from tools.ks_supervisor.completion import completion_path, report_completion_valid
from tools.ks_supervisor.runner import SupervisorRunner
from tools.ks_supervisor.state import derive_workflow_state
from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase
from tools.ks_supervisor.types import AgentResult, Role, WorkflowState


class TestCompletionProvenance(BaseSupervisorTestCase):
    task_id = "TASK-2A-001"

    def setUp(self):
        super().setUp()
        self.write_checkpoint(current_task=self.task_id, task_status="FIX_REQUIRED")
        self.write_task(self.task_id, status="FIX_REQUIRED", risk="HIGH")
        self.review = self.config.reviews_dir / f"{self.task_id}-review.md"
        self.report = self.config.reports_dir / f"{self.task_id}-implementation.md"
        self.review.write_text("# Review\nFIX REQUIRED\nB-1: Missing guard\n", encoding="utf-8")
        os.utime(self.review, (time.time()-20, time.time()-20))
        self.source = self.repo_root / "src" / "handler.ts"
        self.source.parent.mkdir()
        self.source.write_text("// partial work\n", encoding="utf-8")
        self.runner = SupervisorRunner(self.config)
        unexpected_codex = patch.object(self.runner.codex_adapter, "invoke",
                                        side_effect=AssertionError("Unexpected Codex invocation in implementation fixture"))
        unexpected_codex.start()
        self.addCleanup(unexpected_codex.stop)
        unexpected_gemini = patch.object(self.runner.antigravity_adapter, "invoke",
                                         side_effect=AssertionError("Missing Gemini execution mock"))
        unexpected_gemini.start()
        self.addCleanup(unexpected_gemini.stop)
        self.config.enable_live_agents = True
        self.availability = patch("tools.ks_supervisor.runner.validate_profile_availability", return_value=(True, "fixture"))
        self.availability.start()
        self.addCleanup(self.availability.stop)

    def result(self, kwargs, **overrides):
        fields = dict(role=Role.IMPLEMENTATION, task_id=self.task_id, exit_code=0, stdout="verification passed", stderr="",
                      duration_seconds=1, success=True, process_completed=True, provider_reported_success=True,
                      provider="antigravity", model_name=kwargs["profile"].model, effort=kwargs["profile"].effort,
                      run_id=kwargs["run_id"], started_at=datetime.now(timezone.utc).isoformat())
        fields.update(overrides)
        return AgentResult(**fields)

    def attempt(self, **overrides):
        def agent(*args, **kwargs):
            self.source.write_text("// preserved implementation change\n", encoding="utf-8")
            self.report.write_text("# Report\nCOMPLETE\nBlocker fixes\nB-1: resolved\n", encoding="utf-8")
            return self.result(kwargs, **overrides)
        with patch.object(self.runner.antigravity_adapter, "invoke", side_effect=agent):
            return self.runner.run_step(execute_agents=True)

    def assert_fix(self):
        state = derive_workflow_state(self.config)
        self.assertEqual(state.state, WorkflowState.FIX_REQUIRED)
        self.assertEqual(state.assigned_role, Role.IMPLEMENTATION)
        self.assertEqual(state.model_selection.profile.name, "gemini_fix")
        self.assertEqual(state.model_selection.profile.provider, "antigravity")

    def test_timeout_report_and_partial_application_work_preserved_not_promoted(self):
        _, stop = self.attempt(success=False, process_completed=False, provider_reported_success=False,
                               timed_out=True, timeout_kind="hard_limit", exit_code=124)
        self.assertEqual(stop.state, WorkflowState.AGENT_EXECUTION_TIMEOUT)
        self.assert_fix()
        self.assertIn("B-1: resolved", self.report.read_text())
        self.assertIn("preserved implementation change", self.source.read_text())
        record = json.loads(completion_path(self.config, self.task_id).read_text())
        self.assertEqual(record["status"], "UNCOMMITTED")
        self.assertFalse(report_completion_valid(self.config, self.task_id, self.report))

    def test_permission_and_nonzero_failed_report_not_promoted(self):
        for flags in (dict(soft_permission_denial=True), dict(denied_actions=["run_command"]),
                      dict(success=False, exit_code=1), dict(provider_reported_success=False)):
            with self.subTest(flags=flags):
                self.attempt(**flags)
                self.assert_fix()
                self.assertIn("B-1: resolved", self.report.read_text())

    def test_successful_matching_report_attestation_advances(self):
        state, stop = self.attempt()
        self.assertIsNone(stop)
        self.assertEqual(state.state, WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION)
        self.assertEqual(derive_workflow_state(self.config).state, state.state)
        record = json.loads(completion_path(self.config, self.task_id).read_text())
        self.assertEqual(record["run_id"], self.runner.current_run_id)
        self.assertEqual(record["report_sha256"], hashlib.sha256(self.report.read_bytes()).hexdigest())
        self.assertTrue(report_completion_valid(self.config, self.task_id, self.report))
        for flag in ("success", "process_completed", "provider_reported_success", "postconditions_valid", "workflow_transition_valid"):
            self.assertTrue(record[flag])

    def test_prior_success_then_failed_new_report_invalidates_readiness(self):
        _, stop = self.attempt()
        self.assertIsNone(stop)
        # A changed report without a new completion cannot reuse the earlier proof.
        self.report.write_text(self.report.read_text() + "\nadditional correction\n")
        self.assert_fix()
        _, stop = self.attempt(success=False, timed_out=True, process_completed=False, exit_code=124)
        self.assertEqual(stop.state, WorkflowState.AGENT_EXECUTION_TIMEOUT)
        self.assert_fix()

    def test_stale_session_success_cannot_bless_newer_or_unattested_report(self):
        self.report.write_text("# Report\nCOMPLETE\nBlocker fixes\nB-1: resolved\n")
        stale = dict(task_id=self.task_id, run_id="stale", success=True, process_completed=True,
                     provider_reported_success=True, postconditions_valid=True, workflow_transition_valid=True)
        (self.config.runtime_dir / "last_agent_run.json").write_text(json.dumps(stale))
        (self.config.runtime_dir / "session.jsonl").write_text(json.dumps(stale)+"\n")
        self.assert_fix()

    def test_mismatched_identity_fingerprint_and_success_flags_fail_closed(self):
        _, stop = self.attempt()
        self.assertIsNone(stop)
        path = completion_path(self.config, self.task_id)
        original = json.loads(path.read_text())
        for field, wrong in (("task_id", "TASK-OTHER"), ("run_id", "wrong"), ("result_run_id", "wrong"),
                             ("report_sha256", "wrong"), ("report_path", "other.md"), ("report_mtime_ns", 0),
                             ("success", False), ("process_completed", False), ("provider_reported_success", False),
                             ("postconditions_valid", False), ("workflow_transition_valid", False),
                             ("timed_out", True), ("soft_permission_denial", True), ("denied_actions", ["run_command"]),
                             ("action", "TARGETED_VERIFICATION"), ("workflow_state_after", "APPROVED_AWAITING_CLOSEOUT")):
            with self.subTest(field=field):
                bad = dict(original)
                bad[field] = wrong
                path.write_text(json.dumps(bad))
                self.assert_fix()
        path.write_text(json.dumps(original))
        self.assertEqual(derive_workflow_state(self.config).state, WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION)

    def test_successful_continuation_can_validate_unchanged_failed_report(self):
        self.attempt(success=False, timed_out=True, process_completed=False, exit_code=124)
        self.review.write_text("# Review\nFIX REQUIRED\nB-1: Evidence-only: produce missing targeted verification artifact\n")
        os.utime(self.review, (time.time()-20, time.time()-20))
        before = self.report.read_bytes()
        source_before = self.source.read_bytes()
        def agent(*args, **kwargs):
            self.assertIn(self.runner.report_validation_marker, kwargs["prompt"])
            evidence = self.config.reports_dir / f"{self.task_id}-targeted-verification.md"
            evidence.write_text("B-1: missing targeted verification performed this turn; fixture PASS\n")
            return self.result(kwargs, stdout=json.dumps({"type":"result", "result":self.runner.report_validation_marker}))
        with patch.object(self.runner.antigravity_adapter, "invoke", side_effect=agent):
            state, stop = self.runner.run_step(execute_agents=True)
        self.assertIsNone(stop)
        self.assertEqual(state.state, WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION)
        self.assertEqual(self.report.read_bytes(), before)
        self.assertEqual(self.source.read_bytes(), source_before)
        self.assertTrue(report_completion_valid(self.config, self.task_id, self.report))
        self.assertEqual(self.runner.fix_cycles[self.task_id], 1)

    def test_senior_remaining_blockers_reject_noop_completion_marker_and_generic_checks(self):
        self.attempt(success=False, timed_out=True, process_completed=False, exit_code=124)
        self.review.write_text("# Latest Senior review\n## Current targeted verification\n"
                               "Run ID: d9f565c7ad684c12bfa73f2925b733be\n"
                               "Decision: FIX REQUIRED\nRemaining blockers: B-5, B-7\n")
        report_before, source_before = self.report.read_bytes(), self.source.read_bytes()
        def agent(*args, **kwargs):
            self.assertIn("Remaining blockers: B-5, B-7", kwargs["prompt"])
            self.assertIn("Any later report-validation instruction is subordinate", kwargs["prompt"])
            return self.result(kwargs, stdout="backend build PASS; frontend tsc PASS; 39 unit tests PASS\n"
                               + self.runner.report_validation_marker)
        with patch.object(self.runner.antigravity_adapter, "invoke", side_effect=agent):
            _, stop = self.runner.run_step(execute_agents=True)
        self.assertIsNotNone(stop)
        self.assertIn("NO_OBSERVABLE_AGENT_EFFECT", stop.reason)
        self.assert_fix()
        self.assertEqual(self.report.read_bytes(), report_before)
        self.assertEqual(self.source.read_bytes(), source_before)
        self.assertFalse(report_completion_valid(self.config, self.task_id, self.report))

    def test_noop_or_tool_echo_does_not_validate_report(self):
        self.attempt(success=False, timed_out=True, process_completed=False, exit_code=124)
        for echo in (False, True):
            def agent(*args, **kwargs):
                stdout = json.dumps({"type":"tool_call", "args":self.runner.report_validation_marker}) if echo else "done"
                return self.result(kwargs, stdout=stdout)
            with patch.object(self.runner.antigravity_adapter, "invoke", side_effect=agent):
                _, stop = self.runner.run_step(execute_agents=True)
            self.assertIsNotNone(stop)
            self.assert_fix()

    def test_initial_implementation_failure_cannot_promote_managed_report(self):
        self.write_checkpoint(current_task=self.task_id, task_status="IN_PROGRESS")
        self.write_task(self.task_id, status="IN_PROGRESS", risk="MEDIUM")
        self.review.unlink()
        self.attempt(success=False, timed_out=True, process_completed=False, exit_code=124)
        state = derive_workflow_state(self.config)
        self.assertEqual(state.state, WorkflowState.IMPLEMENTATION_IN_PROGRESS)
        self.assertEqual(state.assigned_role, Role.IMPLEMENTATION)

    def test_post_verification_report_change_cannot_be_attested(self):
        record_telemetry = self.runner._record_session_telemetry
        def telemetry(*args, **kwargs):
            record_telemetry(*args, **kwargs)
            self.report.write_text(self.report.read_text()+"\nnot verified\n")
        with patch.object(self.runner, "_record_session_telemetry", side_effect=telemetry):
            _, stop = self.attempt()
        self.assertIsNotNone(stop)
        self.assert_fix()

    def test_attestation_publication_failure_preserves_work_and_blocks_readiness(self):
        from tools.ks_supervisor.completion import write_completion
        def writer(config, record):
            if record["status"] == "VERIFIED":
                raise OSError("fixture publication failure")
            write_completion(config, record)
        with patch("tools.ks_supervisor.runner.write_completion", side_effect=writer):
            _, stop = self.attempt()
        self.assertIsNotNone(stop)
        self.assert_fix()
        self.assertIn("B-1: resolved", self.report.read_text())
        self.assertFalse(self.runner.has_current_execution_record())

    def test_historical_review_authority_and_initial_report_reconstruction_preserved(self):
        # Ordinary historical reports not produced by this supervisor retain repository authority.
        self.write_checkpoint(current_task=self.task_id, task_status="IN_PROGRESS")
        self.write_task(self.task_id, status="IN_PROGRESS", risk="MEDIUM")
        self.review.unlink()
        self.report.write_text("# Report\nCOMPLETE - AWAITING SENIOR REVIEW\n")
        self.assertEqual(derive_workflow_state(self.config).state, WorkflowState.IMPLEMENTED_AWAITING_REVIEW)
        # Existing Senior authority still wins over an uncommitted implementation attempt.
        self.write_checkpoint(current_task=self.task_id, task_status="FIX_REQUIRED")
        self.write_task(self.task_id, status="FIX_REQUIRED", risk="MEDIUM")
        self.review.write_text("# Review\nFIX REQUIRED\nB-1: Missing guard\n")
        os.utime(self.review, (time.time()-20, time.time()-20))
        self.assert_fix()
        self.attempt(success=False, timed_out=True, process_completed=False, exit_code=124)
        self.review.write_text("# Review\nAPPROVED\nZero blockers\n")
        self.assertEqual(derive_workflow_state(self.config).state, WorkflowState.APPROVED_AWAITING_CLOSEOUT)
