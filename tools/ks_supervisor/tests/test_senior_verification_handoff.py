"""Current-content evidence handoff never replaces the Senior's blocker decision."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from unittest.mock import MagicMock, patch

from tools.ks_supervisor.completion import completion_path, completion_record, write_completion
from tools.ks_supervisor.runner import SupervisorRunner
from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase
from tools.ks_supervisor.types import AgentInvocation, AgentResult, Role, WorkflowState
from tools.ks_supervisor.verification import VerificationEvidence


class TestSeniorVerificationHandoff(BaseSupervisorTestCase):
    task_id = "TASK-2A-001"
    command = "pnpm --dir frontend exec playwright test tests/browser/spec.ts"

    def setUp(self):
        super().setUp()
        permissions = MagicMock()
        permissions.authorized.return_value = (True, "fixture Allow")
        permissions.metadata.return_value = {"error": "", "project": "fixture", "sources_sha256": {}}
        policy = patch("tools.ks_supervisor.verification.CommandPermissions", return_value=permissions)
        policy.start()
        self.addCleanup(policy.stop)
        self.write_checkpoint(current_task=self.task_id, task_status="FIX_REQUIRED")
        self.write_task(self.task_id, status="FIX_REQUIRED", risk="HIGH")
        self.review = self.config.reviews_dir / f"{self.task_id}-review.md"
        self.report = self.config.reports_dir / f"{self.task_id}-implementation.md"
        self.review.write_text("## Current targeted verification\nRun ID: prior-senior\n"
                               "Decision: FIX REQUIRED\nRemaining blockers: B-5, B-7\n")
        self.report.write_text("COMPLETE\nBlocker fixes\nB-5/B-7: correction reported\n")
        os.utime(self.review, (time.time()-20, time.time()-20))
        os.utime(self.report, (time.time()-10, time.time()-10))
        self.spec = self.repo_root / "frontend/tests/browser/spec.ts"
        self.spec.parent.mkdir(parents=True)
        self.spec.write_text("first reference500 commits nothing; retry commits metadata/audit\n")
        invocation = AgentInvocation("implementation-verifier", self.task_id, "FIX_REQUIRED",
                                     "FIX_REQUIRED_REMEDIATION", Role.IMPLEMENTATION,
                                     "antigravity", "gemini-3.7-flash-medium", "medium", "fixture",
                                     datetime.now(timezone.utc).isoformat())
        result = AgentResult(Role.IMPLEMENTATION, self.task_id, 0, "", "", 1, True,
                             process_completed=True, provider_reported_success=True,
                             postconditions_valid=True, workflow_transition_valid=True, run_id=invocation.run_id)
        record = completion_record(self.config, invocation, self.report, result)
        record.update(status="VERIFIED", workflow_state_after="FIX_AWAITING_TARGETED_VERIFICATION")
        write_completion(self.config, record)
        self.ledger = VerificationEvidence(self.config, self.task_id)
        self.observe("ACTIVE", "", None)
        self.observe("DONE", "15 passed (39.3s)", 0)
        self.runner = SupervisorRunner(self.config)
        self.config.enable_live_agents = True

    def observe(self, state, output, exit_code):
        self.ledger.observe({"step_update": {"tool_name": "run_command", "step_index": 1, "state": state,
            "tool_info": {"parameters": {"CommandLine": self.command}, "output": output,
                          "exit_code": exit_code}}}, "implementation-verifier")

    def decision(self, run_id, remaining="B-7", evidence="Reused current-content browser verification; reference fixture still wrong"):
        self.review.write_text("## Current targeted verification\n"
            f"Run ID: {run_id}\nCorrection report SHA256: {hashlib.sha256(self.report.read_bytes()).hexdigest()}\n"
            f"Decision: FIX REQUIRED\nRemaining blockers: {remaining}\nEvidence: {evidence}\n")

    def run_senior(self, remaining="B-7", inspect=None, on_invocation=None, effect=True):
        def reviewer(*args, **kwargs):
            if inspect:
                inspect(kwargs["verification_plan"])
            if effect:
                self.decision(kwargs["run_id"], remaining)
            return AgentResult(Role.SENIOR, self.task_id, 0, "Reviewer decision", "", 1, True,
                               process_completed=True, provider_reported_success=True,
                               provider="codex", model_name=kwargs["profile"].model, effort=kwargs["profile"].effort,
                               run_id=kwargs["run_id"], started_at=datetime.now(timezone.utc).isoformat())
        with patch.object(self.runner.codex_adapter, "invoke", side_effect=reviewer) as called:
            state, stop = self.runner.run_step(execute_agents=True, on_invocation=on_invocation)
            self.assertEqual(called.call_count, 1)
        return state, stop

    def test_real_adapter_receives_current_pass_and_compact_attribution_context(self):
        adapter = self.runner.codex_adapter
        adapter.bin_name = "fixture-codex"
        original_run = subprocess.run
        prompts = []
        def child(argv, **kwargs):
            if argv[0] != "fixture-codex":
                return original_run(argv, **kwargs)
            prompts.append(argv[-1])
            self.decision(self.runner.current_run_id)
            Path(argv[argv.index("-o")+1]).write_text("Senior retains B-7")
            return subprocess.CompletedProcess(argv, 0, "Senior result", "")
        with patch("tools.ks_supervisor.adapters.codex.subprocess.run", side_effect=child):
            state, stop = self.runner.run_step(execute_agents=True)
        self.assertIsNone(stop)
        self.assertEqual(state.state, WorkflowState.FIX_REQUIRED)
        self.assertEqual(len(prompts), 1)
        prompt = prompts[0]
        for text in ("VALID REUSABLE VERIFICATION", "INVALIDATED VERIFICATION", "REQUIRED VERIFICATION",
                     self.command, "15 passed", "implementation-verifier", "verifier_run_id", "result_sha256",
                     "valid/current at Senior launch", "independent rerun unavailable", "acceptance evidence unavailable",
                     "Senior remains final authority", "metadata/audit effect", "cite", "Reused current-content Supervisor"):
            self.assertIn(text.lower(), prompt.lower())
        for key in ("covered_files", '"files":', "snapshot", "sources_sha256"):
            self.assertNotIn(key, prompt)
        self.assertLess(len(prompt), 6500)
        frozen = json.loads((self.config.runtime_dir / "verification_plans" / f"{self.runner.current_run_id}.json").read_text())
        self.assertEqual(frozen["provider"], "codex")
        self.assertEqual(frozen["plan"]["required_verification"], [])
        self.assertTrue(frozen["plan"]["reusable_verification"][0]["covered_files"])

    def test_change_at_senior_launch_invalidates_before_prompt_and_does_not_resolve_blockers(self):
        self.spec.write_text("changed test content\n")
        def inspect(plan):
            self.assertEqual(plan["reusable_verification"], [])
            self.assertIn("frontend/tests/browser/spec.ts", plan["invalidated_verification"][0]["invalidated_by"])
            self.assertEqual(plan["required_verification"][0]["command"], self.command)
        state, stop = self.run_senior(remaining="B-5, B-7", inspect=inspect)
        self.assertIsNone(stop)
        self.assertEqual(state.state, WorkflowState.FIX_REQUIRED)
        self.assertIn("B-5, B-7", self.review.read_text())

    def test_independent_senior_infrastructure_failure_preserves_valid_proof(self):
        before = self.ledger.path.read_bytes()
        def inspect(plan):
            prompt = self.runner.codex_adapter.build_prompt(Role.SENIOR, self.task_id,
                        action_type="TARGETED_VERIFICATION", verification_plan=plan)
            self.assertIn("unless that failure actually invalidates its target/content assumptions", prompt)
            # Reviewer writes independent failed startup output, not a failed acceptance-test result.
            (self.config.reports_dir / "independent-startup.log").write_text(
                'esbuild: Cannot read directory "../../../..": Access is denied. Zero cases executed.')
            self.assertEqual(plan["reusable_verification"][0]["outcome"], "PASS")
        state, stop = self.run_senior(inspect=inspect)
        self.assertIsNone(stop)
        self.assertEqual(self.ledger.path.read_bytes(), before)
        self.assertEqual(len(VerificationEvidence(self.config, self.task_id).plan()["reusable_verification"]), 1)
        self.assertEqual(state.state, WorkflowState.FIX_REQUIRED)

    def test_actual_test_failure_prevents_reuse_at_senior(self):
        self.observe("ACTIVE", "", None)
        self.observe("DONE", "1 failed: expected one audit effect", 1)
        def inspect(plan):
            self.assertFalse(plan["reusable_verification"])
            self.assertTrue(plan["required_verification"])
        state, stop = self.run_senior(remaining="B-5, B-7", inspect=inspect)
        self.assertIsNone(stop)
        self.assertEqual(state.state, WorkflowState.FIX_REQUIRED)
        self.assertEqual(VerificationEvidence(self.config, self.task_id).data["checks"][self.command]["outcome"], "FAIL")

    def test_evidence_alone_never_resolves_blockers_or_replaces_review(self):
        self.assertEqual(self.runner.get_status().state, WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION)
        state, stop = self.run_senior(effect=False)
        self.assertEqual(stop.state, WorkflowState.SENIOR_REVIEW_NO_EFFECT)
        self.assertNotEqual(state.state, WorkflowState.APPROVED_AWAITING_CLOSEOUT)
        self.assertIn("Remaining blockers: B-5, B-7", self.review.read_text())

    def test_b7_semantics_remain_fix_required_despite_passing_browser_check(self):
        completion_before = completion_path(self.config, self.task_id).read_bytes()
        def inspect(plan):
            self.assertTrue(plan["reusable_verification"])
            self.assertIn("first reference500 commits nothing", self.spec.read_text())
        state, stop = self.run_senior(inspect=inspect)
        self.assertIsNone(stop)
        self.assertEqual(state.state, WorkflowState.FIX_REQUIRED)
        self.assertEqual(state.assigned_role, Role.IMPLEMENTATION)
        self.assertIn("Remaining blockers: B-7", self.review.read_text())
        self.assertEqual(completion_path(self.config, self.task_id).read_bytes(), completion_before)

    def test_runtime_target_change_is_required_not_reusable(self):
        with patch.dict(os.environ, {"PLAYWRIGHT_BASE_URL": "http://changed-fixture.invalid"}):
            plan = VerificationEvidence(self.config, self.task_id).plan()
            self.assertFalse(plan["reusable_verification"])
            self.assertIn("runtime target/environment changed", plan["invalidated_verification"][0]["invalidated_by"])
            prompt = self.runner.codex_adapter.build_prompt(Role.SENIOR, self.task_id,
                        action_type="TARGETED_VERIFICATION", verification_plan=plan)
            self.assertIn('"reusable_verification": []', prompt)
            self.assertIn("runtime target/environment changed", prompt)

    def test_unverifiable_digest_never_enters_reusable_prompt(self):
        original = dict(self.ledger.data["checks"][self.command])
        for field, value in (("result_sha256", None), ("result_sha256", "invalid digest"),
                             ("verifier_run_id", "other-verifier")):
            record = dict(original)
            if value is None:
                record.pop(field)
            else:
                record[field] = value
            self.ledger.data["checks"][self.command] = record
            self.ledger.save()
            plan = VerificationEvidence(self.config, self.task_id).plan()
            self.assertFalse(plan["reusable_verification"])
            prompt = self.runner.codex_adapter.build_prompt(Role.SENIOR, self.task_id,
                        action_type="TARGETED_VERIFICATION", verification_plan=plan)
            self.assertIn('"reusable_verification": []', prompt)
            self.assertIn("Never reuse failed, stale, mismatched or unverifiable evidence", prompt)

    def test_explicit_senior_prompt_cannot_omit_handoff_guidance(self):
        adapter = self.runner.codex_adapter
        adapter.bin_name = "fixture-codex"
        original_run = subprocess.run
        captured = []
        def child(argv, **kwargs):
            if argv[0] != "fixture-codex":
                return original_run(argv, **kwargs)
            captured.append(argv[-1])
            return subprocess.CompletedProcess(argv, 0, "Reviewer output", "")
        with patch("tools.ks_supervisor.adapters.codex.subprocess.run", side_effect=child):
            adapter.invoke(Role.SENIOR, self.task_id, action_type="TARGETED_VERIFICATION",
                           prompt="Explicit bounded review prompt", run_id="explicit-senior")
        self.assertTrue(captured[0].startswith("Explicit bounded review prompt"))
        self.assertEqual(captured[0].count("## Supervisor-owned current-content verification context"), 1)
        self.assertIn("15 passed", captured[0])
        self.assertIn("Record APPROVED only with zero blocking findings", captured[0])
