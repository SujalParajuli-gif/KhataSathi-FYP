"""Permission-stop continuation is recovery guidance, never a policy/model bypass."""
from datetime import datetime, timezone
import json
from unittest.mock import patch

from tools.ks_supervisor.adapters.antigravity import AntigravityAdapter
from tools.ks_supervisor.permissions import CommandPermissions
from tools.ks_supervisor.runner import SupervisorRunner
from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase
from tools.ks_supervisor.types import AgentResult, Role, WorkflowState


class TestPermissionContinuation(BaseSupervisorTestCase):
    def setUp(self):
        super().setUp()
        self.task_id = 'TASK-2A-002'
        self.write_checkpoint(current_task=self.task_id)
        self.write_task(self.task_id, planning_required='YES', execution_mode='PLANNED_IMPLEMENTATION',
                        risk='HIGH', difficulty='8/10', title='Static QR receiving accounts')
        (self.config.plans_dir / f'{self.task_id}-plan.md').write_text('# Existing complete plan\n')
        self.partial = self.repo_root / 'backend/src/partial.ts'
        self.partial.parent.mkdir(parents=True)
        self.partial.write_text('// existing partial implementation\n')
        self.runner = SupervisorRunner(self.config)

    def permission_record(self, **updates):
        run = dict(timestamp='2026-10-07T09:30:40+00:00', task_id=self.task_id,
                   provider='antigravity', role='IMPLEMENTATION', action='IMPLEMENTATION',
                   success=False, soft_permission_denial=True, denied_actions=['command / RunCommand'])
        run.update(updates)
        stop = dict(timestamp='2026-10-07T09:30:41+00:00', task_id=self.task_id,
                    state='AGENT_PERMISSION_REQUIRED')
        (self.config.runtime_dir / 'last_agent_run.json').write_text(json.dumps(run))
        (self.config.runtime_dir / 'stop_report.json').write_text(json.dumps(stop))

    def prompt(self, flag=True):
        return self.runner.antigravity_adapter.build_prompt(
            Role.IMPLEMENTATION, self.task_id, dirty_files=['backend/src/partial.ts'],
            permission_stop_continuation=flag)

    def test_permission_continuation_forbids_shell_discovery_and_names_workspace_tools(self):
        self.permission_record()
        self.assertTrue(self.runner._shell_permission_continuation(self.task_id))
        prompt = self.prompt()
        self.assertIn('Do not use RunCommand or shell commands for repository navigation/discovery.', prompt)
        self.assertIn('Use built-in workspace tools: list_dir, grep_search, view_file.', prompt)
        self.assertIn('Workflow State: IMPLEMENTATION_IN_PROGRESS', prompt)

    def test_partial_work_is_preserved_and_resumed_without_restart(self):
        before = self.partial.read_bytes()
        prompt = self.prompt()
        self.assertIn('Preserve all existing partial implementation changes.', prompt)
        self.assertIn('Resume from the current repository state; do not restart or overwrite completed work.', prompt)
        self.assertIn('Do not reset, clean, revert, or duplicate completed implementation work.', prompt)
        self.assertIn('backend/src/partial.ts', prompt)
        self.assertEqual(self.partial.read_bytes(), before)

    def test_permission_guidance_does_not_change_allowlist_or_headless_policy(self):
        policy = CommandPermissions().metadata()
        prompt = self.prompt()
        self.assertIn('genuinely required approved command must be executed and is permitted by the existing allowlist', prompt)
        self.assertIn('Do not request broad command(*) permission.', prompt)
        self.assertIn('Do not weaken or bypass headless permission policy.', prompt)
        self.assertIn('Do not escalate model solely because of permission denial.', prompt)
        self.assertEqual(CommandPermissions().metadata(), policy)
        self.assertNotIn('--dangerously-skip-permissions', prompt)

    def test_non_permission_continuation_remains_unchanged(self):
        adapter = AntigravityAdapter(self.config)
        old = adapter.build_prompt(Role.IMPLEMENTATION, self.task_id, dirty_files=['backend/src/partial.ts'])
        self.assertEqual(old, self.prompt(flag=False))
        self.assertNotIn('RunCommand Permission-Stop Continuation', old)
        self.assertIn('Continuation from Existing Working Tree', old)
        self.assertIn('Workflow State: DIRECT_IMPLEMENTATION', old)

    def test_other_task_provider_role_or_denied_tool_cannot_trigger_instruction(self):
        for changes in [dict(task_id='TASK-OTHER-001'), dict(provider='codex'),
                        dict(role='SENIOR'), dict(action='FIX_REQUIRED_REMEDIATION'),
                        dict(success=True), dict(denied_actions=['write_file'])]:
            with self.subTest(changes=changes):
                self.permission_record(**changes)
                self.assertFalse(self.runner._shell_permission_continuation(self.task_id))

    def test_stale_stop_and_corrupt_runtime_do_not_trigger_instruction(self):
        self.permission_record(timestamp='2026-10-07T09:30:42+00:00')
        self.assertFalse(self.runner._shell_permission_continuation(self.task_id))
        (self.config.runtime_dir / 'last_agent_run.json').write_text('incomplete JSON')
        self.assertFalse(self.runner._shell_permission_continuation(self.task_id))

    def test_non_permission_stop_does_not_trigger_instruction(self):
        self.permission_record()
        path = self.config.runtime_dir / 'stop_report.json'
        stop = json.loads(path.read_text())
        stop['state'] = 'AGENT_EXECUTION_TIMEOUT'
        path.write_text(json.dumps(stop))
        self.assertFalse(self.runner._shell_permission_continuation(self.task_id))

    def test_fix_prompt_is_not_changed_by_implementation_permission_context(self):
        adapter = self.runner.antigravity_adapter
        kwargs = dict(is_fix=True, dirty_files=['backend/src/partial.ts'])
        self.assertEqual(adapter.build_prompt(Role.IMPLEMENTATION, self.task_id, **kwargs),
                         adapter.build_prompt(Role.IMPLEMENTATION, self.task_id,
                                              permission_stop_continuation=True, **kwargs))

    def test_repeated_permission_denial_preserves_progress_state_model_and_fail_safe_stop(self):
        self.config.enable_live_agents = True  # Fixture subprocesses are mocked; no provider call.
        before = self.runner.get_status()
        self.assertEqual(before.state, WorkflowState.IMPLEMENTATION_IN_PROGRESS)
        self.assertEqual(before.model_selection.profile.model, 'gemini-3.7-flash-medium')
        prompts = []

        def denied(*args, **kwargs):
            prompts.append(kwargs['prompt'])
            if len(prompts) == 1:
                self.partial.write_text(self.partial.read_text() + '// completed additional source preparation\n')
            profile = kwargs['profile']
            return AgentResult(
                run_id=kwargs['run_id'], started_at=datetime.now(timezone.utc).isoformat(),
                role=Role.IMPLEMENTATION, task_id=self.task_id, provider='antigravity',
                model_name=profile.model, effort=profile.effort,
                stdout='', stderr='', duration_seconds=0.01,
                exit_code=0, success=False, process_started=True, process_completed=True,
                soft_permission_denial=True, denied_actions=['command / RunCommand'],
                error_message='fixture headless permission denial',
            )

        with patch.object(self.runner.antigravity_adapter, 'invoke', side_effect=denied):
            first, first_stop = self.runner.run_step(execute_agents=True)
            self.assertEqual(first_stop.state, WorkflowState.AGENT_PERMISSION_REQUIRED, first_stop.reason)
            self.assertTrue(self.runner.current_agent_result.observable_repo_effect)
            existing = self.partial.read_bytes()
            # Restarting the Supervisor must still recover the last permission-stop context.
            self.runner = SupervisorRunner(self.config)
            with patch.object(self.runner.antigravity_adapter, 'invoke', side_effect=denied):
                second, second_stop = self.runner.run_step(execute_agents=True)
        self.assertEqual(second_stop.state, WorkflowState.AGENT_PERMISSION_REQUIRED)
        self.assertFalse(self.runner.current_agent_result.observable_repo_effect)
        self.assertEqual(second.state, WorkflowState.IMPLEMENTATION_IN_PROGRESS)
        self.assertEqual(self.partial.read_bytes(), existing)
        self.assertNotIn('RunCommand Permission-Stop Continuation', prompts[0])
        self.assertIn('RunCommand Permission-Stop Continuation', prompts[1])
        self.assertIn('Workflow State: IMPLEMENTATION_IN_PROGRESS', prompts[1])
        self.assertEqual(self.runner.impl_attempts.get(self.task_id, 0), 0)
        self.assertEqual(self.runner.fix_cycles.get(self.task_id, 0), 0)
        after = self.runner.get_status()
        self.assertEqual(after.model_selection.profile.model, before.model_selection.profile.model)
        self.assertFalse(after.model_selection.is_escalated)
