"""Runtime ownership and explicit append-only recovery; no live operations."""
import json
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase
from tools.ks_supervisor.toolbox import (
    CycleLedger, RUNTIME_LOG_GATE_REASON, RUNTIME_LOG_VIOLATIONS,
    begin_mission, delegate_gemini, recover_runtime_log_gate,
)
from tools.ks_supervisor.types import AgentResult, Role
from tools.ks_supervisor.adapters.antigravity import AntigravityAdapter
from tools.ks_supervisor.runtime_logs import SupervisorRuntimeLogs


class RuntimeLogOwnershipTests(BaseSupervisorTestCase):
    def setUp(self):
        super().setUp()
        self.task_id = "TASK-2A-002"
        self.write_checkpoint(current_task=self.task_id)
        self.write_task(task_id=self.task_id)
        self.source = self.repo_root / "backend/src/partial.ts"
        self.source.parent.mkdir(parents=True, exist_ok=True)
        self.source.write_text("preserved partial implementation\n", encoding="utf-8")

    def result(self, task_id, run_id):
        return AgentResult(role=Role.IMPLEMENTATION, task_id=task_id, run_id=run_id,
                           exit_code=0, stdout="", stderr="", duration_seconds=1,
                           success=True, process_started=True, process_completed=True,
                           provider="antigravity", model_name="gemini-3.7-flash-medium", effort="medium")

    def worker(self, role, task_id, **kwargs):
        logs = kwargs["runtime_logs"]
        stream, stderr = logs.open()
        stream.write('{"event":"supervisor captured output"}\n')
        stderr.write("supervisor captured diagnostic\n")
        stream.close()
        stderr.close()
        self.source.write_text(self.source.read_text() + "continued partial work\n", encoding="utf-8")
        return self.result(task_id, kwargs["run_id"])

    def test_supervisor_writes_have_exact_owned_paths_and_preserve_prior_logs(self):
        prior = self.config.runtime_dir / "current_agent_stream.jsonl"
        prior.write_text("original blocked evidence\n", encoding="utf-8")
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=self.worker):
            result = delegate_gemini(self.config, self.task_id)
        self.assertEqual(result["outcome"], "SUCCESS")
        self.assertEqual(result["violations"], [])
        self.assertEqual(prior.read_text(), "original blocked evidence\n")
        path = Path(result["cycle"]["record"]["runtime_location"]) / "logs/current_agent_stream.jsonl"
        self.assertIn("supervisor captured output", path.read_text())

    def test_gemini_write_to_same_owned_log_is_detected(self):
        def corrupt(role, task_id, **kwargs):
            result = self.worker(role, task_id, **kwargs)
            kwargs["runtime_logs"].logs[0].path.write_text("worker forgery", encoding="utf-8")
            return result
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=corrupt):
            result = delegate_gemini(self.config, self.task_id)
        self.assertEqual(result["outcome"], "HUMAN_GATE")
        self.assertIn("Worker modified Supervisor-owned runtime log", result["violations"][0])

    def test_real_adapter_uses_owned_logs_without_overwriting_shared_evidence(self):
        prior = self.config.runtime_dir / "current_agent_stream.jsonl"
        prior.write_text("original blocked evidence", encoding="utf-8")
        run = "b" * 32
        directory = self.config.runtime_dir / "v3/workers" / run
        directory.mkdir(parents=True)
        logs = SupervisorRuntimeLogs(self.config, run)
        process = MagicMock()
        process.stdout = StringIO('{"type":"result","usage":{}}\n')
        process.stderr = StringIO("diagnostic\n")
        process.poll.return_value = 0
        process.returncode = 0
        adapter = AntigravityAdapter(self.config)
        profile = SimpleNamespace(model="gemini-3.7-flash-medium", effort="medium")
        with patch.object(adapter, "check_availability", return_value={"available": True, "binary": "agy-fixture", "is_headless": True}), \
                patch("tools.ks_supervisor.adapters.antigravity.subprocess.Popen", return_value=process):
            result = adapter.invoke(Role.IMPLEMENTATION, self.task_id, prompt="workspace fixture", profile=profile,
                                    run_id=run, runtime_logs=logs)
        self.assertTrue(result.success)
        self.assertEqual(logs.violations(), [])
        self.assertEqual(prior.read_text(), "original blocked evidence")
        self.assertEqual(logs.logs[1].path.read_text(), "diagnostic\n")

    def test_repository_runtime_lookalike_receives_no_exemption(self):
        lookalike = self.repo_root / "docs/engineering/runtime/current_agent_stream.jsonl"
        lookalike.parent.mkdir(parents=True)
        lookalike.write_text("workflow authority", encoding="utf-8")
        def corrupt(role, task_id, **kwargs):
            lookalike.write_text("worker forgery", encoding="utf-8")
            return self.worker(role, task_id, **kwargs)
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=corrupt):
            result = delegate_gemini(self.config, self.task_id)
        self.assertEqual(result["outcome"], "HUMAN_GATE")
        self.assertIn("protected authority", " ".join(result["violations"]))

    def test_unowned_new_log_cannot_claim_supervisor_ownership(self):
        def corrupt(role, task_id, **kwargs):
            logs = kwargs["runtime_logs"]
            logs.directory.mkdir()
            (logs.directory / "current_agent_stream.jsonl").write_text("worker forgery", encoding="utf-8")
            return self.result(task_id, kwargs["run_id"])
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=corrupt):
            result = delegate_gemini(self.config, self.task_id)
        self.assertEqual(result["outcome"], "HUMAN_GATE")
        self.assertIn("Unowned worker runtime log artifact", " ".join(result["violations"]))

    def test_existing_shared_log_is_not_exempted(self):
        prior = self.config.runtime_dir / "current_agent_stream.jsonl"
        prior.write_text("immutable prior record", encoding="utf-8")
        def corrupt(role, task_id, **kwargs):
            prior.write_text("worker forgery", encoding="utf-8")
            return self.worker(role, task_id, **kwargs)
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=corrupt):
            result = delegate_gemini(self.config, self.task_id)
        self.assertEqual(result["outcome"], "HUMAN_GATE")
        self.assertIn("existing runtime authority", " ".join(result["violations"]))

    def test_protected_tracked_file_still_trips_guard(self):
        def corrupt(role, task_id, **kwargs):
            with (self.repo_root / "AGENTS.md").open("a", encoding="utf-8") as stream:
                stream.write("worker forgery\n")
            return self.worker(role, task_id, **kwargs)
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=corrupt):
            result = delegate_gemini(self.config, self.task_id)
        self.assertEqual(result["outcome"], "HUMAN_GATE")
        self.assertIn("protected authority: AGENTS.md", " ".join(result["violations"]))

    def test_workflow_authority_still_trips_guard(self):
        def corrupt(role, task_id, **kwargs):
            with self.config.checkpoint_path.open("a", encoding="utf-8") as stream:
                stream.write("worker forgery\n")
            return self.worker(role, task_id, **kwargs)
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=corrupt):
            result = delegate_gemini(self.config, self.task_id)
        self.assertEqual(result["outcome"], "HUMAN_GATE")
        self.assertIn("protected authority", " ".join(result["violations"]))

    def blocked_fixture(self):
        mission = begin_mission(self.config)
        ledger = CycleLedger(self.config)
        ledger.append(self.task_id, "worker", "INFRASTRUCTURE_FAILURE", failure_signature="timeout")
        ledger.append(self.task_id, "verification", "FAIL", blockers=["B-1", "B-2"])
        ledger.append(self.task_id, "verification", "FAIL", blockers=["B-1", "B-2"])
        run = "a" * 32
        ledger.append(self.task_id, "worker", "HUMAN_GATE", reason=RUNTIME_LOG_GATE_REASON, run_id=run)
        directory = self.config.runtime_dir / "v3/workers" / run
        directory.mkdir(parents=True)
        (directory / "return.json").write_text(json.dumps({
            "run_id": run, "task_id": self.task_id, "outcome": "HUMAN_GATE",
            "violations": RUNTIME_LOG_VIOLATIONS, "result": {"auth_or_quota_failure": False}}), encoding="utf-8")
        return mission, ledger, run

    def test_explicit_recovery_appends_preserves_failure_mission_and_all_budgets(self):
        mission, ledger, run = self.blocked_fixture()
        history = ledger.path.read_bytes()
        mission_path = self.config.runtime_dir / "v3/missions" / (mission["mission_id"] + ".json")
        original_mission = mission_path.read_bytes()
        budget = ledger.budget(self.task_id)
        source = self.source.read_bytes()
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=AssertionError("No provider during repair")):
            recovered = recover_runtime_log_gate(self.config, self.task_id, mission["mission_id"], run, "Explicit user approval")
        self.assertTrue(ledger.path.read_bytes().startswith(history))
        self.assertEqual(ledger.records()[3]["outcome"], "HUMAN_GATE")
        self.assertEqual(mission_path.read_bytes(), original_mission)
        self.assertEqual(self.source.read_bytes(), source)
        after = recovered["budget"]
        self.assertEqual(after["status"], "CONTINUE")
        for field in ("infrastructure_failures", "no_effect_returns", "stagnant_corrections", "cycle_limit"):
            self.assertEqual(after[field], budget[field])
        self.assertEqual(after["cycles_used"], budget["cycles_used"] + 1)
        with self.assertRaises(ValueError):
            recover_runtime_log_gate(self.config, self.task_id, mission["mission_id"], run, "Repeat approval")
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=self.worker) as invoke:
            result = delegate_gemini(self.config, self.task_id, mission_id=mission["mission_id"])
        self.assertEqual(result["outcome"], "SUCCESS")
        self.assertIn("preserved partial implementation", self.source.read_text())
        self.assertIn("Continue existing partial", invoke.call_args.kwargs["prompt"])
        self.assertEqual(mission_path.read_bytes(), original_mission)

    def test_recovery_does_not_resolve_new_or_other_gates(self):
        mission, ledger, run = self.blocked_fixture()
        ledger.append(self.task_id, "worker", "HUMAN_GATE", reason="Worker modified protected workflow")
        recovered = recover_runtime_log_gate(self.config, self.task_id, mission["mission_id"], run, "Explicit approval")
        self.assertEqual(recovered["budget"]["status"], "HUMAN_INPUT_REQUIRED")
        self.assertIn("protected workflow", recovered["budget"]["reason"])

    def test_recovery_cannot_hide_auth_failure_or_apply_without_approval(self):
        mission, ledger, run = self.blocked_fixture()
        before = ledger.path.read_bytes()
        with self.assertRaises(ValueError):
            recover_runtime_log_gate(self.config, self.task_id, mission["mission_id"], run, "")
        result_path = self.config.runtime_dir / "v3/workers" / run / "return.json"
        data = json.loads(result_path.read_text())
        data["result"]["auth_or_quota_failure"] = True
        result_path.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaises(ValueError):
            recover_runtime_log_gate(self.config, self.task_id, mission["mission_id"], run, "Explicit approval")
        self.assertEqual(ledger.path.read_bytes(), before)
