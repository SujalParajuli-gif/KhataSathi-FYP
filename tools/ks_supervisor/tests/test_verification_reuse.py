"""Continuation verification is content-bound, durable across stops, and explicit in prompts."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import time
from unittest.mock import MagicMock, patch

from tools.ks_supervisor.adapters.antigravity import AntigravityAdapter
from tools.ks_supervisor.completion import report_completion_valid, completion_path
from tools.ks_supervisor.runner import SupervisorRunner
from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase
from tools.ks_supervisor.types import AgentResult, Role, WorkflowState
from tools.ks_supervisor.verification import VerificationEvidence, bounded_check
from tools.ks_supervisor.permissions import CLI_PROJECT, CommandPermissions


class TestVerificationReuse(BaseSupervisorTestCase):
    playwright = "pnpm --dir frontend exec playwright test tests/browser/spec.ts"
    typecheck = "pnpm --dir frontend run typecheck"
    backend = "pnpm --dir backend run build"

    def setUp(self):
        super().setUp()
        self.policy_home = self.repo_root / "fixture-home"
        self.policy_settings = self.policy_home / ".gemini/antigravity-cli/settings.json"
        self.policy_project = self.policy_home / f".gemini/config/projects/{CLI_PROJECT}.json"
        self.policy_settings.parent.mkdir(parents=True)
        self.policy_project.parent.mkdir(parents=True)
        self.policy_settings.write_text('{}')
        self.write_policy(["command(regex:pnpm --dir (backend|frontend) run (build|typecheck|lint))",
                           "command(regex:pnpm --dir frontend exec playwright test tests/browser/[^ ]+)",
                           "command(regex:node --test backend/dist/tests/[^ ]+)"])
        home_patch = patch("tools.ks_supervisor.permissions.Path.home", return_value=self.policy_home)
        home_patch.start()
        self.addCleanup(home_patch.stop)
        self.task_id = "TASK-2A-001"
        self.write_checkpoint(current_task=self.task_id, task_status="FIX_REQUIRED")
        self.write_task(self.task_id, status="FIX_REQUIRED", risk="HIGH", difficulty="8/10", title="Billing worksheet")
        for name in ("backend/src/handler.ts", "frontend/app/handler.ts", "frontend/tests/browser/spec.ts"):
            p = self.repo_root / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("// fixture content\n")
        review = self.config.reviews_dir / f"{self.task_id}-review.md"
        review.write_text("# Review\n## Current targeted verification\nRun ID: senior-fixture\n"
                          "Decision: FIX REQUIRED\nRemaining blockers: B-5, B-7\n")
        os.utime(review, (time.time()-20, time.time()-20))
        self.report = self.config.reports_dir / f"{self.task_id}-implementation.md"
        self.report.write_text("# Report\nCOMPLETE\nBlocker fixes\nB-5/B-7: correction evidence\n")
        self.evidence = VerificationEvidence(self.config, self.task_id)
        self.runner = SupervisorRunner(self.config)
        self.config.enable_live_agents = True
        forbidden = patch.object(self.runner.codex_adapter, "invoke", side_effect=AssertionError("Unexpected fallback"))
        forbidden.start()
        self.addCleanup(forbidden.stop)

    def write_policy(self, allow, deny=None, ask=None):
        self.policy_project.write_text(json.dumps({"id": CLI_PROJECT, "permissionGrants": {
            "permissionGrants": {"allow": allow, "deny": deny or [], "ask": ask or []}}}))

    def event(self, command, state, output="", exit_code=None, step=1):
        info = {"parameters": {"CommandLine": command}, "output": output}
        if exit_code is not None:
            info["exit_code"] = exit_code
        return {"event": "step_update", "step_update": {"step_index": step, "state": state,
                "tool_name": "run_command", "tool_info": info}}

    def passed(self, command, observer=None):
        if observer is None:
            observer = lambda e: self.evidence.observe(e, "passed-run")
        observer(self.event(command, "ACTIVE"))
        observer(self.event(command, "DONE", output="15 passed" if command == self.playwright else "fixture success", exit_code=0))

    def current_plan(self):
        return VerificationEvidence(self.config, self.task_id).plan()

    def attempt(self, edit=None, verify=None, **flags):
        def agent(*args, **kwargs):
            self.assertIn("Mandatory Continuation Verification Plan", kwargs["prompt"])
            if edit:
                edit()
            if verify:
                verify(kwargs["verification_observer"])
            fields = dict(role=Role.IMPLEMENTATION, task_id=self.task_id, run_id=kwargs["run_id"],
                          provider="antigravity", model_name=kwargs["profile"].model, effort=kwargs["profile"].effort,
                          started_at=datetime.now(timezone.utc).isoformat(), exit_code=0, stdout="fixture done", stderr="",
                          duration_seconds=1, success=True, process_completed=True, provider_reported_success=True)
            fields.update(flags)
            return AgentResult(**fields)
        with patch.object(self.runner.antigravity_adapter, "invoke", side_effect=agent) as invoked:
            state, stop = self.runner.run_step(execute_agents=True)
            self.assertEqual(invoked.call_count, 1)  # Never relaunch after a denial or invalidated check.
        return state, stop

    def test_playwright_and_typecheck_survive_zero_change_permission_stop(self):
        self.passed(self.playwright)
        self.passed(self.typecheck)
        _, stop = self.attempt(success=False, soft_permission_denial=True, denied_actions=["command"])
        self.assertEqual(stop.state, WorkflowState.AGENT_PERMISSION_REQUIRED)
        plan = self.current_plan()
        self.assertEqual({i["command"] for i in plan["reusable_verification"]}, {self.playwright, self.typecheck})
        self.assertEqual(plan["required_verification"], [])
        self.assertEqual(self.runner.fix_cycles, {})
        profile = self.runner.get_status().model_selection.profile
        self.assertEqual((profile.name, profile.model, profile.effort), ("gemini_fix", "gemini-3.7-flash-medium", "medium"))

    def test_pass_before_timeout_is_persisted_even_when_whole_run_fails(self):
        _, stop = self.attempt(verify=lambda observe: self.passed(self.playwright, observe), success=False,
                               timed_out=True, process_completed=False, provider_reported_success=False, exit_code=124)
        self.assertEqual(stop.state, WorkflowState.AGENT_EXECUTION_TIMEOUT)
        self.assertEqual(len(self.current_plan()["reusable_verification"]), 1)
        self.assertFalse(report_completion_valid(self.config, self.task_id, self.report))

    def test_backend_evidence_survives_frontend_only_changes(self):
        self.passed(self.backend)
        self.passed(self.typecheck)
        (self.repo_root / "frontend/app/handler.ts").write_text("// newer frontend\n")
        plan = self.current_plan()
        self.assertEqual([i["command"] for i in plan["reusable_verification"]], [self.backend])
        self.assertEqual([i["command"] for i in plan["required_verification"]], [self.typecheck])

    def test_frontend_source_and_spec_change_invalidate_browser_evidence(self):
        self.passed(self.playwright)
        for name in ("frontend/app/handler.ts", "frontend/tests/browser/spec.ts"):
            with self.subTest(name=name):
                p = self.repo_root / name
                original = p.read_bytes()
                p.write_text("// changed relevant content\n")
                plan = self.current_plan()
                self.assertEqual(plan["reusable_verification"], [])
                self.assertIn(name, plan["invalidated_verification"][0]["invalidated_by"])
                p.write_bytes(original)
        self.assertEqual(len(self.current_plan()["reusable_verification"]), 1)

    def test_backend_source_change_invalidates_backend_evidence(self):
        self.passed(self.backend)
        (self.repo_root / "backend/src/handler.ts").write_text("// changed backend\n")
        self.assertEqual(self.current_plan()["reusable_verification"], [])
        self.assertEqual(self.current_plan()["required_verification"][0]["command"], self.backend)

    def test_unrelated_change_and_mtime_only_change_do_not_invalidate(self):
        self.passed(self.typecheck)
        (self.repo_root / "README.md").write_text("Unrelated documentation\n")
        os.utime(self.repo_root / "frontend/app/handler.ts", None)
        self.assertEqual(len(self.current_plan()["reusable_verification"]), 1)

    def test_added_deleted_paths_and_runtime_target_invalidate(self):
        self.passed(self.backend)
        p = self.repo_root / "backend/src/new.ts"
        p.write_text("// new dependency\n")
        self.assertIn("backend/src/new.ts", self.current_plan()["invalidated_verification"][0]["invalidated_by"])
        p.unlink()
        with patch.dict(os.environ, {"NODE_ENV": "changed-test-target"}):
            self.assertIn("runtime target/environment changed", self.current_plan()["invalidated_verification"][0]["invalidated_by"])
        (self.repo_root / "backend/src/handler.ts").unlink()
        self.assertTrue(self.current_plan()["required_verification"])

    def test_plan_prompt_lists_only_invalidated_known_checks_as_required(self):
        self.passed(self.backend)
        self.passed(self.typecheck)
        (self.repo_root / "frontend/app/handler.ts").write_text("// frontend correction\n")
        plan = self.current_plan()
        prompt = self.runner.antigravity_adapter.build_prompt(Role.IMPLEMENTATION, self.task_id, is_fix=True, verification_plan=plan)
        for name in ("reusable_verification", "invalidated_verification", "required_verification", "check_id", "authorized", "status"):
            self.assertIn(name, prompt)
        for name in ("covered_files", "result_sha256", "sources_sha256"):
            self.assertNotIn(name, prompt)
        self.assertIn("DO NOT execute or request that command", prompt)
        self.assertIn("Use the existing evidence instead", prompt)
        self.assertIn("tests are not discovery tools", prompt)
        self.assertIn("Remaining blockers: B-5, B-7", prompt)
        self.assertIn("Broad pnpm --dir backend test", prompt)
        self.assertEqual([i["command"] for i in plan["required_verification"]], [self.typecheck])

    def test_redundant_attempt_is_diagnosed_without_widening_permissions(self):
        self.passed(self.playwright)
        self.evidence.observe(self.event(self.playwright, "ACTIVE"), "redundant-run")
        reloaded = VerificationEvidence(self.config, self.task_id)
        self.assertEqual(reloaded.data["diagnostics"][-1]["kind"], "REDUNDANT_VERIFICATION_REQUEST")
        self.assertIsNone(bounded_check("pnpm --dir backend test"))
        self.assertIsNone(bounded_check("pnpm --dir backend test src/tests/a.ts"))
        self.assertIsNone(bounded_check(self.backend + "; " + self.typecheck))
        prompt = self.runner.antigravity_adapter.build_prompt(Role.IMPLEMENTATION, self.task_id, is_fix=True, verification_plan=reloaded.plan())
        self.assertNotIn("command(*)", prompt)
        self.assertNotIn("--dangerously-skip-permissions", prompt)

    def test_stale_evidence_cannot_attest_remediation_completion(self):
        self.passed(self.typecheck)
        def edit():
            (self.repo_root / "frontend/app/handler.ts").write_text("// correction requiring typecheck\n")
        _, stop = self.attempt(edit=edit)
        self.assertEqual(stop.state, WorkflowState.TARGETED_VERIFICATION_REQUIRED)
        self.assertIn("current-content targeted verification is pending", stop.reason)
        self.assertEqual(stop.resume_command, "python -m tools.ks_supervisor run --once --live")
        self.assertFalse(report_completion_valid(self.config, self.task_id, self.report))
        self.assertEqual(self.runner.get_status().state, WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION)
        self.assertEqual(self.runner.get_status().assigned_role, Role.SUPERVISOR)
        self.assertEqual(self.runner.fix_cycles, {})

    def pending_browser(self, verify=None):
        self.passed(self.playwright)
        self.assertFalse(self.current_plan()["required_verification"])
        def edit():
            (self.repo_root / "frontend/tests/browser/spec.ts").write_text("// final corrected browser assertion\n")
            self.report.write_text(self.report.read_text() + "\nB-5/B-7: final spec remediation\n")
        state, stop = self.attempt(edit=edit, verify=verify)
        self.assertEqual(stop.state, WorkflowState.TARGETED_VERIFICATION_REQUIRED)
        self.assertEqual(state.state, WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION)
        self.assertIsNone(state.model_selection)
        self.assertEqual(state.assigned_role, Role.SUPERVISOR)
        return state

    def direct(self, exit_code=0, effect=None):
        from tools.ks_supervisor.targeted import execute_check
        def command(config, args, output_path, timeout, heartbeat):
            self.assertEqual(args, self.playwright.split())
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout, 600)
            heartbeat()
            output_path.write_text("15 passed" if exit_code == 0 else "1 failed; assertion details")
            if effect:
                effect()
            return exit_code
        with patch("tools.ks_supervisor.targeted.execute_check", side_effect=command) as executed, \
                patch.object(self.runner.antigravity_adapter, "invoke", side_effect=AssertionError("Unexpected Gemini")), \
                patch("tools.ks_supervisor.runner.validate_profile_availability", side_effect=AssertionError("Unexpected provider discovery")):
            state, stop = self.runner.run_step(execute_agents=True)
        return state, stop, executed.call_count

    def test_direct_browser_success_records_current_content_and_senior_handoff_with_no_repo_changes(self):
        self.pending_browser()
        before_report = self.report.read_bytes()
        spec = self.repo_root / "frontend/tests/browser/spec.ts"
        before_spec = spec.read_bytes()
        old = VerificationEvidence(self.config, self.task_id).data["checks"][self.playwright]
        state, stop, calls = self.direct()
        self.assertEqual(calls, 1)
        self.assertIsNone(stop)
        self.assertEqual(state.state, WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION)
        self.assertEqual(state.assigned_role, Role.SENIOR)
        self.assertEqual(state.model_selection.profile.name, "codex_reviewer_high_risk")
        self.assertEqual(self.report.read_bytes(), before_report)
        self.assertEqual(spec.read_bytes(), before_spec)
        ledger = VerificationEvidence(self.config, self.task_id)
        new = ledger.data["checks"][self.playwright]
        self.assertEqual(new["run_id"], self.runner.current_run_id)
        self.assertEqual(new["outcome"], "PASS")
        self.assertEqual(new["snapshot"], ledger.snapshot(bounded_check(self.playwright)))
        self.assertTrue(new["result_sha256"])
        self.assertTrue(new["recorded_at"])
        self.assertIn(old, ledger.data["history"])
        self.assertNotEqual(old["snapshot"], new["snapshot"])
        self.assertEqual(len(self.current_plan()["reusable_verification"]), 1)
        self.assertTrue(report_completion_valid(self.config, self.task_id, self.report))
        self.assertTrue(self.runner.has_current_verification_record())

    def test_direct_failure_preserves_output_and_routes_implementation(self):
        self.pending_browser()
        state, stop, calls = self.direct(exit_code=1)
        self.assertEqual(calls, 1)
        self.assertEqual(stop.state, WorkflowState.FIX_REQUIRED)
        self.assertEqual(state.state, WorkflowState.FIX_REQUIRED)
        self.assertEqual(state.assigned_role, Role.IMPLEMENTATION)
        self.assertEqual(self.runner.get_status().state, WorkflowState.FIX_REQUIRED)
        record = VerificationEvidence(self.config, self.task_id).data["checks"][self.playwright]
        self.assertEqual(record["outcome"], "FAIL")
        self.assertIn("assertion details", Path(record["output_path"]).read_text())
        self.assertFalse(self.current_plan()["reusable_verification"])
        self.assertFalse(report_completion_valid(self.config, self.task_id, self.report))

    def test_direct_unauthorized_check_stops_before_execution_and_preserves_pending(self):
        self.pending_browser()
        self.write_policy([])
        state, stop, calls = self.direct()
        self.assertEqual(calls, 0)
        self.assertEqual(stop.state, WorkflowState.REQUIRED_VERIFICATION_UNEXECUTABLE)
        self.assertEqual(state.assigned_role, Role.SUPERVISOR)
        self.assertTrue(stop.resume_command)

    def test_missing_ledger_cannot_publish_completion_without_expected_checks(self):
        self.pending_browser()
        VerificationEvidence(self.config, self.task_id).path.unlink()
        state, stop, calls = self.direct()
        self.assertEqual(calls, 0)
        self.assertEqual(stop.state, WorkflowState.REQUIRED_VERIFICATION_UNEXECUTABLE)
        self.assertEqual(state.assigned_role, Role.SUPERVISOR)
        self.assertFalse(report_completion_valid(self.config, self.task_id, self.report))

    def test_pending_status_rejects_report_review_or_content_drift(self):
        self.pending_browser()
        for path in (self.report, self.config.reviews_dir / f"{self.task_id}-review.md",
                     self.repo_root / "frontend/app/handler.ts"):
            original = path.read_bytes()
            stamp = path.stat()
            path.write_bytes(original + b"\nsubsequent unverified change\n")
            self.assertEqual(self.runner.get_status().state, WorkflowState.FIX_REQUIRED)
            path.write_bytes(original)
            os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        self.assertEqual(self.runner.get_status().assigned_role, Role.SUPERVISOR)

    def test_direct_midcommand_content_change_cannot_publish_completion(self):
        self.pending_browser()
        state, stop, calls = self.direct(effect=lambda: self.report.write_text(self.report.read_text()+"\nunverified\n"))
        self.assertEqual(calls, 1)
        self.assertIsNotNone(stop)
        self.assertEqual(state.state, WorkflowState.FIX_REQUIRED)
        self.assertFalse(report_completion_valid(self.config, self.task_id, self.report))

    def test_legacy_invalidation_only_result_can_resume_without_rewriting_history(self):
        self.pending_browser(verify=lambda observe: self.passed(self.typecheck, observe))
        path = completion_path(self.config, self.task_id)
        record = json.loads(path.read_text())
        record.update(status="UNCOMMITTED", success=False, postconditions_valid=False,
                      workflow_transition_valid=False, workflow_state_after="FIX_REQUIRED")
        record.pop("completion_context")
        path.write_text(json.dumps(record))
        stop_path = self.config.runtime_dir / "stop_report.json"
        stop = json.loads(stop_path.read_text())
        stop.update(state="AGENT_RESULT_MISMATCH",
                    reason="INVALIDATED_VERIFICATION_EVIDENCE: affected bounded checks require current-content verification")
        stop_path.write_text(json.dumps(stop))
        self.assertEqual(self.runner.get_status().assigned_role, Role.SUPERVISOR)
        historical = (self.config.runtime_dir / "session.jsonl").read_bytes()
        state, stop, calls = self.direct()
        self.assertIsNone(stop)
        self.assertEqual(calls, 1)
        self.assertEqual(state.assigned_role, Role.SENIOR)
        self.assertEqual((self.config.runtime_dir / "session.jsonl").read_bytes(), historical)

    def test_pending_dry_run_has_zero_execution_and_preserves_attestation(self):
        self.pending_browser()
        before = completion_path(self.config, self.task_id).read_bytes()
        with patch("tools.ks_supervisor.targeted.execute_check", side_effect=AssertionError("Unexpected command")):
            state, stop = self.runner.run_step(dry_run=True)
        self.assertIsNone(stop)
        self.assertEqual(state.assigned_role, Role.SUPERVISOR)
        self.assertEqual(completion_path(self.config, self.task_id).read_bytes(), before)

    def test_cli_direct_transition_accepts_supervisor_evidence_without_agent_invocation(self):
        import contextlib
        import io
        from tools.ks_supervisor.cli import cmd_run
        self.pending_browser()
        def command(config, args, output_path, timeout, heartbeat):
            output_path.write_text("15 passed")
            return 0
        output = io.StringIO()
        with patch("tools.ks_supervisor.targeted.execute_check", side_effect=command), \
                patch("tools.ks_supervisor.adapters.antigravity.AntigravityAdapter.invoke", side_effect=AssertionError("Unexpected Gemini")), \
                patch("tools.ks_supervisor.adapters.codex.CodexAdapter.invoke", side_effect=AssertionError("Unexpected Senior")), \
                patch("tools.ks_supervisor.runner.validate_profile_availability", side_effect=AssertionError("Unexpected discovery")), \
                contextlib.redirect_stdout(output):
            code = cmd_run(self.config, once=True, live=True)
        self.assertEqual(code, 0)
        self.assertIn("zero agent calls", output.getvalue())
        self.assertNotIn("IDENTITY_MISMATCH", output.getvalue())

    def test_direct_timeout_is_pending_with_retained_output(self):
        self.pending_browser()
        def command(config, args, output_path, timeout, heartbeat):
            output_path.write_text("Partial bounded check output")
            raise subprocess.TimeoutExpired(args, timeout)
        with patch("tools.ks_supervisor.targeted.execute_check", side_effect=command):
            state, stop = self.runner.run_step(execute_agents=True)
        self.assertEqual(stop.state, WorkflowState.TARGETED_VERIFICATION_REQUIRED)
        self.assertEqual(state.assigned_role, Role.SUPERVISOR)
        record = VerificationEvidence(self.config, self.task_id).data["checks"][self.playwright]
        self.assertEqual(record["outcome"], "UNAVAILABLE")
        self.assertIn("Partial bounded", Path(record["output_path"]).read_text())

    def test_direct_permission_change_between_checks_fails_closed(self):
        self.pending_browser()
        state, stop, calls = self.direct(effect=lambda: self.write_policy([]))
        self.assertEqual(calls, 1)
        self.assertIsNotNone(stop)
        self.assertFalse(report_completion_valid(self.config, self.task_id, self.report))
        self.assertEqual(state.assigned_role, Role.SUPERVISOR)

    def test_canonical_execution_rejects_playwright_options_or_shell_syntax(self):
        from tools.ks_supervisor.targeted import canonical_argv
        for command in (self.playwright + " --config elsewhere.ts", self.playwright + " --update-snapshots",
                        self.playwright + "; whoami", "pnpm --dir backend test"):
            with self.assertRaises(ValueError):
                canonical_argv(command)

    def test_direct_executor_uses_shell_free_argv_and_heartbeat(self):
        from tools.ks_supervisor.targeted import execute_check
        process = MagicMock()
        process.wait.return_value = 0
        path = self.config.runtime_dir / "executor-output.log"
        heartbeat = MagicMock()
        with patch("tools.ks_supervisor.targeted.shutil.which", return_value="node.exe"), \
                patch("tools.ks_supervisor.targeted.subprocess.Popen", return_value=process) as launch:
            code = execute_check(self.config, ["node", "--test", "backend/dist/tests/a.test.js"], path, 10, heartbeat)
        self.assertEqual(code, 0)
        self.assertFalse(launch.call_args.kwargs["shell"])
        self.assertEqual(launch.call_args.args[0], ["node.exe", "--test", "backend/dist/tests/a.test.js"])
        heartbeat.assert_called_once()

    def test_legacy_recovery_requires_matching_explicit_binding_when_content_hashes_missing(self):
        from tools.ks_supervisor.completion import completion_context
        from tools.ks_supervisor.repo import compute_file_hash
        self.pending_browser()
        runtime = self.config.runtime_dir
        path = completion_path(self.config, self.task_id)
        record = json.loads(path.read_text())
        record.update(status="UNCOMMITTED", success=False, postconditions_valid=False,
                      workflow_transition_valid=False, workflow_state_after="FIX_REQUIRED")
        record.pop("completion_context")
        path.write_text(json.dumps(record))
        stop_path = runtime / "stop_report.json"
        stop = json.loads(stop_path.read_text())
        stop.update(state="AGENT_RESULT_MISMATCH",
                    reason="INVALIDATED_VERIFICATION_EVIDENCE: affected bounded checks require current-content verification")
        stop_path.write_text(json.dumps(stop))
        self.assertEqual(self.runner.get_status().state, WorkflowState.FIX_REQUIRED)
        binding = {"authorization": "EXPLICIT_USER_INVALIDATION_ONLY_RECOVERY", "invocation": record["invocation"],
                   "report_sha256": record["report_sha256"], "completion_context": completion_context(self.config, self.task_id),
                   "sources": {n:compute_file_hash(runtime / n) for n in ("last_agent_run.json", "session.jsonl", "stop_report.json")}}
        binding_path = runtime / "completion_recovery" / f"{record['run_id']}.json"
        binding_path.parent.mkdir()
        binding_path.write_text(json.dumps(binding))
        self.assertEqual(self.runner.get_status().assigned_role, Role.SUPERVISOR)
        binding["sources"]["last_agent_run.json"] = "wrong"
        binding_path.write_text(json.dumps(binding))
        self.assertEqual(self.runner.get_status().state, WorkflowState.FIX_REQUIRED)

    def test_affected_verification_after_edit_restores_completion_eligibility(self):
        self.passed(self.typecheck)
        def edit():
            (self.repo_root / "frontend/app/handler.ts").write_text("// verified correction\n")
        state, stop = self.attempt(edit=edit, verify=lambda observe: self.passed(self.typecheck, observe))
        self.assertIsNone(stop)
        self.assertEqual(state.state, WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION)
        self.assertTrue(report_completion_valid(self.config, self.task_id, self.report))

    def test_unexecuted_claim_or_midcommand_content_change_is_not_pass(self):
        self.evidence.observe({"type": "result", "result": "15 passed"}, "claim-run")
        self.evidence.observe(self.event(self.typecheck, "DONE", "PASS", 0), "claim-run")
        self.assertEqual(self.current_plan()["reusable_verification"], [])
        self.evidence.observe(self.event(self.typecheck, "ACTIVE"), "changing-run")
        (self.repo_root / "frontend/app/handler.ts").write_text("// changed while checking\n")
        self.evidence.observe(self.event(self.typecheck, "DONE", "PASS", 0), "changing-run")
        self.assertEqual(self.current_plan()["reusable_verification"], [])

    def test_failed_check_invalidates_but_permission_or_timeout_does_not_erase_pass(self):
        self.passed(self.typecheck)
        self.evidence.observe(self.event(self.typecheck, "ACTIVE"), "denied-run")
        self.evidence.observe(self.event(self.typecheck, "ERROR", "permission denied"), "denied-run")
        self.assertEqual(len(self.current_plan()["reusable_verification"]), 1)
        self.evidence.observe(self.event(self.typecheck, "ACTIVE"), "failed-run")
        self.evidence.observe(self.event(self.typecheck, "DONE", "error TS1000", 1), "failed-run")
        self.assertEqual(self.current_plan()["reusable_verification"], [])
        self.assertTrue(self.current_plan()["required_verification"])

    def test_corrupt_or_other_task_ledger_does_not_supply_passes(self):
        self.passed(self.typecheck)
        self.evidence.data["task_id"] = "TASK-OTHER"
        self.evidence.save()
        plan = self.current_plan()
        self.assertEqual(plan["reusable_verification"], [])
        self.assertTrue(plan["verification_gaps"])

    def test_async_command_requires_matching_terminal_status_before_pass(self):
        self.evidence.observe(self.event(self.typecheck, "ACTIVE"), "async-run")
        self.evidence.observe(self.event(self.typecheck, "DONE", "Background command\nCommand ID: check-123"), "async-run")
        self.assertEqual(self.current_plan()["reusable_verification"], [])
        status = {"event": "step_update", "step_update": {"step_index": 2, "state": "DONE",
                  "tool_name": "command_status", "tool_info": {"parameters": {"CommandId": "check-123"},
                  "output": "Exit code: 0"}}}
        self.evidence.observe(status, "wrong-run")
        self.assertEqual(self.current_plan()["reusable_verification"], [])
        self.evidence.observe(status, "async-run")
        self.assertEqual(len(self.current_plan()["reusable_verification"]), 1)

    def test_playwright_terminal_pass_summary_without_exit_field_is_captured(self):
        self.evidence.observe(self.event(self.playwright, "ACTIVE"), "browser-run")
        self.evidence.observe(self.event(self.playwright, "DONE", "Running 15 tests\n15 passed (41.1s)"), "browser-run")
        self.assertEqual(len(self.current_plan()["reusable_verification"]), 1)
        self.assertEqual(self.current_plan()["reusable_verification"][0]["result_summary"], "15 passed")

    def test_adapter_stream_delivers_verification_events_at_execution_time(self):
        adapter = AntigravityAdapter(self.config)
        events = [self.event(self.playwright, "ACTIVE"), self.event(self.playwright, "DONE", "15 passed", 0)]
        proc = MagicMock()
        proc.pid = 9999
        proc.returncode = 0
        proc.poll.side_effect = [None, 0]
        proc.stdout.readline.side_effect = [json.dumps(e) + "\n" for e in events] + ["\n", ""]
        proc.stderr.readline.side_effect = [""]
        original_popen = subprocess.Popen
        def popen(argv, *args, **kwargs):
            if argv[0] == "agy-fixture":
                self.assertEqual(argv[argv.index("--project") + 1], CLI_PROJECT)
                self.assertEqual(argv[argv.index("--effort") + 1], "medium")
                self.assertEqual(argv[argv.index("--model") + 1], "gemini-3.7-flash-medium")
                return proc
            return original_popen(argv, *args, **kwargs)
        with patch.object(adapter, "check_availability", return_value={"available": True, "binary": "agy-fixture"}), \
                patch("subprocess.Popen", side_effect=popen):
            adapter.invoke(Role.IMPLEMENTATION, self.task_id, prompt="fixture", run_id="stream-run",
                           verification_observer=lambda e: self.evidence.observe(e, "stream-run"))
        self.assertEqual(len(self.current_plan()["reusable_verification"]), 1)

    def test_unknown_completion_or_different_workspace_is_not_pass(self):
        self.evidence.observe(self.event(self.typecheck, "ACTIVE"), "unknown-run")
        self.evidence.observe(self.event(self.typecheck, "DONE", ""), "unknown-run")
        self.assertEqual(self.current_plan()["reusable_verification"], [])
        active = self.event(self.typecheck, "ACTIVE")
        active["step_update"]["tool_info"]["parameters"]["Cwd"] = str(self.repo_root.parent)
        self.evidence.observe(active, "other-workspace")
        self.evidence.observe(self.event(self.typecheck, "DONE", "PASS", 0), "other-workspace")
        self.assertEqual(self.current_plan()["reusable_verification"], [])

    def test_content_race_before_attestation_publication_does_not_promote(self):
        self.passed(self.typecheck)
        original_telemetry = self.runner._record_session_telemetry
        def telemetry(*args, **kwargs):
            original_telemetry(*args, **kwargs)
            (self.repo_root / "frontend/app/handler.ts").write_text("// unverified later content\n")
        with patch.object(self.runner, "_record_session_telemetry", side_effect=telemetry):
            _, stop = self.attempt(edit=lambda: self.report.write_text(self.report.read_text()+"\nEvidence correction\n"))
        self.assertIsNotNone(stop)
        self.assertFalse(report_completion_valid(self.config, self.task_id, self.report))
        self.assertEqual(self.runner.get_status().state, WorkflowState.FIX_REQUIRED)

    def test_required_command_preflight_maps_only_executable_suffix(self):
        self.passed(self.backend)
        (self.repo_root / "backend/src/handler.ts").write_text("// correction\n")
        self.write_policy(["command(regex:pnpm\\.cmd --dir backend run build)"])
        item = self.current_plan()["required_verification"][0]
        self.assertEqual(item["command"], "pnpm.cmd --dir backend run build")
        self.assertTrue(item["authorized"])
        self.assertEqual(item["proposed_command"], self.backend)
        self.assertEqual(item["subsystem"], "backend")

    def test_unexecutable_required_check_stops_before_any_agent_or_workflow_write(self):
        self.passed(self.typecheck)
        (self.repo_root / "frontend/app/handler.ts").write_text("// correction\n")
        self.write_policy([])
        before = {p: p.read_bytes() for p in (self.report, self.config.checkpoint_path,
                                             next(self.config.tasks_dir.glob(f"{self.task_id}*.md")))}
        with patch.object(self.runner.antigravity_adapter, "invoke") as invoke:
            _, stop = self.runner.run_step(execute_agents=True)
        invoke.assert_not_called()
        self.assertEqual(stop.state, WorkflowState.REQUIRED_VERIFICATION_UNEXECUTABLE)
        self.assertFalse(self.runner.current_invocation)
        self.assertFalse(self.runner.current_agent_result)
        self.assertFalse((self.config.runtime_dir / "last_agent_run.json").exists())
        for p, content in before.items():
            self.assertEqual(p.read_bytes(), content)
        denied = stop.evidence["unexecutable_checks"][0]
        self.assertEqual(denied["command"], self.typecheck)
        self.assertIn("Allow", denied["authorization_reason"])
        self.assertEqual(self.runner.fix_cycles, {})

    def test_unknown_legacy_required_command_is_not_replaced_with_build(self):
        command = "pnpm --dir backend run test:fast"
        self.evidence.data["checks"][command] = {"outcome": "PASS"}
        self.evidence.save()
        with patch.object(self.runner.antigravity_adapter, "invoke") as invoke:
            _, stop = self.runner.run_step(execute_agents=True)
        invoke.assert_not_called()
        self.assertEqual(stop.state, WorkflowState.REQUIRED_VERIFICATION_UNEXECUTABLE)
        self.assertEqual(stop.evidence["unexecutable_checks"][0]["command"], command)

    def test_frontend_browser_coverage_excludes_backend_and_survives_backend_changes(self):
        self.passed(self.playwright)
        record = self.evidence.data["checks"][self.playwright]
        self.assertFalse(any(n.startswith("backend/") for n in record["snapshot"]["files"]))
        (self.repo_root / "backend/src/handler.ts").write_text("// unrelated backend\n")
        self.assertEqual(len(self.current_plan()["reusable_verification"]), 1)

    def test_subsystem_package_config_and_root_lock_inputs_invalidate(self):
        for name in ("frontend/package.json", "frontend/playwright.config.ts", "backend/package.json",
                     "backend/tsconfig.json", "pnpm-lock.yaml", "package.json"):
            p = self.repo_root / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("original")
        self.passed(self.playwright)
        self.passed(self.backend)
        for name in ("frontend/package.json", "frontend/playwright.config.ts", "backend/package.json",
                     "backend/tsconfig.json", "pnpm-lock.yaml", "package.json"):
            with self.subTest(name=name):
                p = self.repo_root / name
                p.write_text("changed")
                commands = {i["proposed_command"] for i in self.current_plan()["invalidated_verification"]}
                expected = {self.playwright} if name.startswith("frontend/") else (
                    {self.backend} if name.startswith("backend/") else {self.playwright, self.backend})
                self.assertEqual(commands, expected)
                p.write_text("original")

    def test_legacy_browser_scope_narrows_only_captured_hashes_without_rewriting(self):
        self.passed(self.playwright)
        record = self.evidence.data["checks"][self.playwright]
        record["check"]["scopes"] = ["backend", "frontend"]
        record["snapshot"] = self.evidence.snapshot(record["check"])
        self.evidence.save()
        original = self.evidence.path.read_bytes()
        (self.repo_root / "backend/src/handler.ts").write_text("// unrelated backend\n")
        item = self.current_plan()["reusable_verification"][0]
        self.assertIn("legacy narrowed", item["coverage_interpretation"])
        self.assertFalse(any(n.startswith("backend/") for n in item["covered_files"]))
        self.assertEqual(self.evidence.path.read_bytes(), original)
        (self.repo_root / "frontend/app/handler.ts").write_text("// relevant correction\n")
        self.assertTrue(self.current_plan()["required_verification"])

    def test_legacy_missing_frontend_hash_requires_recertification(self):
        self.passed(self.playwright)
        record = self.evidence.data["checks"][self.playwright]
        record["check"]["scopes"] = ["backend", "frontend"]
        record["snapshot"]["files"].pop("frontend/app/handler.ts")
        self.evidence.save()
        self.assertEqual(self.current_plan()["reusable_verification"], [])
        self.assertTrue(self.current_plan()["required_verification"])

    def test_frozen_plan_bound_to_run_and_telemetry_distinguishes_invented_request(self):
        self.passed(self.playwright)
        def verify(observe):
            observe(self.event("pnpm --dir backend run test:fast", "ACTIVE"))
        _, stop = self.attempt(verify=verify, success=False, soft_permission_denial=True, denied_actions=["command"])
        self.assertEqual(stop.state, WorkflowState.AGENT_PERMISSION_REQUIRED)
        telemetry = json.loads((self.config.runtime_dir / "last_agent_run.json").read_text())
        summary = telemetry["stream_summary"]
        plan = json.loads(Path(summary["verification_plan_path"]).read_text())
        self.assertEqual(plan["run_id"], telemetry["run_id"])
        self.assertEqual(plan["plan"]["required_verification"], [])
        item = plan["plan"]["reusable_verification"][0]
        for key in ("check_id", "command", "subsystem", "coverage_scope", "authorized", "status", "invalidated_by"):
            self.assertIn(key, item)
        self.assertEqual(item["status"], "reusable")
        attempt = summary["verification_attempts"][0]
        self.assertEqual(attempt["kind"], "AGENT_INVENTED_VERIFICATION")
        self.assertFalse(attempt["planner_required"])
        self.assertTrue(attempt["out_of_plan"])
        self.assertTrue(Path(summary["verification_plan_path"]).with_suffix(".attempts.json").exists())

    def test_required_attempt_and_equivalent_reusable_attempt_have_distinct_diagnostics(self):
        self.passed(self.backend)
        (self.repo_root / "backend/src/handler.ts").write_text("// correction\n")
        plan = self.evidence.plan()
        self.evidence.freeze("required-run", plan)
        self.evidence.observe(self.event(self.backend, "ACTIVE"), "required-run")
        self.assertEqual(self.evidence.attempts[-1]["kind"], "PLANNER_REQUIRED_VERIFICATION")
        self.passed(self.playwright)
        self.evidence.freeze("redundant-run", self.evidence.plan())
        self.evidence.observe(self.event(self.playwright.replace("pnpm ", "pnpm.cmd "), "ACTIVE"), "redundant-run")
        self.assertEqual(self.evidence.attempts[-1]["kind"], "REDUNDANT_VERIFICATION_REQUEST")
        self.assertTrue(self.evidence.attempts[-1]["out_of_plan"])

    def test_frozen_plan_is_not_overwritten(self):
        self.evidence.freeze("frozen-run", self.evidence.plan())
        original = self.evidence.plan_path.read_bytes()
        with self.assertRaises(FileExistsError):
            self.evidence.freeze("frozen-run", {})
        self.assertEqual(self.evidence.plan_path.read_bytes(), original)

    def test_permission_deny_and_ask_override_allow_and_no_policy_write(self):
        for name in ("deny", "ask"):
            self.write_policy([f"command({self.backend})"], **{name: [f"command({self.backend})"]})
            before = self.policy_project.read_bytes()
            self.assertFalse(CommandPermissions().authorized(self.backend)[0])
            self.assertEqual(self.policy_project.read_bytes(), before)

    def test_global_ask_overrides_project_allow(self):
        self.policy_settings.write_text(json.dumps({"permissions": {"ask": [f"command({self.backend})"]}}))
        self.assertFalse(CommandPermissions().authorized(self.backend)[0])

    def test_missing_and_malformed_permission_policy_fail_closed(self):
        self.policy_settings.unlink()
        self.assertFalse(CommandPermissions().authorized(self.backend)[0])
        self.policy_settings.write_text('{}')
        self.write_policy(["command(regex:[)"])
        self.assertFalse(CommandPermissions().authorized(self.backend)[0])

    def test_existing_allow_rules_do_not_blanket_authorize_test_fast_or_chaining(self):
        permissions = CommandPermissions()
        self.assertTrue(permissions.authorized(self.backend)[0])
        self.assertFalse(permissions.authorized("pnpm --dir backend run test:fast")[0])
        for command in (self.backend + "; " + self.typecheck, "node --test backend/dist/tests/*"):
            self.assertIsNone(bounded_check(command))

    def test_normal_implementation_prompt_contains_shared_frozen_plan_policy(self):
        self.passed(self.playwright)
        prompt = self.runner.antigravity_adapter.build_prompt(Role.IMPLEMENTATION, self.task_id,
                                                              is_fix=False, verification_plan=self.current_plan())
        self.assertEqual(prompt.count("### Mandatory Continuation Verification Plan"), 1)
        self.assertIn("canonical authorized forms", prompt)
        self.assertIn("never invent test:fast", prompt)
        self.assertIn("DO NOT execute or request that command", prompt)

    def test_authorized_required_plan_exists_before_single_provider_invocation(self):
        self.passed(self.backend)
        (self.repo_root / "backend/src/handler.ts").write_text("// correction\n")
        def verify(observe):
            path = self.config.runtime_dir / "verification_plans" / f"{self.runner.current_run_id}.json"
            frozen = json.loads(path.read_text())
            required = frozen["plan"]["required_verification"][0]
            self.assertTrue(required["authorized"])
            self.assertEqual(required["status"], "required")
            self.assertEqual(required["command"], self.backend)
            self.passed(self.backend, observe)
        _, stop = self.attempt(edit=lambda: self.report.write_text(self.report.read_text()+"\nCorrection evidence\n"), verify=verify)
        self.assertIsNone(stop)

    def test_permission_policy_change_after_freeze_stops_before_provider(self):
        original = self.runner.antigravity_adapter.build_prompt
        def build(*args, **kwargs):
            prompt = original(*args, **kwargs)
            self.write_policy([])
            return prompt
        with patch.object(self.runner.antigravity_adapter, "build_prompt", side_effect=build), \
                patch.object(self.runner.antigravity_adapter, "invoke") as invoke:
            _, stop = self.runner.run_step(execute_agents=True)
        invoke.assert_not_called()
        self.assertEqual(stop.state, WorkflowState.REQUIRED_VERIFICATION_UNEXECUTABLE)
        self.assertIn("policy changed", stop.reason)

    def test_explicit_ignored_compiled_test_is_fingerprinted(self):
        (self.repo_root / ".gitignore").write_text("backend/dist/\n")
        target = self.repo_root / "backend/dist/tests/focused.js"
        target.parent.mkdir(parents=True)
        target.write_text("// actual test\n")
        command = "node --test backend/dist/tests/focused.js"
        self.passed(command)
        self.assertIn("backend/dist/tests/focused.js", self.current_plan()["reusable_verification"][0]["covered_files"])
        target.write_text("// different test\n")
        self.assertTrue(self.current_plan()["required_verification"])
