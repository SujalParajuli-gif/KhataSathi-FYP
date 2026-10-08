"""V3 deterministic surfaces and a Codex-owned, entirely mocked lifecycle.

Tests mutate only BaseSupervisorTestCase's disposable Git repositories. No real
provider, DB, package command, migration or current application task is invoked.
"""
import contextlib
import io
import json
from pathlib import Path
from unittest.mock import patch

from tools.ks_supervisor.cli import main
from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase
from tools.ks_supervisor.toolbox import (
    CycleLedger, SourcePermissions, delegate_gemini, inspect_repository,
    record_cycle, source_identity, verify_source, worker_prompt,
)
from tools.ks_supervisor.types import AgentResult, Role
from tools.ks_supervisor.repo import run_git
from tools.ks_supervisor.state import find_task_file, find_plan_file


class V3ToolboxTests(BaseSupervisorTestCase):
    def setUp(self):
        super().setUp()
        self.task_id = "TASK-2A-002"
        self.write_checkpoint(current_task=self.task_id)
        self.task_path = self.write_task(task_id=self.task_id)
        self.source = self.repo_root / "backend/src/partial.ts"
        self.source.parent.mkdir(parents=True, exist_ok=True)
        self.source.write_text("existing partial implementation\n", encoding="utf-8")
        self.report = self.config.reports_dir / f"{self.task_id}-implementation.md"
        self.review = self.config.reviews_dir / f"{self.task_id}-review.md"

    def plan(self, text="Final plan disposition: IMPLEMENTATION-READY."):
        path = self.config.plans_dir / f"{self.task_id}-plan.md"
        path.write_text(text, encoding="utf-8")
        return path

    def mock_worker(self, role, task_id, **kwargs):
        self.source.write_text(self.source.read_text() + "worker continuation\n", encoding="utf-8")
        with self.report.open("ab") as stream:
            stream.write((f"\n## Worker turn {kwargs['run_id']}\nStatus: COMPLETE — AWAITING SENIOR REVIEW\n"
                          "Checks: NOT RUN by v3 worker.\n").encode())
        return self.result(task_id, kwargs["run_id"])

    def result(self, task_id, run_id, **overrides):
        fields = dict(role=Role.IMPLEMENTATION, task_id=task_id, run_id=run_id,
                      exit_code=0, stdout="", stderr="", duration_seconds=1, success=True,
                      process_started=True, process_completed=True, session_id="mock-session",
                      token_usage={"input_tokens": 21}, provider="antigravity",
                      model_name="gemini-3.7-flash-medium", effort="medium")
        fields.update(overrides)
        return AgentResult(**fields)

    def inspect_cli(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(["--repo", str(self.repo_root), "inspect", "--json"])
        self.assertEqual(code, 0)
        return json.loads(output.getvalue())

    def test_inspect_json_authority_is_read_only(self):
        before = self.config.checkpoint_path.read_bytes()
        result = self.inspect_cli()
        self.assertEqual(result["active_task"], self.task_id)
        self.assertEqual(result["branch"], "feat/phase-1a-test")
        self.assertIn("backend/src/", " ".join(result["dirty_paths"]))
        self.assertEqual(result["task_status"], "READY")
        self.assertEqual(result["phase"], "1A")
        self.assertIn("configured DB writes", " ".join(result["gated_operations"]))
        self.assertEqual(self.config.checkpoint_path.read_bytes(), before)
        self.assertFalse(CycleLedger(self.config).path.exists())

    def test_no_task_recommends_task_definition(self):
        self.write_checkpoint(current_task="")
        info = self.inspect_cli()
        self.assertIsNone(info["active_task"])
        self.assertEqual(info["recommended_category"], "TASK_DEFINITION")

    def test_missing_and_incomplete_plan_cannot_delegate(self):
        self.write_task(task_id=self.task_id, planning_required="YES", execution_mode="PLANNED_IMPLEMENTATION")
        for content in (None, "# Plan\n- TODO: IMPLEMENTATION-READY", "Final plan disposition: DRAFT."):
            if content is not None:
                self.plan(content)
            self.assertEqual(inspect_repository(self.config)["recommended_category"], "PLAN")
            with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke") as invoke:
                with self.assertRaises(ValueError):
                    delegate_gemini(self.config, self.task_id)
                invoke.assert_not_called()

    def test_final_disposition_wins_over_earlier_ready(self):
        self.write_task(task_id=self.task_id, planning_required="YES")
        self.plan("Final plan disposition: IMPLEMENTATION-READY.\nFinal plan disposition: INCOMPLETE.")
        self.assertEqual(inspect_repository(self.config)["plan"]["state"], "INCOMPLETE")

    def test_ready_plan_delegates_and_preserves_partial_work(self):
        self.write_task(task_id=self.task_id, planning_required="YES")
        plan = self.plan("**Final plan disposition: IMPLEMENTATION-READY.** Source readiness only.")
        plan_before = plan.read_bytes()
        checkpoint_before = self.config.checkpoint_path.read_bytes()
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=self.mock_worker) as invoke:
            result = delegate_gemini(self.config, self.task_id)
        self.assertEqual(result["outcome"], "SUCCESS")
        self.assertEqual(result["result"]["session_id"], "mock-session")
        self.assertEqual(invoke.call_count, 1)
        self.assertIn("existing partial implementation", self.source.read_text())
        self.assertEqual(plan.read_bytes(), plan_before)
        self.assertEqual(self.config.checkpoint_path.read_bytes(), checkpoint_before)
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "CODEX_VERIFY")
        runtime = Path(result["cycle"]["record"]["runtime_location"])
        self.assertTrue((runtime / "launch.json").exists())
        self.assertTrue((runtime / "return.json").exists())

    def test_worker_prompt_forbids_shell_and_requires_no_verification_request(self):
        info = inspect_repository(self.config)
        prompt = worker_prompt(self.config, self.task_id, "implement", info)
        for requirement in ("Do not use RunCommand", "Do not run tests", "Prisma", "Git", "servers", "connected DB",
                            "Continue existing partial", "GEMINI.md", "NOT RUN", "No verification command request/execution"):
            self.assertIn(requirement, prompt)
        self.assertNotIn("run every shell", prompt.lower())
        # No verification observer/completion marker is needed for a real file effect.
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=self.mock_worker):
            self.assertEqual(delegate_gemini(self.config, self.task_id)["outcome"], "SUCCESS")

    def test_latest_fix_required_passes_exact_remaining_blockers(self):
        self.review.write_text("Decision: FIX_REQUIRED\nRemaining blockers: B-1, B-2\n- B-1 old\n- B-2 old\n", encoding="utf-8")
        with self.review.open("a", encoding="utf-8") as stream:
            stream.write("\n## Senior review follow-up\n- B-2: preserve payment replay payload\n"
                         "\n## Current targeted verification\nDecision: FIX_REQUIRED\nRemaining blockers: B-2\n")
        info = inspect_repository(self.config)
        self.assertEqual(info["unresolved_blockers"], ["B-2"])
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=self.mock_worker) as invoke:
            result = delegate_gemini(self.config, self.task_id, "fix")
        prompt = invoke.call_args.kwargs["prompt"]
        self.assertIn("preserve payment replay payload", prompt)
        self.assertNotIn("B-1 old", prompt)
        self.assertIn("Current review SHA256", prompt)
        self.assertEqual(result["outcome"], "SUCCESS")

    def test_fix_without_failure_packet_is_rejected(self):
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke") as invoke:
            with self.assertRaisesRegex(ValueError, "Fix requires"):
                delegate_gemini(self.config, self.task_id, "fix")
            invoke.assert_not_called()

    def test_verification_failure_requests_targeted_worker_fix(self):
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=self.mock_worker):
            delegate_gemini(self.config, self.task_id)
        with patch("tools.ks_supervisor.targeted.execute_check", return_value=1):
            result = verify_source(self.config, self.task_id, ["pnpm --dir backend run build"], source_identity(self.config), True)
        self.assertEqual(result["outcome"], "FAIL")
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "GEMINI_FIX")
        packet = self.repo_root / "docs/engineering/ai/reports/correction.json"
        packet.write_text(json.dumps({"task_id": self.task_id, "content_identity": source_identity(self.config),
                                      "failures": [{"id": "C-1", "command": "backend build", "diagnostic": "TS2322", "correction": "repair type"}]}), encoding="utf-8")
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=self.mock_worker) as invoke:
            delegate_gemini(self.config, self.task_id, "fix", packet)
        self.assertIn("TS2322", invoke.call_args.kwargs["prompt"])

    def test_source_reuses_valid_content_bound_evidence(self):
        commands = ["pnpm --dir backend run build"]
        with patch("tools.ks_supervisor.targeted.execute_check", return_value=0) as execute:
            first = verify_source(self.config, self.task_id, commands, source_identity(self.config), True)
            second = verify_source(self.config, self.task_id, commands, source_identity(self.config), True)
            self.assertEqual(execute.call_count, 1)
        self.assertEqual(first["outcome"], "PASS")
        self.assertTrue(second["checks"][0]["reused"])
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "CODEX_REVIEW")
        self.source.write_text("new content", encoding="utf-8")
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "CODEX_VERIFY")

    def test_content_change_before_verification_fails_closed(self):
        identity = source_identity(self.config)
        self.source.write_text("new input", encoding="utf-8")
        with patch("tools.ks_supervisor.targeted.execute_check") as execute:
            with self.assertRaisesRegex(ValueError, "Content changed"):
                verify_source(self.config, self.task_id, ["pnpm --dir backend run build"], identity, True)
            execute.assert_not_called()

    def test_new_review_cannot_be_hidden_by_old_verification_pass(self):
        with patch("tools.ks_supervisor.targeted.execute_check", return_value=0):
            verify_source(self.config, self.task_id, ["pnpm --dir backend run build"], source_identity(self.config), True)
        self.review.write_text("Decision: FIX_REQUIRED\nRemaining blockers: B-1\n- B-1: missing idempotency\n", encoding="utf-8")
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "GEMINI_FIX")

    def test_accepted_closeout_and_next_categories_never_reopen(self):
        self.review.write_text("Decision: APPROVED\nRemaining blockers: NONE\n", encoding="utf-8")
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "CLOSEOUT")
        self.write_task(task_id=self.task_id, status="ACCEPTED", planning_required="YES")
        self.write_checkpoint(current_task=self.task_id, task_status="ACCEPTED")
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "ACCEPTED_HYGIENE")
        with self.assertRaisesRegex(ValueError, "permanently accepted"):
            delegate_gemini(self.config, self.task_id)
        self.write_checkpoint(current_task="")
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "TASK_DEFINITION")

    def test_task_2a_001_permanently_accepted(self):
        self.write_task(task_id="TASK-2A-001", status="ACCEPTED")
        self.write_checkpoint(current_task="TASK-2A-001", task_status="ACCEPTED")
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke") as invoke:
            with self.assertRaises(ValueError):
                delegate_gemini(self.config, "TASK-2A-001", "fix")
            invoke.assert_not_called()

    def test_unknown_task_or_wrong_branch_never_invokes(self):
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke") as invoke:
            with self.assertRaises(ValueError):
                delegate_gemini(self.config, "TASK-WRONG")
            self.write_task(task_id=self.task_id, branch="feat/other")
            with self.assertRaises(ValueError):
                delegate_gemini(self.config, self.task_id)
            invoke.assert_not_called()

    def test_db_gate_immediate_human_stop(self):
        result = record_cycle(self.config, self.task_id, "verification", "HUMAN_GATE",
                              reason="Connected MySQL fixtures require target-specific authorization")
        self.assertEqual(result["budget"]["status"], "HUMAN_INPUT_REQUIRED")
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "HUMAN_INPUT_REQUIRED")
        self.assertFalse(inspect_repository(self.config)["allowed_operations"]["verify_source"])
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke") as invoke:
            with self.assertRaises(ValueError):
                delegate_gemini(self.config, self.task_id)
            invoke.assert_not_called()

    def test_auth_quota_stops_immediately(self):
        def quota(role, task_id, **kwargs):
            return self.result(task_id, kwargs["run_id"], success=False, auth_or_quota_failure=True,
                               error_message="Quota exhausted; account intervention required")
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=quota) as invoke:
            result = delegate_gemini(self.config, self.task_id)
            self.assertEqual(result["next"], "HUMAN_INPUT_REQUIRED")
            with self.assertRaises(ValueError):
                delegate_gemini(self.config, self.task_id)
            self.assertEqual(invoke.call_count, 1)

    def test_same_infrastructure_failure_initial_plus_two_retries(self):
        def unavailable(role, task_id, **kwargs):
            return self.result(task_id, kwargs["run_id"], success=False, error_message="CLI unavailable")
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=unavailable) as invoke:
            for expected in ("CONTINUE", "CONTINUE", "HUMAN_INPUT_REQUIRED"):
                result = delegate_gemini(self.config, self.task_id)
                self.assertEqual(result["cycle"]["budget"]["status"], expected)
            with self.assertRaises(ValueError):
                delegate_gemini(self.config, self.task_id)
            self.assertEqual(invoke.call_count, 3)

    def test_repeated_no_effect_is_bounded(self):
        def no_effect(role, task_id, **kwargs):
            return self.result(task_id, kwargs["run_id"])
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=no_effect) as invoke:
            self.assertEqual(delegate_gemini(self.config, self.task_id)["outcome"], "NO_EFFECT")
            self.assertEqual(delegate_gemini(self.config, self.task_id)["next"], "HUMAN_INPUT_REQUIRED")
            with self.assertRaises(ValueError):
                delegate_gemini(self.config, self.task_id)
            self.assertEqual(invoke.call_count, 2)

    def test_blocker_reduction_vs_replacement_and_stagnation(self):
        ledger = CycleLedger(self.config)
        for blockers in (["B-1", "B-2", "B-3"], ["B-1", "B-2"], ["B-2"]):
            result = ledger.append(self.task_id, "review", "FIX_REQUIRED", blockers)
            self.assertEqual(result["budget"]["stagnant_corrections"], 0)
        for blockers, count in ((["B-9"], 1), (["B-9"], 2), (["B-9"], 3)):
            result = ledger.append(self.task_id, "review", "FIX_REQUIRED", blockers)
            self.assertEqual(result["budget"]["stagnant_corrections"], count)
        self.assertEqual(result["budget"]["status"], "HUMAN_INPUT_REQUIRED")

    def test_finite_budget_even_with_progress_and_corrupt_history_fails(self):
        ledger = CycleLedger(self.config)
        for i in range(60):
            result = ledger.append(self.task_id, "reanchor", "PASS", reason=str(i))
        self.assertEqual(result["budget"]["status"], "HUMAN_INPUT_REQUIRED")
        ledger.path.write_text("not json\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Unreadable cycle"):
            ledger.append(self.task_id, "worker", "SUCCESS")

    def test_no_broad_or_destructive_or_connected_checks(self):
        commands = ["git reset --hard", "git clean -fd", "pnpm --dir backend exec prisma migrate deploy",
                    "node --test backend/dist/tests/mysqlFixtures.test.js", "pnpm --dir backend run dev",
                    "pnpm --dir backend run build; git reset --hard", "ssh production deploy", "pnpm --dir frontend exec playwright test tests/browser/connected.spec.ts"]
        with patch("tools.ks_supervisor.targeted.execute_check") as execute:
            for command in commands:
                with self.assertRaises(ValueError):
                    verify_source(self.config, self.task_id, ["pnpm --dir backend run build", command], source_identity(self.config), True)
            execute.assert_not_called()
        policy = SourcePermissions()
        policy.rules["allow"].append("command(*)")
        self.assertFalse(policy.authorized("pnpm --dir backend run build")[0])

    def test_empty_or_unreviewed_checks_do_not_certify(self):
        for commands, reviewed in (([], True), (["pnpm --dir backend run build"], False)):
            with self.assertRaises(ValueError):
                verify_source(self.config, self.task_id, commands, source_identity(self.config), reviewed)

    def test_v3_inspection_and_verification_do_not_require_gemini_shell_permissions(self):
        with patch("tools.ks_supervisor.verification.CommandPermissions", side_effect=AssertionError("Provider shell grants must not govern v3 source checks")):
            info = inspect_repository(self.config)
            self.assertEqual(info["verification"]["permission_policy"]["owner"], "Codex Senior")
            with patch("tools.ks_supervisor.targeted.execute_check", return_value=0):
                result = verify_source(self.config, self.task_id, ["pnpm --dir backend run build"], source_identity(self.config), True)
            self.assertEqual(result["outcome"], "PASS")

    def test_worker_protected_mutation_detected_without_reset(self):
        original = self.config.checkpoint_path.read_text()
        def corrupt(role, task_id, **kwargs):
            self.config.checkpoint_path.write_text(original + "unauthorized\n", encoding="utf-8")
            return self.result(task_id, kwargs["run_id"])
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=corrupt):
            result = delegate_gemini(self.config, self.task_id)
        self.assertEqual(result["outcome"], "HUMAN_GATE")
        self.assertIn("protected authority", " ".join(result["violations"]))
        self.assertTrue(self.config.checkpoint_path.read_text().endswith("unauthorized\n"))

    def test_worker_shell_attempt_detected(self):
        def attempt(role, task_id, **kwargs):
            kwargs["verification_observer"]({"type": "tool_call", "name": "RunCommand", "command": "pnpm --dir backend run build"})
            return self.mock_worker(role, task_id, **kwargs)
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=attempt):
            result = delegate_gemini(self.config, self.task_id)
        self.assertEqual(result["outcome"], "HUMAN_GATE")

    def test_worker_cannot_rewrite_existing_runtime_proof(self):
        proof = self.config.runtime_dir / "prior-proof.json"
        proof.write_text('{"outcome":"FAIL"}', encoding="utf-8")
        def rewrite(role, task_id, **kwargs):
            proof.write_text('{"outcome":"PASS"}', encoding="utf-8")
            return self.mock_worker(role, task_id, **kwargs)
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=rewrite):
            result = delegate_gemini(self.config, self.task_id)
        self.assertEqual(result["outcome"], "HUMAN_GATE")
        self.assertIn("existing runtime authority", " ".join(result["violations"]))

    def test_cycles_cannot_invent_review_or_acceptance(self):
        with self.assertRaises(ValueError):
            record_cycle(self.config, self.task_id, "review", "APPROVED")
        with self.assertRaises(ValueError):
            record_cycle(self.config, self.task_id, "closeout", "ACCEPTED")

    def test_cli_verification_preserves_subcommand_and_json(self):
        output = io.StringIO()
        with patch("tools.ks_supervisor.targeted.execute_check", return_value=0), contextlib.redirect_stdout(output):
            code = main(["--repo", str(self.repo_root), "verify-source", "--task", self.task_id,
                         "--command", "pnpm --dir backend run build", "--content-identity", source_identity(self.config), "--source-reviewed", "--json"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["outcome"], "PASS")

    def test_old_workflow_never_delegates(self):
        self.write_checkpoint(workflow_version="1", current_task=self.task_id)
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke") as invoke:
            with self.assertRaises(ValueError):
                delegate_gemini(self.config, self.task_id)
            invoke.assert_not_called()

    def test_worker_identity_mismatch_is_a_human_gate(self):
        def mismatch(role, task_id, **kwargs):
            return self.result(task_id, "wrong-run-id")
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=mismatch):
            self.assertEqual(delegate_gemini(self.config, self.task_id)["outcome"], "HUMAN_GATE")

    def test_report_only_worker_rewrite_cannot_count_as_source_progress(self):
        def report_only(role, task_id, **kwargs):
            self.report.write_text("Status: COMPLETE\n", encoding="utf-8")
            return self.result(task_id, kwargs["run_id"])
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=report_only):
            self.assertEqual(delegate_gemini(self.config, self.task_id)["outcome"], "NO_EFFECT")

    def test_review_approval_binding_invalidates_on_source_or_target_change(self):
        self.report.write_text("Status: COMPLETE\n", encoding="utf-8")
        self.review.write_text("Decision: APPROVED\nRemaining blockers: NONE\n", encoding="utf-8")
        record_cycle(self.config, self.task_id, "review", "APPROVED")
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "CLOSEOUT")
        with patch.dict("os.environ", {"PORT": "62499"}):
            self.assertEqual(inspect_repository(self.config)["recommended_category"], "CODEX_VERIFY")
        self.source.write_text("changed after approval", encoding="utf-8")
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "CODEX_VERIFY")

    def test_recorded_review_history_cannot_be_rewritten(self):
        self.review.write_text("Decision: FIX_REQUIRED\nRemaining blockers: B-1\n", encoding="utf-8")
        record_cycle(self.config, self.task_id, "review", "FIX_REQUIRED", ["B-1"])
        self.report.write_text("Status: COMPLETE\n", encoding="utf-8")
        self.review.write_text("Decision: APPROVED\nRemaining blockers: NONE\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "append-only"):
            record_cycle(self.config, self.task_id, "review", "APPROVED")

    def test_unsupported_helper_check_returns_control_to_codex_without_human_gate(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), patch("tools.ks_supervisor.targeted.execute_check") as execute:
            code = main(["--repo", str(self.repo_root), "verify-source", "--task", self.task_id,
                         "--command", "pnpm --dir backend exec prisma validate", "--content-identity", source_identity(self.config), "--source-reviewed", "--json"])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(output.getvalue())["status"], "DIRECT_CODEX_VERIFICATION_REQUIRED")
        execute.assert_not_called()

    def test_verification_infrastructure_failure_is_not_an_implementation_fix(self):
        with patch("tools.ks_supervisor.targeted.execute_check", side_effect=OSError("Executable unavailable")):
            result = verify_source(self.config, self.task_id, ["pnpm --dir backend run build"], source_identity(self.config), True)
        self.assertEqual(result["outcome"], "INFRASTRUCTURE_FAILURE")
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "CODEX_RECOVER_INFRASTRUCTURE")

    def test_mocked_codex_owned_end_to_end_lifecycle(self):
        """One fake Codex invocation drives real role builders and artifacts.

        Provider, package execution and final commit facts are mocked; no live
        agent, product operation or final Git commit is performed.
        """
        from tools.ks_supervisor.toolbox import begin_mission, finish_mission, role_instructions, mission_guard, chat_entrypoint
        sequence = ["KS-START"]
        # The user sends exactly ONE chat token; this driver is that same Codex
        # session. No terminal launcher or user-invoked manual role is involved.
        self.write_task(task_id=self.task_id, planning_required="YES", execution_mode="PLANNED_IMPLEMENTATION")
        entry = chat_entrypoint(self.config, "ks-start")
        self.assertEqual(entry["session"], "CURRENT_CODEX_SESSION")
        self.assertFalse(entry["requires_powershell"])
        self.assertFalse(entry["launch_codex"])
        mission = begin_mission(self.config)
        handle = mission["mission_id"]
        sequence.append("REANCHOR")
        self.assertEqual(mission["task_id"], self.task_id)
        sequence.append("TASK")
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "PLAN")
        self.assertIn("Implementation Planner", role_instructions(self.config, "ks-plan", self.task_id, mission_id=handle)["instructions"])
        sequence.append("KS-PLAN")
        plan = self.plan()
        plan_before = plan.read_bytes()
        record_cycle(self.config, self.task_id, "planning", "PASS", mission_id=handle)
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=self.mock_worker) as worker:
            sequence.append("KS-IMPL")
            delegate_gemini(self.config, self.task_id, mission_id=handle)
            sequence.append("CODEX VERIFY")
            with patch("tools.ks_supervisor.targeted.execute_check", return_value=1):
                verify_source(self.config, self.task_id, ["pnpm --dir backend run build"], source_identity(self.config), True, handle)
            sequence.append("FIX")
            packet = self.config.reports_dir / "codex-corrections.json"
            packet.write_text(json.dumps({"task_id": self.task_id, "content_identity": source_identity(self.config),
                                          "failures": [{"id": "C-1", "diagnostic": "TS2322", "expected": "fix type"}]}), encoding="utf-8")
            sequence.append("KS-IMPL")
            delegate_gemini(self.config, self.task_id, "fix", packet, handle)
            self.assertIn("TS2322", worker.call_args.kwargs["prompt"])
            sequence.append("CODEX VERIFY")
            with patch("tools.ks_supervisor.targeted.execute_check", return_value=0):
                verify_source(self.config, self.task_id, ["pnpm --dir backend run build"], source_identity(self.config), True, handle)
            sequence.append("KS-SENIOR")
            reviewer = role_instructions(self.config, "ks-senior", self.task_id, mission_id=handle)
            self.assertIn("Stop after review", reviewer["instructions"])
            self.review.write_text("Decision: FIX_REQUIRED\nRemaining blockers: B-1\n- B-1: missing failure assertion\n", encoding="utf-8")
            record_cycle(self.config, self.task_id, "review", "FIX_REQUIRED", ["B-1"], mission_id=handle)
            sequence.append("FIX_REQUIRED")
            sequence.append("KS-IMPL")
            delegate_gemini(self.config, self.task_id, "fix", mission_id=handle)
            self.assertIn("missing failure assertion", worker.call_args.kwargs["prompt"])
            sequence.append("TARGETED VERIFY")
            with patch("tools.ks_supervisor.targeted.execute_check", return_value=0):
                verify_source(self.config, self.task_id, ["pnpm --dir backend run build"], source_identity(self.config), True, handle)
            sequence.append("KS-SENIOR")
            targeted = role_instructions(self.config, "ks-senior", self.task_id, "TARGETED_VERIFICATION", handle)
            self.assertIn("ONLY previously listed blockers", targeted["instructions"])
            with self.review.open("a", encoding="utf-8") as stream:
                stream.write("\n## Current targeted verification\nDecision: APPROVED\nRemaining blockers: NONE\n")
            record_cycle(self.config, self.task_id, "review", "APPROVED", mission_id=handle)
            sequence.append("ACCEPT")
            self.assertFalse(inspect_repository(self.config)["accepted"])
            sequence.append("KS-NEXT")
            closeout = role_instructions(self.config, "ks-next", self.task_id, "CLOSEOUT", handle)
            self.assertIn("Section 13", closeout["instructions"])
            sequence.append("CLOSEOUT")
            self.write_task(task_id=self.task_id, status="ACCEPTED", planning_required="YES", execution_mode="PLANNED_IMPLEMENTATION")
            self.write_checkpoint(current_task=self.task_id, task_status="ACCEPTED")
            record_cycle(self.config, self.task_id, "closeout", "ACCEPTED", mission_id=handle)
            self.assertEqual(plan.read_bytes(), plan_before)
            self.assertIn("existing partial implementation", self.source.read_text())
            sequence.append("HYGIENE")
            # Mock the existing hygiene helper at the accepted-task boundary.
            from tools.ks_supervisor.repo import run_hygiene_check
            accepted_paths = ["backend/src/partial.ts"]
            self.assertEqual(accepted_paths, [self.source.relative_to(self.repo_root).as_posix()])
            self.assertIn("sections 1-5", closeout["instructions"])
            with patch("tools.ks_supervisor.repo.run_hygiene_check", return_value=(0, "PASS: path and content policy")) as hygiene:
                from tools.ks_supervisor import repo
                code, output = repo.run_hygiene_check(self.repo_root, self.config.hygiene_script_path)
                self.assertEqual(code, 0)
                self.assertIn("PASS", output)
                hygiene.assert_called_once_with(self.repo_root, self.config.hygiene_script_path)
            sequence.append("COMMIT")
            real_info = inspect_repository(self.config)
            commit_sha = "a" * 40
            info = {**real_info, "head": commit_sha, "dirty_paths": [], "staged_paths": []}
            real_git = run_git
            def committed_git(root, *args):
                if args[0] == "diff-tree": return 0, accepted_paths[0] + "\n", ""
                if args == ("rev-parse", "HEAD^"): return 0, mission["initial_head"], ""
                if args == ("log", "-1", "--format=%s"): return 0, self.task_id + ": mock accepted source", ""
                return real_git(root, *args)
            sequence.append("REANCHOR")
            with patch("tools.ks_supervisor.toolbox.inspect_repository", return_value=info), patch("tools.ks_supervisor.toolbox.run_git", side_effect=committed_git):
                result = finish_mission(self.config, handle, accepted_paths, "TASK-2A-003", "Next safe workflow")
            sequence += ["REPORT NEXT TASK", "STOP"]
            self.assertEqual(result["commit"]["sha"], commit_sha)
            self.assertFalse(result["next_task"]["started"])
            self.assertFalse(find_task_file(self.config.tasks_dir, "TASK-2A-003"))
            self.assertFalse(find_plan_file(self.config.plans_dir, "TASK-2A-003"))
            with self.assertRaisesRegex(ValueError, "boundary"):
                mission_guard(self.config, handle, "TASK-2A-003")
            self.assertEqual(worker.call_count, 3)
            self.assertTrue(all(call.args[1] == self.task_id for call in worker.call_args_list))
        self.assertEqual(sequence, ["KS-START", "REANCHOR", "TASK", "KS-PLAN", "KS-IMPL", "CODEX VERIFY", "FIX", "KS-IMPL", "CODEX VERIFY", "KS-SENIOR", "FIX_REQUIRED", "KS-IMPL", "TARGETED VERIFY", "KS-SENIOR", "ACCEPT", "KS-NEXT", "CLOSEOUT", "HYGIENE", "COMMIT", "REANCHOR", "REPORT NEXT TASK", "STOP"])
        print("Mock Codex chat lifecycle (one user token, no PowerShell/manual role invocation): " + " -> ".join(sequence))
