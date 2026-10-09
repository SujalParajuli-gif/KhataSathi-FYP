"""AGENTS conceptual chat routing resolves shared roles; no provider invocation."""
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
    MISSION_DEFINITION, begin_mission, chat_entrypoint, delegate_gemini, record_cycle,
)


class ChatEntrypointTests(BaseSupervisorTestCase):
    def setUp(self):
        super().setUp()
        self.task_id = "TASK-2A-002"
        self.write_task(task_id=self.task_id, planning_required="YES", execution_mode="PLANNED_IMPLEMENTATION")
        self.write_checkpoint(current_task=self.task_id)
        (self.config.plans_dir / f"{self.task_id}-plan.md").write_text("Final plan disposition: IMPLEMENTATION-READY.\n")
        self.source = self.repo_root / "backend/src/partial.ts"
        self.source.parent.mkdir(parents=True)
        self.source.write_text("existing partial implementation\n")

    def test_exact_chat_start_reanchors_current_partial_task_without_launch_or_write(self):
        before = self.source.read_bytes(), self.config.checkpoint_path.read_bytes()
        with patch.object(CodexAdapter, "invoke") as codex, patch.object(AntigravityAdapter, "invoke") as gemini:
            packet = chat_entrypoint(self.config, "ks-start")
        self.assertEqual(packet["role"], "MISSION_CONTROLLER")
        self.assertEqual(packet["session"], "CURRENT_CODEX_SESSION")
        self.assertEqual(packet["mission_definition"], MISSION_DEFINITION)
        self.assertEqual(packet["inspection"]["active_task"], self.task_id)
        self.assertEqual(packet["inspection"]["recommended_category"], "CODEX_CONTINUE")
        self.assertEqual(packet["inspection"]["plan"]["state"], "IMPLEMENTATION_READY")
        self.assertEqual(before, (self.source.read_bytes(), self.config.checkpoint_path.read_bytes()))
        codex.assert_not_called()
        gemini.assert_not_called()

    def test_cli_chat_resolution_is_same_current_session_definition(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(main(["--repo", str(self.repo_root), "chat-entrypoint", "ks-start", "--json"]), 0)
        packet = json.loads(output.getvalue())
        self.assertEqual(packet["mission_definition"], MISSION_DEFINITION)
        self.assertFalse(packet["requires_powershell"])

    def test_quoted_embedded_unknown_or_case_changed_tokens_are_not_invocations(self):
        for token in ('"ks-start"', "please ks-start", "ks-start then ks-next", "KS-START", "unknown"):
            with self.assertRaisesRegex(ValueError, "exact"):
                chat_entrypoint(self.config, token)
        self.assertEqual(chat_entrypoint(self.config, " ks-start\n")["token"], "ks-start")

    def test_existing_manual_roles_reuse_builders_and_remain_independent(self):
        with patch.object(CodexAdapter, "build_prompt", wraps=CodexAdapter(self.config).build_prompt) as builder:
            plan = chat_entrypoint(self.config, "ks-plan")
            senior = chat_entrypoint(self.config, "ks-senior")
            self.assertEqual(builder.call_count, 2)
        self.assertEqual(plan["role"], "PLANNER")
        self.assertIn("Implementation Planner", plan["role_instructions"]["instructions"])
        self.assertEqual(senior["role"], "SENIOR_REVIEW")
        self.assertIn("Stop after review", senior["role_instructions"]["instructions"])
        with patch.object(AntigravityAdapter, "build_prompt", return_value="existing implementer") as builder:
            implementer = chat_entrypoint(self.config, "ks-impl")
        builder.assert_not_called()
        self.assertIn("current Codex session", implementer["role_instructions"]["instructions"])
        self.assertFalse((self.config.runtime_dir / "v3/missions").exists())

    def test_next_retains_router_advance_and_shared_closeout(self):
        packet = chat_entrypoint(self.config, "ks-next")
        self.assertEqual(packet["role"], "CLOSEOUT_ADVANCE")
        self.assertEqual(packet["router_definition"]["section"], 4)
        (self.config.reports_dir / f"{self.task_id}-implementation.md").write_text("Status: COMPLETE\n")
        (self.config.reviews_dir / f"{self.task_id}-review.md").write_text("Decision: APPROVED\nRemaining blockers: NONE\n")
        packet = chat_entrypoint(self.config, "ks-next")
        self.assertIn("Section 13", packet["role_instructions"]["instructions"])

    def test_chat_human_gate_stays_in_current_conversation_and_preserves_history(self):
        mission = begin_mission(self.config)
        record_cycle(self.config, self.task_id, "worker", "HUMAN_GATE", reason="Disposable MySQL target requires explicit authorization", mission_id=mission["mission_id"])
        packet = chat_entrypoint(self.config, "ks-start")
        self.assertEqual(packet["next"], "HUMAN_INPUT_REQUIRED")
        self.assertIn("MySQL", packet["human_input"]["reason"])
        self.assertIn("Reply in this chat", packet["human_input"]["safe_resume"])
        self.assertEqual(packet["session"], "CURRENT_CODEX_SESSION")
        self.assertFalse(packet["requires_powershell"])
        self.assertEqual(packet["inspection"]["budget"]["cycles_used"], 1)

    def test_accepted_task_cannot_reopen_through_chat_implementation_or_delegation(self):
        accepted = "TASK-2A-001"
        self.write_task(task_id=accepted, status="ACCEPTED")
        self.write_checkpoint(current_task=accepted, task_status="ACCEPTED")
        packet = chat_entrypoint(self.config, "ks-impl")
        self.assertEqual(packet["next"], "ACCEPTED_TASK_IMMUTABLE")
        self.assertNotIn("role_instructions", packet)
        with patch.object(AntigravityAdapter, "invoke") as worker:
            with self.assertRaises(ValueError):
                delegate_gemini(self.config, accepted)
            worker.assert_not_called()

    def test_terminal_forwards_exact_chat_token_and_agency_has_one_mission_definition(self):
        root = Path(__file__).resolve().parents[3]
        terminal = (root / "tools/ks-start.ps1").read_text(encoding="utf-8")
        agents = (root / "AGENTS.md").read_text(encoding="utf-8")
        router = (root / MISSION_DEFINITION["path"]).read_text(encoding="utf-8")
        self.assertIn("$ksPrompt = 'ks-start'", terminal)
        self.assertEqual(terminal.count("& codex"), 1)
        self.assertLess(len(terminal.splitlines()), 20)
        self.assertIn("Exact Codex chat dispatch", agents)
        self.assertIn("chat-entrypoint ks-start", agents)
        self.assertIn("current Codex IDE/chat session", agents)
        self.assertIn("ONE authoritative mission definition", router)
        self.assertEqual(router.count("## 9. ks-start:"), 1)
        self.assertIn("new interactive Codex CLI process/session", router)
        self.assertNotIn("### Bind, reuse roles", terminal)
