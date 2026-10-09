import hashlib
import json
import contextlib
import io
from unittest.mock import patch
from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase
from tools.ks_supervisor.repo import parse_task_contract
from tools.ks_supervisor.ownership import delegation_eligible, implementation_owner
from tools.ks_supervisor.toolbox import (inspect_repository, delegate_gemini, _protected, CycleLedger,
                                        validate_policy_transition, _identity)
from tools.ks_supervisor.report_provenance import report_violations, REPORT_REWRITE_REASON, REPORT_TURN_REASON
from tools.ks_supervisor.feature_migrations import validate_feature_migration


class DirectOwnershipTests(BaseSupervisorTestCase):
    def test_legacy_live_controller_cannot_launch_direct_work(self):
        from tools.ks_supervisor.cli import cmd_run
        self.write_checkpoint(); self.write_task()
        with patch("tools.ks_supervisor.cli.SupervisorRunner") as runner, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cmd_run(self.config, once=True, live=True), 2)
            runner.assert_not_called()
    def test_risk_usage_matrix_and_legacy_default(self):
        self.write_checkpoint(current_task="TASK-01-001")
        for risk in ("LOW", "MEDIUM", "HIGH"):
            for usage in ("", "LOW", "HIGH"):
                for owner in ("CODEX", "GEMINI"):
                    path = self.write_task(risk=risk, planning_required="YES")
                    with path.open("a") as f:
                        f.write(f"\nExpected Usage: {usage}\nImplementation Owner: {owner}\nDelegation Reason: Bounded implementation costs more than handoff plus review.\n")
                    task = parse_task_contract(path)
                    eligible = risk == usage == "HIGH" and owner == "GEMINI"
                    self.assertEqual(delegation_eligible(task), eligible)
                    self.assertEqual(implementation_owner(task), "GEMINI" if eligible else "CODEX")
        self.assertEqual(parse_task_contract(self.write_task()).implementation_owner, "CODEX")

    def test_direct_high_uses_plan_without_worker(self):
        self.write_checkpoint(current_task="TASK-01-001")
        self.write_task(risk="HIGH", planning_required="YES")
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke") as invoke:
            self.assertEqual(inspect_repository(self.config)["recommended_category"], "PLAN")
            (self.config.plans_dir / "TASK-01-001-plan.md").write_text("Final plan disposition: IMPLEMENTATION-READY.")
            self.assertIn(inspect_repository(self.config)["recommended_category"], {"CODEX_IMPLEMENT", "CODEX_CONTINUE"})
            with self.assertRaises(ValueError):
                delegate_gemini(self.config, "TASK-01-001")
            invoke.assert_not_called()

    def test_dashboard_warning_does_not_remove_authority_protection(self):
        self.write_checkpoint()
        dashboard = self.repo_root / "docs/engineering/PROJECT_PROGRESS.md"
        dashboard.write_text("Human tracker")
        protected = {k.replace("\\", "/"): v for k, v in _protected(self.config, "TASK-01-001").items()}
        self.assertNotIn("docs/engineering/PROJECT_PROGRESS.md", protected)
        self.assertIn("docs/engineering/IMPLEMENTATION_CHECKPOINT.md", protected)

    def test_report_cosmetics_warn_but_history_and_wrong_turn_stop(self):
        self.assertEqual(report_violations(b"", b"Title\n## Worker turn abc\nDone", "abc", False, False), [])
        self.assertEqual(report_violations(b"old", b"rewritten", "abc", True, False), [REPORT_REWRITE_REASON])
        self.assertEqual(report_violations(b"", b"## Worker turn other\nDone", "abc", False, False), [REPORT_TURN_REASON])

    def test_dashboard_transition_is_exact_and_append_only(self):
        original = dict(task_id="TASK-01-001", run_id="old", outcome="HUMAN_GATE",
                        reason="Worker changed protected authority: docs/engineering/PROJECT_PROGRESS.md")
        record = dict(task_id="TASK-01-001", run_id="new", phase="remediation", outcome="POLICY_TRANSITION",
                      resolved_run_id="old", original_record_sha256=_identity(original), mission_id="mission",
                      authorization="User approved", implementation_owner="CODEX", history_sha256="hash", authority_snapshot={"plan": "hash"})
        before = json.dumps(original)
        validate_policy_transition(record, [original, record])
        self.assertEqual(before, json.dumps(original))
        for reason in ("Worker changed protected authority: AGENTS.md", original["reason"] + "; other violation", "AUTH_QUOTA"):
            bad = {**original, "reason": reason}
            with self.assertRaises(ValueError):
                validate_policy_transition({**record, "original_record_sha256": _identity(bad)}, [bad])

    def test_feature_migration_target_and_shape(self):
        self.write_checkpoint()
        cp = self.config.checkpoint_path
        cp.write_text(cp.read_text().replace('LAST_ACCEPTED_TASK:', 'FEATURE_MIGRATION_STANDING_AUTHORIZATION: "User approves disposable and localhost khatasathi_vps_copy_20261003 non-destructive feature migrations"\nLAST_ACCEPTED_TASK:'))
        sql = "ALTER TABLE `StockReceiveBatch` ADD COLUMN `payable` DECIMAL(20,2) NULL;"
        def check(host, database, text=sql, **kw):
            return validate_feature_migration(self.config, host, database, text, hashlib.sha256(text.encode()).hexdigest(), **kw)
        self.assertTrue(check("localhost", "khatasathi_vps_copy_20261003")["authorized"])
        self.assertTrue(check("127.0.0.1", "ks_verify_phase4_owned", owned_disposable=True)["authorized"])
        for host, database, text in [("production", "khatasathi_vps_copy_20261003", sql), ("localhost", "unknown", sql),
                                     ("localhost", "khatasathi_vps_copy_20261003", "DROP TABLE `Supplier`;"),
                                     ("localhost", "khatasathi_vps_copy_20261003", "CREATE TABLE `Copy` AS SELECT * FROM `User`;"),
                                     ("localhost", "khatasathi_vps_copy_20261003", "ALTER TABLE `production`.`User` ADD COLUMN `x` INTEGER NULL;"),
                                     ("localhost", "khatasathi_vps_copy_20261003", "ALTER TABLE `Old` ADD COLUMN `x` INTEGER NOT NULL;")]:
            with self.assertRaises(ValueError):
                check(host, database, text)
