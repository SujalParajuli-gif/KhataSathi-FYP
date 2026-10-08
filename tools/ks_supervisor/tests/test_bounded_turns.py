"""No live worker: deterministic same-mission bounded continuation regressions."""
import json
from unittest.mock import patch
from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase
from tools.ks_supervisor.toolbox import (CycleLedger, begin_mission, delegate_gemini,
    inspect_repository, record_worker_checkpoint, source_identity, finish_mission)
from tools.ks_supervisor.types import AgentResult, Role
from tools.ks_supervisor.repo import compute_file_hash, run_git


class BoundedTurnsTests(BaseSupervisorTestCase):
    def setUp(self):
        super().setUp()
        self.task_id = "TASK-2A-002"
        self.write_checkpoint(current_task=self.task_id)
        self.contract = self.write_task(task_id=self.task_id)
        self.plan = self.config.plans_dir / f"{self.task_id}-plan.md"
        self.plan.write_text("Final plan disposition: IMPLEMENTATION-READY.\nStep 4: storage\n")
        self.source = self.repo_root / "backend/src/partial.ts"
        self.source.parent.mkdir(parents=True)
        self.source.write_text("existing partial\n")
        self.completed = self.repo_root / "backend/src/completed.ts"
        self.completed.write_text("completed interface\n")
        self.report = self.config.reports_dir / f"{self.task_id}-implementation.md"
        self.report.write_text("Status: IN_PROGRESS\nPrior history preserved\n")
        self.mission = begin_mission(self.config)["mission_id"]
        self.mission_path = self.config.runtime_dir / "v3/missions" / f"{self.mission}.json"
        self.mission_before = self.mission_path.read_bytes()
        self.contract_before = self.contract.read_bytes()
        self.plan_before = self.plan.read_bytes()
        self.prompts = []

    def packet(self):
        info = inspect_repository(self.config)
        packet = dict(task_id=self.task_id, mission_id=self.mission,
                      content_identity=info["content_identity"], plan_sha256=info["plan"]["sha256"],
                      slice="step 4 protected storage", instructions="Implement no-overwrite promotion only",
                      preserve_completed="Keep backend/src/completed.ts and its completed interface unchanged",
                      files=["backend/src/partial.ts"], plan_steps=["4"], acceptance_criteria=["AC-5"],
                      remaining_slices=["checkout integration", "focused tests"])
        path = self.config.runtime_dir / "continuation.json"
        path.write_text(json.dumps(packet))
        return path

    def worker(self, role, task_id, **kw):
        self.prompts.append(kw["prompt"])
        self.source.write_text(self.source.read_text() + "no-overwrite promotion\n")
        with self.report.open("ab") as stream:
            stream.write((f"\n## Worker turn {kw['run_id']}\nSlice progress; checks NOT RUN\n").encode())
        return self.result(task_id, kw["run_id"])

    def result(self, task_id, run_id, **overrides):
        fields = dict(role=Role.IMPLEMENTATION, task_id=task_id, run_id=run_id, success=False,
                      process_started=True, process_completed=False, timed_out=True, timeout_kind="hard",
                      exit_code=124, stdout="", stderr="", duration_seconds=900,
                      provider="antigravity", model_name="gemini-3.7-flash-medium", effort="medium")
        fields.update(overrides)
        return AgentResult(**fields)

    def turn(self, worker=None):
        packet = self.packet()
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=worker or self.worker):
            return delegate_gemini(self.config, self.task_id, mission_id=self.mission, continuation_path=packet)

    def assess(self, output, meaningful=True, boundary=False):
        info = inspect_repository(self.config)
        return record_worker_checkpoint(self.config, self.task_id, self.mission, output["run_id"],
            dict(task_id=self.task_id, mission_id=self.mission, content_identity=info["content_identity"],
                 plan_sha256=info["plan"]["sha256"], meaningful_progress=meaningful, verification_boundary=boundary,
                 inspection="Inspected current source: no-overwrite storage branch added; checkout remains unfinished",
                 progressed_plan_steps=["4"] if meaningful else [], acceptance_criteria=["AC-5"] if meaningful else [],
                 remaining_slices=["checkout integration", "focused tests"]))

    def test_productive_timeout_inspected_then_continue(self):
        output = self.turn()
        self.assertEqual(output["outcome"], "AWAITING_PROGRESS_INSPECTION")
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "CODEX_INSPECT_CHECKPOINT")
        with self.assertRaises(ValueError):
            self.turn()
        result = self.assess(output)
        self.assertEqual(result["record"]["outcome"], "PRODUCTIVE_CHECKPOINT")
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "GEMINI_CONTINUE")

    def test_productive_timeout_preserves_other_infra_and_correction_budgets(self):
        ledger = CycleLedger(self.config)
        ledger.append(self.task_id, "verification", "INFRASTRUCTURE_FAILURE", failure_signature="existing")
        ledger.append(self.task_id, "review", "FIX_REQUIRED", blockers=["B1"])
        ledger.append(self.task_id, "review", "FIX_REQUIRED", blockers=["B1"])
        # Review fixtures do not authorize fixes; start from the unchanged task category.
        output = self.turn()
        budget = self.assess(output)["budget"]
        self.assertEqual(budget["infrastructure_failures"], 1)
        self.assertEqual(budget["stagnant_corrections"], 1)

    def test_historical_productive_timeout_reclassified_append_only(self):
        # Reproduce an immutable legacy timeout recorded before this policy.
        output = self.turn()
        output["outcome"] = "INFRASTRUCTURE_FAILURE"
        output["cycle"]["record"]["outcome"] = "INFRASTRUCTURE_FAILURE"
        ledger = CycleLedger(self.config)
        ledger.path.write_text(json.dumps(output["cycle"]["record"], sort_keys=True) + "\n")
        directory = self.config.runtime_dir / "v3/workers" / output["run_id"]
        (directory / "return.json").write_text(json.dumps(output))
        original_bytes = ledger.path.read_bytes()
        original_return = (directory / "return.json").read_bytes()
        self.assertEqual(ledger.budget(self.task_id)["infrastructure_failures"], 1)
        result = self.assess(output)
        self.assertEqual(result["budget"]["infrastructure_failures"], 0)
        self.assertTrue(ledger.path.read_bytes().startswith(original_bytes))
        self.assertEqual((directory / "return.json").read_bytes(), original_return)
        self.assertEqual(ledger.records()[0]["outcome"], "INFRASTRUCTURE_FAILURE")

    def test_prompt_has_narrow_slice_preserved_work_and_boundaries(self):
        self.turn()
        prompt = self.prompts[-1]
        for fragment in ("protected storage", "no-overwrite promotion only", "completed interface", "AC-5",
                         "Return control when this slice", "Workspace file tools ONLY", "No task acceptance", "Append exactly one run-bound worker-turn section"):
            self.assertIn(fragment, prompt)

    def test_same_task_mission_plan_history_and_no_new_task(self):
        first = self.turn()
        prefix = CycleLedger(self.config).path.read_bytes()
        self.assess(first)
        self.turn()
        self.assertTrue(CycleLedger(self.config).path.read_bytes().startswith(prefix))
        self.assertEqual(self.mission_path.read_bytes(), self.mission_before)
        self.assertEqual(self.contract.read_bytes(), self.contract_before)
        self.assertEqual(self.plan.read_bytes(), self.plan_before)
        self.assertEqual(len(list(self.config.tasks_dir.glob("*.md"))), 1)
        self.assertEqual(self.completed.read_text(), "completed interface\n")
        self.assertTrue(self.source.read_text().startswith("existing partial\n"))

    def test_cumulative_report_across_turns(self):
        first = self.turn()
        report = self.report.read_bytes()
        self.assess(first)
        second = self.turn()
        self.assertTrue(self.report.read_bytes().startswith(report))
        record = self.assess(second)["record"]
        self.assertTrue(record["report_updated"])
        self.assertEqual(record["report_sha256"], compute_file_hash(self.report))
        self.assertEqual(record["changed_file_sha256"]["backend/src/partial.ts"], compute_file_hash(self.source))

    def test_timeout_no_changes_bounded_and_two_stop(self):
        def empty(role, task_id, **kw):
            return self.result(task_id, kw["run_id"])
        first = self.turn(empty)
        self.assertEqual(first["outcome"], "NO_EFFECT")
        self.assertEqual(first["cycle"]["budget"]["no_effect_returns"], 1)
        second = self.turn(empty)
        self.assertEqual(second["cycle"]["budget"]["status"], "HUMAN_INPUT_REQUIRED")
        with self.assertRaises(ValueError):
            self.turn(empty)

    def test_observable_but_not_meaningful_two_turns_stop(self):
        first = self.turn()
        self.assess(first, meaningful=False)
        second = self.turn()
        self.assertEqual(self.assess(second, meaningful=False)["budget"]["status"], "HUMAN_INPUT_REQUIRED")

    def test_auth_cannot_be_reclassified(self):
        def auth(role, task_id, **kw):
            self.worker(role, task_id, **kw)
            return self.result(task_id, kw["run_id"], auth_or_quota_failure=True)
        output = self.turn(auth)
        self.assertEqual(output["outcome"], "AUTH_QUOTA")
        with self.assertRaises(ValueError):
            self.assess(output)

    def test_protected_and_outside_slice_still_gate(self):
        self.assert_gated_edit(self.completed)

    def assert_gated_edit(self, path):
        def corrupt(role, task_id, **kw):
            result = self.worker(role, task_id, **kw)
            path.write_text(path.read_text() + "unauthorized edit\n")
            return result
        output = self.turn(corrupt)
        self.assertEqual(output["outcome"], "HUMAN_GATE")
        with self.assertRaises(ValueError):
            self.assess(output)

    def test_protected_tracked_authority_still_gate(self):
        self.assert_gated_edit(self.repo_root / "AGENTS.md")

    def test_workflow_authority_still_gate(self):
        self.assert_gated_edit(self.config.checkpoint_path)

    def test_pending_inspection_not_waived_by_external_source_change(self):
        self.turn()
        self.source.write_text(self.source.read_text() + "external change\n")
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "CODEX_INSPECT_CHECKPOINT")

    def test_report_rewrite_still_gate(self):
        def rewrite(role, task_id, **kw):
            result = self.worker(role, task_id, **kw)
            self.report.write_text("Status: COMPLETE\n")
            return result
        self.assertEqual(self.turn(rewrite)["outcome"], "HUMAN_GATE")

    def test_checkpoint_never_accepts_or_commits_slice(self):
        head = run_git(self.repo_root, "rev-parse", "HEAD")[1]
        output = self.turn()
        self.assess(output, boundary=True)
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "CODEX_VERIFY")
        with self.assertRaises(ValueError):
            finish_mission(self.config, self.mission, ["backend/src/partial.ts"])
        self.assertEqual(run_git(self.repo_root, "rev-parse", "HEAD")[1], head)
        self.assertEqual(run_git(self.repo_root, "diff", "--cached")[1], "")
        self.assertFalse(inspect_repository(self.config)["accepted"])

    def test_stale_or_other_mission_slice_rejected_before_launch(self):
        path = self.packet()
        packet = json.loads(path.read_text())
        packet["mission_id"] = "0" * 32
        path.write_text(json.dumps(packet))
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke") as invoke:
            with self.assertRaises(ValueError):
                delegate_gemini(self.config, self.task_id, mission_id=self.mission, continuation_path=path)
            invoke.assert_not_called()

    def test_cannot_broadly_retry_after_checkpoint(self):
        self.assess(self.turn())
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke") as invoke:
            with self.assertRaises(ValueError):
                delegate_gemini(self.config, self.task_id, mission_id=self.mission)
            invoke.assert_not_called()
