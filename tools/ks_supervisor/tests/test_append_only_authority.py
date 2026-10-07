"""Latest canonical decisions supersede history without inventing agent completion."""
import hashlib
import os
from pathlib import Path
import shutil
from unittest.mock import patch

from tools.ks_supervisor.repo import parse_report, parse_review
from tools.ks_supervisor.runner import SupervisorRunner
from tools.ks_supervisor.state import derive_workflow_state
from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase
from tools.ks_supervisor.types import GitState, Role, WorkflowState


class TestAppendOnlyAuthority(BaseSupervisorTestCase):
    task_id = "TASK-2A-001"

    def setUp(self):
        super().setUp()
        self.write_checkpoint(current_task=self.task_id, task_status="APPROVED_AWAITING_CLOSEOUT")
        self.write_task(self.task_id, status="APPROVED_AWAITING_CLOSEOUT")
        self.registry = self.config.task_registry_path
        self.registry.parent.mkdir(parents=True, exist_ok=True)
        self.registry.write_text(f"| {self.task_id} | Billing | 2A | HIGH | APPROVED_AWAITING_CLOSEOUT | branch |\n")
        self.app = self.repo_root / "frontend/app/routes/_app.billing.tsx"
        self.spec = self.repo_root / "frontend/tests/browser/billing-worksheet-calculator.spec.ts"
        for path in (self.app, self.spec):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("final reviewed content\n")
        self.report = self.config.reports_dir / f"{self.task_id}-implementation.md"
        self.report.write_text("# Report\nStatus: COMPLETE\n## Older verification\nPlaywright15/15 PASS\n"
            "## Manual IDE correction - final B-7\nCorrection complete, awaiting bounded Senior verification.\n"
            f"Application: `{self.app.relative_to(self.repo_root).as_posix()}`. Test: `{self.spec.relative_to(self.repo_root).as_posix()}`.\n"
            "Playwright16/16 PASS; frontend tsc PASS.\n")
        self.review = self.config.reviews_dir / f"{self.task_id}-review.md"
        self.history = ("# Senior review\n## Result\nDecision: FIX REQUIRED\nRemaining blockers: B-1, B-7\n"
            "## Current targeted verification\nDecision: FIX REQUIRED\nRemaining blockers: B-5, B-7\n"
            "## Historical targeted verification\nDecision: FIX REQUIRED\nRemaining blockers: B-7\n")
        self.approve()

    def approve(self):
        self.review.write_text(self.history +
            "## Current targeted verification - FINAL bounded Senior review, 2026-10-07\n"
            "Decision: **APPROVED / READY FOR CLOSEOUT**\nWorkflow v2 state: **APPROVED_AWAITING_CLOSEOUT**\n"
            "B-7: **RESOLVED**\nRemaining blockers: **NONE**\n"
            f"- Billing SHA256: `{hashlib.sha256(self.app.read_bytes()).hexdigest()}`.\n"
            f"- Worksheet/calculator browser spec SHA256: `{hashlib.sha256(self.spec.read_bytes()).hexdigest()}`.\n")

    def state(self):
        return derive_workflow_state(self.config)

    def assert_mismatch(self, reason):
        state = self.state()
        self.assertTrue(state.is_hard_stop)
        self.assertEqual(state.assigned_role, Role.NONE)
        self.assertIn("APPROVAL_PROVENANCE_MISMATCH", state.stop_reason)
        self.assertIn(reason, state.stop_reason)

    def test_historical_fix_required_followed_by_final_approved_routes_closeout(self):
        state = self.state()
        self.assertEqual(state.state, WorkflowState.APPROVED_AWAITING_CLOSEOUT)
        self.assertEqual(state.assigned_role, Role.SENIOR)
        self.assertEqual(state.model_selection.profile.name, "codex_closeout")

    def test_multiple_old_remaining_blockers_do_not_override_final_none(self):
        review = parse_review(self.review)
        self.assertEqual(review.decision, "APPROVED")
        self.assertEqual(review.blockers, [])
        self.assertTrue(review.blockers_explicitly_empty)

    def test_changed_reviewed_application_hash_fails_closed(self):
        self.app.write_text("new implementation\n")
        self.assert_mismatch("reviewed content hash mismatch")

    def test_changed_reviewed_test_hash_fails_closed(self):
        self.spec.write_text("new test\n")
        self.assert_mismatch("reviewed content hash mismatch")

    def test_task_approved_but_latest_senior_fix_required_cannot_closeout(self):
        self.review.write_text(self.review.read_text() +
            "## Current targeted verification - newer\nDecision: FIX REQUIRED\nRemaining blockers: B-7\n")
        self.assert_mismatch("latest Senior decision")

    def test_registry_review_disagreement_fails_closed(self):
        self.registry.write_text(self.registry.read_text().replace("APPROVED_AWAITING_CLOSEOUT", "FIX_REQUIRED"))
        self.assert_mismatch("registry")

    def test_checkpoint_disagreement_fails_closed(self):
        self.write_checkpoint(current_task=self.task_id, task_status="FIX_REQUIRED")
        self.assert_mismatch("task/checkpoint")

    def test_latest_report_uses_final_16_not_historical_15_evidence(self):
        report = parse_report(self.report)
        self.assertTrue(report.is_complete)
        self.assertIn("16/16", report.current_content)
        self.assertNotIn("15/15", report.current_content)
        self.assertIn("15/15", report.raw_content)

    def test_later_incomplete_report_does_not_reuse_old_completion(self):
        self.report.write_text(self.report.read_text() + "## Current completion\nStatus: IN_PROGRESS\n")
        self.assertFalse(parse_report(self.report).is_complete)
        self.assert_mismatch("completion block missing")

    def test_newer_implementation_report_requires_senior_review(self):
        self.report.write_text(self.report.read_text() + "New correction\n")
        now = self.review.stat().st_mtime_ns + 1_000_000_000
        os.utime(self.report, ns=(now, now))
        self.assert_mismatch("report changed after Senior")

    def test_new_unbound_application_change_fails_closed(self):
        extra = self.app.parent / "new.tsx"
        extra.write_text("new unreviewed change\n")
        now = self.review.stat().st_mtime_ns + 1_000_000_000
        os.utime(extra, ns=(now, now))
        self.assert_mismatch("newer application/test")

    def test_approved_without_hashes_fails_closed(self):
        self.review.write_text(self.review.read_text().split("- Billing SHA256:")[0])
        self.assert_mismatch("hashes missing")

    def test_unknown_latest_decision_cannot_promote_historical_approval(self):
        self.review.write_text(self.review.read_text() +
            "## Current targeted verification - later\nDecision: UNKNOWN\nRemaining blockers: NONE\n")
        self.assert_mismatch("latest Senior decision")

    def test_append_only_history_unchanged_and_no_agent_invocation(self):
        before = {p: p.read_bytes() for p in (self.report, self.review, self.registry, self.app, self.spec)}
        runner = SupervisorRunner(self.config)
        with patch.object(runner.antigravity_adapter, "invoke") as gemini, patch.object(runner.codex_adapter, "invoke") as codex:
            state, stop = runner.run_step(dry_run=True)
        self.assertEqual(state.state, WorkflowState.APPROVED_AWAITING_CLOSEOUT)
        gemini.assert_not_called()
        codex.assert_not_called()
        self.assertEqual(before, {p: p.read_bytes() for p in before})

    def test_current_task2a_canonical_fixture_derives_closeout(self):
        """Read-only integration fixture, available in the owner's local workspace."""
        root = Path(__file__).resolve().parents[3]
        task = root / "docs/engineering/ai/tasks/TASK-2A-001-billing-worksheet.md"
        if not task.exists() or "Status: APPROVED_AWAITING_CLOSEOUT" not in task.read_text(encoding="utf-8"):
            self.skipTest("local canonical approved TASK-2A-001 fixture unavailable")
        relatives = ["docs/engineering/IMPLEMENTATION_CHECKPOINT.md", "docs/engineering/ai/TASK_REGISTRY.md",
            "docs/engineering/ai/tasks/TASK-2A-001-billing-worksheet.md",
            "docs/engineering/ai/reviews/TASK-2A-001-review.md", "docs/engineering/ai/reports/TASK-2A-001-implementation.md",
            "frontend/app/routes/_app.billing.tsx", "frontend/tests/browser/billing-worksheet-calculator.spec.ts"]
        for relative in relatives:
            destination = self.repo_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(root / relative, destination)
        from tools.ks_supervisor.repo import parse_checkpoint
        checkpoint = parse_checkpoint(self.config.checkpoint_path)
        with patch("tools.ks_supervisor.state.get_git_state", return_value=GitState(branch=checkpoint.current_work_branch)):
            self.assertEqual(self.state().state, WorkflowState.APPROVED_AWAITING_CLOSEOUT)
