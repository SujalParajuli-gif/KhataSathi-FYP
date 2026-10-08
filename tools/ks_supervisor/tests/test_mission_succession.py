"""Completed mission succession without deleting or resetting historical authority."""
import json
from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase
from tools.ks_supervisor.repo import run_git
from tools.ks_supervisor.toolbox import CycleLedger, begin_mission, mission_guard, _read_mission, _save_mission


class MissionSuccessionTests(BaseSupervisorTestCase):
    def legacy_fixture(self):
        self.task_id = "TASK-OLD"
        self.write_checkpoint(current_task=self.task_id)
        self.write_task(task_id=self.task_id)
        # Represent the original pre-succession mission file exactly.
        self.old = "a" * 32
        self.old_path = self.config.runtime_dir / "v3/missions" / (self.old + ".json")
        self.old_path.parent.mkdir(parents=True)
        self.old_path.write_text(json.dumps({"mission_id": self.old, "repo_root": str(self.repo_root.resolve()),
            "task_id": self.task_id, "status": "ACTIVE", "branch": "feat/phase-1a-test",
            "initial_head": "b" * 40, "events": ["KS-START"]}))
        self.ledger = CycleLedger(self.config, legacy=True)
        for _ in range(60):
            self.ledger.append(self.task_id, "verification", "PASS")
        self.write_task(task_id=self.task_id, status="ACCEPTED")
        self.write_checkpoint(current_task=self.task_id, task_status="ACCEPTED")
        (self.config.reports_dir / f"{self.task_id}-implementation.md").write_text("Status: COMPLETE\n")
        (self.config.reviews_dir / f"{self.task_id}-review.md").write_text("Decision: APPROVED\nRemaining blockers: NONE\n")
        run_git(self.repo_root, "add", ".")  # Disposable fixture only.
        run_git(self.repo_root, "commit", "-m", "Completed fixture")
        self.before = {p: p.read_bytes() for p in self.config.runtime_dir.rglob("*") if p.is_file()}

    def test_recovery_preserves_old_bytes_and_creates_independent_budget(self):
        self.legacy_fixture()
        new = begin_mission(self.config, self.old, "Explicit bounded user recovery")
        fresh = CycleLedger(self.config)
        self.assertNotEqual(new["mission_id"], self.old)
        self.assertEqual(fresh.budget("TASK-NEW")["cycles_used"], 0)
        fresh.append("TASK-NEW", "planning", "PASS")
        self.assertEqual(fresh.budget("TASK-NEW")["cycles_used"], 1)
        with self.assertRaises(ValueError):
            fresh.append("TASK-NEW", "planning", "PASS", mission_id=self.old)
        self.assertEqual(fresh.budget("TASK-NEW")["cycles_used"], 1)
        self.assertEqual(self.ledger.budget(self.task_id)["cycles_used"], 60)
        self.assertEqual(CycleLedger(self.config, self.old).budget(self.task_id)["cycles_used"], 60)
        for path, contents in self.before.items():
            self.assertEqual(path.read_bytes(), contents)
        self.assertEqual(_read_mission(self.config, self.old)["historical_status"], "COMPLETED_ARCHIVED")
        for operation in (lambda: self.ledger.append(self.task_id, "planning", "PASS"),
                          lambda: mission_guard(self.config, self.old, self.task_id),
                          lambda: _save_mission(self.config, {"mission_id": self.old}),
                          lambda: begin_mission(self.config)):
            with self.assertRaises(ValueError):
                operation()

    def test_dirty_unaccepted_and_missing_authorization_fail_before_transition(self):
        self.legacy_fixture()
        with self.assertRaises(ValueError):
            begin_mission(self.config, self.old)
        (self.repo_root / "dirty.txt").write_text("user work")
        with self.assertRaises(ValueError):
            begin_mission(self.config, self.old, "Explicit recovery")
        self.assertFalse((self.config.runtime_dir / "v3/mission_transitions.jsonl").exists())
        self.assertEqual(self.old_path.read_bytes(), self.before[self.old_path])
        (self.repo_root / "dirty.txt").unlink()
        self.write_task(task_id=self.task_id, status="READY")
        run_git(self.repo_root, "add", ".")
        run_git(self.repo_root, "commit", "-m", "Unfinished fixture")
        with self.assertRaisesRegex(ValueError, "accepted completed"):
            begin_mission(self.config, self.old, "Explicit recovery")
        self.write_task(task_id=self.task_id, status="ACCEPTED")
        self.write_checkpoint(workflow_version="1", current_task=self.task_id, task_status="ACCEPTED")
        run_git(self.repo_root, "add", ".")
        run_git(self.repo_root, "commit", "-m", "Invalid workflow fixture")
        with self.assertRaisesRegex(ValueError, "valid Workflow"):
            begin_mission(self.config, self.old, "Explicit recovery")
        self.assertFalse((self.config.runtime_dir / "v3/mission_transitions.jsonl").exists())

    def test_completed_new_mission_succession_has_zero_counters(self):
        self.legacy_fixture()
        first = begin_mission(self.config, self.old, "Explicit recovery")
        CycleLedger(self.config).append("TASK-NEW", "verification", "PASS")
        first["status"] = "COMPLETE"
        first["task_id"] = self.task_id
        first["result"] = {"status": "MISSION COMPLETE", "result": "ACCEPTED", "task_id": self.task_id,
                           "commit": {"sha": first["initial_head"]}}
        _save_mission(self.config, first)
        old_bytes = CycleLedger(self.config).path.read_bytes()
        second = begin_mission(self.config)
        self.assertNotEqual(first["mission_id"], second["mission_id"])
        self.assertEqual(CycleLedger(self.config).budget("TASK-NEXT")["cycles_used"], 0)
        self.assertEqual(CycleLedger(self.config, first["mission_id"]).path.read_bytes(), old_bytes)

    def test_changed_historical_evidence_fails_closed(self):
        self.legacy_fixture()
        begin_mission(self.config, self.old, "Explicit recovery")
        self.old_path.write_text("tampered")
        with self.assertRaises(ValueError):
            CycleLedger(self.config)
