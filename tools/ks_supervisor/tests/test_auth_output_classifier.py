"""Provider evidence vs product prose, with append-only same-mission recovery."""
import json
from io import StringIO
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

from tools.ks_supervisor.tests.delegated_fixture import DelegatedSupervisorTestCase as BaseSupervisorTestCase
from tools.ks_supervisor.adapters.antigravity import AntigravityAdapter, provider_auth_quota_signal
from tools.ks_supervisor.runtime_logs import SupervisorRuntimeLogs
from tools.ks_supervisor.toolbox import (CycleLedger, begin_mission, delegate_gemini,
    recover_auth_output_gate, record_worker_checkpoint, inspect_repository)
from tools.ks_supervisor.types import AgentResult, Role
from tools.ks_supervisor.repo import compute_file_hash, run_git


class AuthOutputClassifierTests(BaseSupervisorTestCase):
    def setUp(self):
        super().setUp()
        self.task_id = "TASK-2A-002"
        self.write_checkpoint(current_task=self.task_id)
        self.contract = self.write_task(task_id=self.task_id)
        self.plan = self.config.plans_dir / f"{self.task_id}-plan.md"
        self.plan.write_text("Final plan disposition: IMPLEMENTATION-READY.\n")
        self.source = self.repo_root / "backend/src/partial.ts"
        self.source.parent.mkdir(parents=True)
        self.source.write_text("preserved partial implementation\n")
        self.mission = begin_mission(self.config)["mission_id"]

    def success_stream(self, response):
        return json.dumps({"event": "result", "result": {"status": "SUCCESS", "response": response}}) + "\n"

    def adapter_result(self, stdout, stderr="", exit_code=0):
        run = "e" * 32
        directory = self.config.runtime_dir / "v3/workers" / run
        directory.mkdir(parents=True, exist_ok=True)
        logs = SupervisorRuntimeLogs(self.config, run)
        proc = MagicMock()
        proc.stdout, proc.stderr = StringIO(stdout), StringIO(stderr)
        proc.poll.return_value = exit_code
        proc.returncode = exit_code
        adapter = AntigravityAdapter(self.config)
        with patch.object(adapter, "check_availability", return_value={"available": True, "binary": "agy-fixture", "is_headless": True}), \
                patch("tools.ks_supervisor.adapters.antigravity.subprocess.Popen", return_value=proc):
            return adapter.invoke(Role.IMPLEMENTATION, self.task_id, prompt="fixture", run_id=run,
                profile=SimpleNamespace(model="gemini-3.7-flash-medium", effort="medium"), runtime_logs=logs)

    def test_product_unauthenticated_stdout_is_not_provider_gate(self):
        self.assertFalse(provider_auth_quota_signal("Reject unauthenticated user in product access tests")[0])
        self.assertFalse(provider_auth_quota_signal(self.success_stream("Reject unauthenticated user"))[0])

    def test_product_unauthorized_stdout_is_not_provider_gate(self):
        self.assertFalse(provider_auth_quota_signal("Test an unauthorized request")[0])
        self.assertFalse(provider_auth_quota_signal(self.success_stream("Application returns unauthorized request"))[0])

    def test_real_adapter_success_never_scans_model_prose(self):
        result = self.adapter_result(self.success_stream("Unauthenticated user; unauthorized request; auth; quota; authentication; Error: quota exhausted; Login required in product tests"))
        self.assertTrue(result.success)
        self.assertFalse(result.auth_or_quota_failure)
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.stderr, "")

    def test_structured_quota_exhaustion_stops(self):
        result = self.adapter_result(json.dumps({"event": "error", "error": {"code": "RESOURCE_EXHAUSTED", "message": "quota exhausted"}}))
        self.assertTrue(result.auth_or_quota_failure)
        self.assertFalse(result.success)

    def test_genuine_login_auth_expired_cli_signatures_still_stop(self):
        for text in ("Login required", "Authentication expired", "Token expired", "Invalid credentials", "Expired credentials", "account unavailable", "quota exhausted", "rate limit exhausted", "Error: 429 Too Many Requests"):
            with self.subTest(text=text):
                self.assertTrue(provider_auth_quota_signal("", text, 1)[0])

    def test_explicit_provider_metadata_precedes_success_prose(self):
        for metadata in ({"auth_or_quota_failure": True}, {"error": {"code": "UNAUTHENTICATED"}}, {"status": "QUOTA_EXHAUSTED"}):
            event = {"event": "result", "result": {"status": "SUCCESS", "response": "All product tests passed", **metadata}}
            self.assertTrue(provider_auth_quota_signal(json.dumps(event))[0])

    def test_model_and_tool_content_nested_error_metadata_are_ignored(self):
        for kind in ("assistant", "message", "tool_result"):
            self.assertFalse(provider_auth_quota_signal(json.dumps({"type": kind, "content": {"auth_or_quota_failure": True, "error": "quota exhausted"}}))[0])
        self.assertFalse(provider_auth_quota_signal(self.success_stream({"auth_or_quota_failure": True, "error": "quota exhausted"}))[0])
        self.assertFalse(provider_auth_quota_signal(json.dumps({"error": "unauthorized application request"}))[0])

    def test_non_success_provider_status_with_auth_error_stops(self):
        self.assertTrue(provider_auth_quota_signal(json.dumps({"event": "result", "result": {"status": "FAILED", "error": {"message": "Authentication expired"}}}))[0])
        self.assertTrue(provider_auth_quota_signal(json.dumps({"event": "step_update", "step_update": {"step": {"type": "CORTEX_STEP_TYPE_ERROR_MESSAGE", "errorMessage": {"message": "quota exhausted"}}}}))[0])
        self.assertTrue(provider_auth_quota_signal("Error: quota exhausted", exit_code=1)[0])
        self.assertTrue(provider_auth_quota_signal(json.dumps({"event": "step_update", "step_update": {"type": "CORTEX_STEP_TYPE_ERROR_MESSAGE", "errorMessage": {"error": "RESOURCE_EXHAUSTED: quota exhausted"}}}))[0])
        self.assertTrue(provider_auth_quota_signal(json.dumps({"event": "result", "result": {"status": "ERROR", "response": "Quota exhausted"}}))[0])
        self.assertFalse(provider_auth_quota_signal(json.dumps({"event": "result", "result": {"status": "FAILED", "response": "Application tests cover unauthenticated users"}}))[0])

    def false_gate(self):
        run = "a" * 32
        ledger = CycleLedger(self.config)
        cycle = ledger.append(self.task_id, "worker", "AUTH_QUOTA", run_id=run,
            reason="PROVIDER_QUOTA_OR_AUTH_REQUIRED: Antigravity CLI is unauthenticated",
            changed_paths=["backend/src/partial.ts"], report_updated=False)
        directory = self.config.runtime_dir / "v3/workers" / run
        (directory / "logs").mkdir(parents=True)
        (directory / "logs/current_agent_stream.jsonl").write_text(self.success_stream("Product rejects unauthenticated user"))
        (directory / "logs/current_agent_stderr.log").write_text("")
        output = dict(run_id=run, task_id=self.task_id, outcome="AUTH_QUOTA", cycle=cycle, violations=[],
            result=dict(auth_or_quota_failure=True, process_started=True, process_completed=True,
                        exit_code=0, timed_out=False, soft_permission_denial=False, success=False))
        (directory / "return.json").write_text(json.dumps(output))
        return run, ledger, directory

    def test_false_gate_recovery_preserves_history_mission_budgets_product_no_operations(self):
        ledger = CycleLedger(self.config)
        ledger.append(self.task_id, "verification", "INFRASTRUCTURE_FAILURE", failure_signature="preserved")
        ledger.append(self.task_id, "review", "FIX_REQUIRED", blockers=["B1"])
        ledger.append(self.task_id, "review", "FIX_REQUIRED", blockers=["B1"])
        run, ledger, directory = self.false_gate()
        history, budget = ledger.path.read_bytes(), ledger.budget(self.task_id)
        mission_path = self.config.runtime_dir / "v3/missions" / f"{self.mission}.json"
        preserved = {p: p.read_bytes() for p in (self.source, self.contract, self.plan, mission_path, directory / "return.json", directory / "logs/current_agent_stream.jsonl")}
        head = run_git(self.repo_root, "rev-parse", "HEAD")[1]
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=AssertionError("No live repair operation")):
            result = recover_auth_output_gate(self.config, self.task_id, self.mission, run, "Explicit approval")
        self.assertEqual(result["record"]["outcome"], "AUTH_CLASSIFIER_REMEDIATED")
        self.assertTrue(ledger.path.read_bytes().startswith(history))
        self.assertEqual(ledger.records()[-2]["outcome"], "AUTH_QUOTA")
        for p, data in preserved.items():
            self.assertEqual(p.read_bytes(), data)
        for key in ("infrastructure_failures", "no_effect_returns", "stagnant_corrections", "cycle_limit"):
            self.assertEqual(result["budget"][key], budget[key])
        self.assertEqual(result["budget"]["cycles_used"], budget["cycles_used"] + 1)
        self.assertEqual(run_git(self.repo_root, "rev-parse", "HEAD")[1], head)
        self.assertEqual(run_git(self.repo_root, "diff", "--cached")[1], "")

    def test_genuine_same_task_quota_gate_cannot_be_hidden(self):
        ledger = CycleLedger(self.config)
        genuine = ledger.append(self.task_id, "worker", "AUTH_QUOTA", reason="Genuine provider quota exhausted")
        run, ledger, _ = self.false_gate()
        result = recover_auth_output_gate(self.config, self.task_id, self.mission, run, "Explicit approval")
        self.assertEqual(result["budget"]["status"], "HUMAN_INPUT_REQUIRED")
        self.assertEqual(ledger.records()[0], genuine["record"])

    def test_earlier_genuine_quota_history_and_successful_resume_fact_preserved(self):
        ledger = CycleLedger(self.config)
        genuine = ledger.append("TASK-OLD", "worker", "AUTH_QUOTA", reason="Earlier genuine quota exhausted; user waited for reset")
        run, ledger, _ = self.false_gate()
        recover_auth_output_gate(self.config, self.task_id, self.mission, run, "Explicit approval")
        def worker(role, task_id, **kw):
            self.source.write_text(self.source.read_text() + "continued existing work\n")
            return AgentResult(role=Role.IMPLEMENTATION, task_id=task_id, run_id=kw["run_id"], exit_code=0,
                stdout="", stderr="", duration_seconds=1, success=True, process_started=True, process_completed=True,
                provider="antigravity", model_name="gemini-3.7-flash-medium", effort="medium")
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke", side_effect=worker):
            result = delegate_gemini(self.config, self.task_id, mission_id=self.mission)
        self.assertEqual(result["cycle"]["record"]["provider_recovery"], {"event": "PROVIDER_RESUME_CONFIRMED", "recovered_gate_runs": [run]})
        self.assertEqual(ledger.records()[0], genuine["record"])
        self.assertEqual(ledger.records()[1]["outcome"], "AUTH_QUOTA")

    def test_recovery_rejects_genuine_metadata_and_unapproved_duplicate(self):
        run, ledger, directory = self.false_gate()
        before = ledger.path.read_bytes()
        with self.assertRaises(ValueError):
            recover_auth_output_gate(self.config, self.task_id, self.mission, run, "")
        stream = directory / "logs/current_agent_stream.jsonl"
        stream.write_text(json.dumps({"event": "result", "result": {"status": "SUCCESS", "auth_or_quota_failure": True}}))
        with self.assertRaises(ValueError):
            recover_auth_output_gate(self.config, self.task_id, self.mission, run, "Approval")
        self.assertEqual(ledger.path.read_bytes(), before)
        stream.write_text(self.success_stream("Unauthenticated product request denied"))
        recover_auth_output_gate(self.config, self.task_id, self.mission, run, "Approval")
        with self.assertRaises(ValueError):
            recover_auth_output_gate(self.config, self.task_id, self.mission, run, "Approval")

    def test_recovered_auth_worker_progress_can_be_assessed_without_erasing_gate(self):
        run, ledger, _ = self.false_gate()
        recover_auth_output_gate(self.config, self.task_id, self.mission, run, "Approval")
        info = inspect_repository(self.config)
        assessment = dict(task_id=self.task_id, mission_id=self.mission, content_identity=info["content_identity"],
            plan_sha256=info["plan"]["sha256"], meaningful_progress=True, verification_boundary=False,
            inspection="Actual QR source inspected; further slices remain", progressed_plan_steps=["4"], acceptance_criteria=["AC-1"], remaining_slices=["QR fault fixtures"])
        self.assertEqual(record_worker_checkpoint(self.config, self.task_id, self.mission, run, assessment)["record"]["outcome"], "PRODUCTIVE_CHECKPOINT")
        self.assertEqual(ledger.records()[0]["outcome"], "AUTH_QUOTA")
