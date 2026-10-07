"""One-task facts/gates and reuse of independent manual roles; no live providers."""
import contextlib
import io
import json
from pathlib import Path
from unittest.mock import patch

from tools.ks_supervisor.adapters.antigravity import AntigravityAdapter
from tools.ks_supervisor.adapters.codex import CodexAdapter
from tools.ks_supervisor.cli import main
from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase
from tools.ks_supervisor.toolbox import (
    begin_mission, bind_mission, delegate_gemini, finish_mission, inspect_repository,
    mission_guard, record_cycle, role_instructions, source_identity, verify_source,
)
from tools.ks_supervisor.types import ExecutionMode, Role, TaskContract


class MissionTests(BaseSupervisorTestCase):
    def setUp(self):
        super().setUp()
        self.task_id = "TASK-2A-002"
        self.write_checkpoint(current_task=self.task_id)
        self.write_task(task_id=self.task_id)

    def test_partial_task_is_bound_without_any_product_write(self):
        source = self.repo_root / "backend/src/partial.ts"
        source.parent.mkdir(parents=True)
        source.write_text("existing partial work")
        before = self.config.checkpoint_path.read_bytes()
        result = begin_mission(self.config)
        self.assertEqual(result["task_id"], self.task_id)
        self.assertEqual(source.read_text(), "existing partial work")
        self.assertEqual(self.config.checkpoint_path.read_bytes(), before)
        self.assertEqual(result["inspection"]["recommended_category"], "GEMINI_CONTINUE")

    def test_no_active_task_can_bind_exactly_once_after_existing_definition(self):
        self.write_checkpoint(current_task="")
        mission = begin_mission(self.config)["mission_id"]
        packet = role_instructions(self.config, "ks-next", action="TASK_DEFINITION", mission_id=mission)
        self.assertIn("NO_ACTIVE_TASK", packet["instructions"])
        self.write_checkpoint(current_task=self.task_id)
        bind_mission(self.config, mission, self.task_id)
        with self.assertRaisesRegex(ValueError, "second task"):
            bind_mission(self.config, mission, "TASK-2A-003")
        with self.assertRaises(ValueError):
            role_instructions(self.config, "ks-next", action="TASK_DEFINITION", mission_id=mission)

    def test_second_task_is_rejected_before_worker_or_check_execution(self):
        handle = begin_mission(self.config)["mission_id"]
        self.write_task(task_id="TASK-2A-003")
        self.write_checkpoint(current_task="TASK-2A-003")
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke") as provider, patch("tools.ks_supervisor.targeted.execute_check") as check:
            with self.assertRaisesRegex(ValueError, "boundary"):
                delegate_gemini(self.config, "TASK-2A-003", mission_id=handle)
            with self.assertRaisesRegex(ValueError, "boundary"):
                verify_source(self.config, "TASK-2A-003", ["pnpm --dir backend run build"], source_identity(self.config), True, handle)
            with self.assertRaisesRegex(ValueError, "changed"):
                role_instructions(self.config, "ks-plan", self.task_id, mission_id=handle)
            provider.assert_not_called()
            check.assert_not_called()

    def test_closed_mission_cannot_rebind_or_execute_even_original_task(self):
        data = begin_mission(self.config)
        handle = data["mission_id"]
        path = self.config.runtime_dir / "v3/missions" / f"{handle}.json"
        data = json.loads(path.read_text())
        data["status"] = "COMPLETE"
        path.write_text(json.dumps(data))
        for operation in (
            lambda: mission_guard(self.config, handle, self.task_id),
            lambda: bind_mission(self.config, handle, self.task_id),
            lambda: record_cycle(self.config, self.task_id, "planning", "PASS", mission_id=handle),
        ):
            with self.assertRaises(ValueError):
                operation()

    def test_corrupt_mission_and_invalid_identity_fail_closed(self):
        handle = begin_mission(self.config)["mission_id"]
        path = self.config.runtime_dir / "v3/missions" / f"{handle}.json"
        path.write_text("invalid journal")
        for identity in (handle, "../../outside"):
            with self.assertRaises(ValueError):
                mission_guard(self.config, identity, self.task_id)

    def test_planner_and_manual_senior_reuse_codex_builder(self):
        with patch.object(CodexAdapter, "build_prompt", return_value="shared manual role") as builder:
            for role, action, expected in (("ks-plan", "", Role.PLANNER), ("ks-senior", "", Role.SENIOR), ("ks-senior", "TARGETED_VERIFICATION", Role.SENIOR), ("ks-next", "CLOSEOUT", Role.SENIOR)):
                packet = role_instructions(self.config, role, self.task_id, action)
                self.assertIn("shared manual role", packet["instructions"])
                self.assertEqual(builder.call_args.args, (expected, self.task_id))
                self.assertIsNone(packet["mission_id"])
        self.assertFalse((self.config.runtime_dir / "v3/missions").exists())

    def test_worker_reuses_owning_implementation_builder_with_thin_overlay(self):
        with patch.object(AntigravityAdapter, "build_prompt", return_value="existing implementer") as builder:
            packet = role_instructions(self.config, "ks-impl", self.task_id)
        self.assertIn("existing implementer", packet["instructions"])
        self.assertTrue(builder.call_args.kwargs["workspace_only"])
        self.assertEqual(builder.call_args.args, (Role.IMPLEMENTATION, self.task_id))
        self.assertLess(len(packet["instructions"]), 3000)

    def test_senior_is_review_only_even_for_autopilot_contracts(self):
        task = TaskContract(execution_mode=ExecutionMode.SENIOR_AUTOPILOT)
        for action in ("REVIEW", "TARGETED_VERIFICATION"):
            prompt = CodexAdapter(self.config).build_prompt(Role.SENIOR, self.task_id, action_type=action, task=task)
            self.assertIn("Stop after review", prompt)
            self.assertIn("return ACCEPTED", prompt)
            self.assertNotIn("execute closeout updates", prompt)
            self.assertNotIn("Implement the minimal", prompt)

    def test_manual_roles_recover_active_task_when_task_argument_is_omitted(self):
        for role, action in (("ks-plan", ""), ("ks-impl", ""), ("ks-senior", ""), ("ks-next", "CLOSEOUT")):
            packet = role_instructions(self.config, role, action=action)
            self.assertEqual(packet["task_id"], self.task_id)
            self.assertIn(self.task_id, packet["instructions"])

    def test_mission_cannot_switch_branch_mid_task(self):
        handle = begin_mission(self.config)["mission_id"]
        info = {**inspect_repository(self.config), "branch": "another-branch"}
        with patch("tools.ks_supervisor.toolbox.inspect_repository", return_value=info):
            with self.assertRaisesRegex(ValueError, "branch changed"):
                mission_guard(self.config, handle, self.task_id)

    def test_mission_reuses_persistent_human_stop_budget(self):
        handle = begin_mission(self.config)["mission_id"]
        record_cycle(self.config, self.task_id, "worker", "AUTH_QUOTA", reason="Login required", mission_id=handle)
        with self.assertRaisesRegex(ValueError, "Login required"):
            role_instructions(self.config, "ks-plan", self.task_id, mission_id=handle)
        with self.assertRaises(ValueError):
            begin_mission(self.config)

    def test_mission_begin_role_cli_and_manual_fallback(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(main(["--repo", str(self.repo_root), "mission", "begin", "--json"]), 0)
        handle = json.loads(output.getvalue())["mission_id"]
        for role, action in (("ks-plan", ""), ("ks-impl", ""), ("ks-senior", ""), ("ks-next", "CLOSEOUT")):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(main(["--repo", str(self.repo_root), "role-instructions", role, "--task", self.task_id, "--action", action, "--json"]), 0)
            self.assertIsNone(json.loads(output.getvalue())["mission_id"])
        self.assertEqual(mission_guard(self.config, handle, self.task_id)["task_id"], self.task_id)

    def test_finish_requires_real_accepted_closeout_and_commit(self):
        handle = begin_mission(self.config)["mission_id"]
        with self.assertRaises(ValueError):
            finish_mission(self.config, handle, ["backend/src/partial.ts"], "TASK-2A-003", "Next")
        self.assertEqual(mission_guard(self.config, handle, self.task_id)["status"], "ACTIVE")

    def accepted_fixture(self):
        mission = begin_mission(self.config)
        self.write_task(task_id=self.task_id, status="ACCEPTED")
        self.write_checkpoint(current_task=self.task_id, task_status="ACCEPTED")
        (self.config.reports_dir / f"{self.task_id}-implementation.md").write_text("Status: COMPLETE\n")
        (self.config.reviews_dir / f"{self.task_id}-review.md").write_text("Decision: APPROVED\nRemaining blockers: NONE\n")
        record_cycle(self.config, self.task_id, "closeout", "ACCEPTED", mission_id=mission["mission_id"])
        info = {**inspect_repository(self.config), "head": "a" * 40, "dirty_paths": ["unrelated.txt"], "staged_paths": []}
        return mission, info

    def commit_facts(self, mission, changed="README.md\n", parent=None, message=None):
        def git(root, *args):
            if args[0] == "diff-tree": return 0, changed, ""
            if args == ("rev-parse", "HEAD^"): return 0, parent or mission["initial_head"], ""
            if args == ("log", "-1", "--format=%s"): return 0, message or self.task_id + ": accepted mock", ""
            raise AssertionError("Unexpected Git operation: " + str(args))
        return git

    def test_finish_seals_mission_and_reports_preserved_unrelated_dirt(self):
        mission, info = self.accepted_fixture()
        before = self.config.checkpoint_path.read_bytes()
        with patch("tools.ks_supervisor.toolbox.inspect_repository", return_value=info), patch("tools.ks_supervisor.toolbox.run_git", side_effect=self.commit_facts(mission)):
            result = finish_mission(self.config, mission["mission_id"], ["README.md"], "TASK-2A-003", "Next")
        self.assertEqual(result["working_tree"], "DIRTY")
        self.assertEqual(result["dirty_paths"], ["unrelated.txt"])
        self.assertFalse(result["next_task"]["started"])
        self.assertEqual(self.config.checkpoint_path.read_bytes(), before)
        with self.assertRaises(ValueError):
            role_instructions(self.config, "ks-plan", self.task_id, mission_id=mission["mission_id"])

    def test_wrong_commit_scope_parent_message_or_uncommitted_content_cannot_finish(self):
        mission, info = self.accepted_fixture()
        variants = (
            ({}, self.commit_facts(mission, changed="unrelated.txt\n")),
            ({}, self.commit_facts(mission, parent="b" * 40)),
            ({}, self.commit_facts(mission, message="TASK-2A-003: other task")),
            ({"dirty_paths": ["README.md"]}, self.commit_facts(mission)),
            ({"staged_paths": ["unrelated.txt"]}, self.commit_facts(mission)),
            ({"active_task": "TASK-2A-003"}, self.commit_facts(mission)),
            ({"branch": "main"}, self.commit_facts(mission)),
        )
        for changes, git in variants:
            with patch("tools.ks_supervisor.toolbox.inspect_repository", return_value={**info, **changes}), patch("tools.ks_supervisor.toolbox.run_git", side_effect=git):
                with self.assertRaises(ValueError):
                    finish_mission(self.config, mission["mission_id"], ["README.md"], "TASK-2A-003", "Next")
        self.assertEqual(mission_guard(self.config, mission["mission_id"], self.task_id)["status"], "ACTIVE")

    def test_content_change_after_accepted_closeout_cannot_finish(self):
        mission, _ = self.accepted_fixture()
        (self.repo_root / "README.md").write_text("changed after acceptance")
        with self.assertRaisesRegex(ValueError, "changed after closeout"):
            finish_mission(self.config, mission["mission_id"], ["README.md"], "TASK-2A-003", "Next")

    def test_entrypoints_and_controller_reference_shared_roles_not_duplicate_prompts(self):
        root = Path(__file__).resolve().parents[3]
        senior = (root / "tools/ks-senior.ps1").read_text()
        start = (root / "tools/ks-start.ps1").read_text()
        entry = (root / "tools/ks-entrypoints.ps1").read_text()
        self.assertIn("Stop after review", senior)
        self.assertNotIn("sole v3 control plane", senior)
        self.assertIn("$ksPrompt = 'ks-start'", start)
        self.assertIn("function ks-start", entry)
        self.assertIn("function ks-senior", entry)
        self.assertLess(len(start), 1400)
        self.assertNotIn("Orchestrate", start)
