"""Accepted-clean re-anchor and post-commit reporting in isolated repositories."""
from unittest.mock import patch
from contextlib import redirect_stdout
from io import StringIO

from tools.ks_supervisor.cli import cmd_run
from tools.ks_supervisor.repo import capture_repository_baseline, compute_repository_delta, get_git_state, parse_checkpoint, parse_task_contract, run_git
from tools.ks_supervisor.runner import ACTION_TASK_DEFINITION, SupervisorRunner, evaluate_postconditions
from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase
from tools.ks_supervisor.types import Role, WorkflowState


class AcceptedRepository(BaseSupervisorTestCase):
    def setUp(self):
        super().setUp()
        # Production workflow state is ignored. Re-anchoring must keep Git clean.
        (self.repo_root / '.gitignore').write_text('docs/engineering/\n', encoding='utf-8')
        run_git(self.repo_root, 'add', '.gitignore')
        run_git(self.repo_root, 'commit', '-m', 'Ignore local workflow fixtures')
        self.write_checkpoint(task_status='ACCEPTED')
        self.accepted_path = self.write_task(status='ACCEPTED')
        self.rows = [('TASK-01-001', 'ACCEPTED')]
        self.write_registry()

    def write_registry(self):
        self.config.task_registry_path.write_text(
            '| Task ID | Name | Phase | Risk | Status |\n'
            + ''.join(f'| {tid} | fixture | 1A | MEDIUM | {status} |\n' for tid, status in self.rows),
            encoding='utf-8')

    def next_task(self, tid='TASK-01-002', planning=False, status='READY', branch='feat/phase-1a-test'):
        p = self.write_task(tid, status=status, planning_required='YES' if planning else 'NO',
                            execution_mode='PLANNED_IMPLEMENTATION' if planning else 'DIRECT_IMPLEMENTATION',
                            branch=branch)
        self.rows.append((tid, status))
        self.write_registry()
        return p

    def add_next_action(self, action):
        text = self.config.checkpoint_path.read_text()
        self.config.checkpoint_path.write_text(text.replace('\n```', f'\nNEXT_SAFE_ACTION: "{action}"\n```'))


class TestAcceptedAdvancement(AcceptedRepository):
    def test_cli_recognizes_deterministic_reanchor_without_agent_invocation(self):
        self.next_task(planning=True)
        output = StringIO()
        with redirect_stdout(output):
            result = cmd_run(self.config, once=True, live=True)
        self.assertEqual(result, 0, output.getvalue())
        self.assertIn('Transition Verified: True', output.getvalue())
        self.assertIn('Action: REANCHOR', output.getvalue())
        self.assertNotIn('IDENTITY_MISMATCH', output.getvalue())
        self.assertEqual(parse_task_contract(self.accepted_path).status, 'ACCEPTED')

    def test_dry_run_selects_first_eligible_registry_item_without_writes(self):
        self.next_task('TASK-01-003')
        self.next_task('TASK-01-002')
        before = self.config.checkpoint_path.read_bytes()
        accepted = self.accepted_path.read_bytes()
        state, stop = SupervisorRunner(self.config).run_step(dry_run=True)
        self.assertIsNone(stop)
        self.assertEqual(state.active_task_id, 'TASK-01-003')
        self.assertEqual(state.state, WorkflowState.DIRECT_IMPLEMENTATION)
        self.assertEqual(self.config.checkpoint_path.read_bytes(), before)
        self.assertEqual(self.accepted_path.read_bytes(), accepted)

    def test_reanchor_activates_planning_task_preserving_accepted_and_clean_git(self):
        self.next_task(planning=True)
        before = get_git_state(self.repo_root)
        accepted = self.accepted_path.read_bytes()
        registry = self.config.task_registry_path.read_bytes()
        runner = SupervisorRunner(self.config)
        with patch.object(runner.codex_adapter, 'invoke') as invoke:
            state, stop = runner.run_step(execute_agents=True)
        self.assertIsNone(stop)
        invoke.assert_not_called()
        self.assertEqual(state.active_task_id, 'TASK-01-002')
        self.assertEqual(state.state, WorkflowState.READY_FOR_PLANNING)
        self.assertEqual(state.assigned_role, Role.PLANNER)
        self.assertEqual(parse_checkpoint(self.config.checkpoint_path).current_task, 'TASK-01-002')
        self.assertEqual(self.accepted_path.read_bytes(), accepted)
        self.assertEqual(self.config.task_registry_path.read_bytes(), registry)
        self.assertEqual(parse_task_contract(self.accepted_path).status, 'ACCEPTED')
        self.assertEqual(get_git_state(self.repo_root), before)
        # Next step uses the pre-existing planner invocation path, never the accepted task.
        self.config.enable_live_agents = True
        with patch.object(runner, '_execute_agent_step', return_value=(state, None)) as execute:
            runner.run_step(execute_agents=True)
        self.assertEqual(execute.call_args.kwargs['role'], Role.PLANNER)
        self.assertEqual(execute.call_args.kwargs['state'].active_task_id, 'TASK-01-002')

    def test_checkpoint_named_next_task_takes_precedence(self):
        self.next_task('TASK-01-002')
        self.next_task('TASK-01-003', planning=True)
        self.add_next_action('Activate TASK-01-003 next')
        state, stop = SupervisorRunner(self.config).run_step(dry_run=True)
        self.assertIsNone(stop)
        self.assertEqual(state.active_task_id, 'TASK-01-003')

    def test_no_eligible_task_fails_closed_and_never_reopens_accepted(self):
        self.next_task(status='BLOCKED')
        before = self.config.checkpoint_path.read_bytes()
        runner = SupervisorRunner(self.config)
        with patch.object(runner.antigravity_adapter, 'invoke') as implementation:
            state, stop = runner.run_step(execute_agents=True)
        self.assertEqual(state.state, WorkflowState.NEXT_TASK_UNRESOLVED)
        self.assertIn('no eligible registry task', stop.reason)
        implementation.assert_not_called()
        self.assertEqual(self.config.checkpoint_path.read_bytes(), before)
        self.assertEqual(parse_task_contract(self.accepted_path).status, 'ACCEPTED')

    def test_unscoped_deliverable_routes_senior_definition_without_inventing_task(self):
        self.add_next_action('On resumption, scope ADMIN static QR settings/gallery/destination')
        runner = SupervisorRunner(self.config)
        task_files = list(self.config.tasks_dir.glob('*.md'))
        state, stop = runner.run_step(execute_agents=True)
        self.assertIsNone(stop)
        self.assertEqual(state.state, WorkflowState.NO_ACTIVE_TASK)
        self.assertEqual(state.assigned_role, Role.SENIOR)
        self.assertEqual(state.active_task_id, '')
        self.assertIn('scope ADMIN static QR', state.next_action_description)
        self.assertEqual(list(self.config.tasks_dir.glob('*.md')), task_files)
        self.assertEqual(parse_task_contract(self.accepted_path).status, 'ACCEPTED')
        self.assertTrue(get_git_state(self.repo_root).is_clean)
        self.config.enable_live_agents = True
        def execute_definition(**kwargs):
            self.assertEqual(kwargs['action'], ACTION_TASK_DEFINITION)
            self.assertEqual(kwargs['role'], Role.SENIOR)
            kwargs['invoke_fn']('fixture-run')
            return state, None
        with patch.object(runner, '_execute_agent_step', side_effect=execute_definition), patch.object(
                runner.codex_adapter, 'invoke') as invoke:
            runner.run_step(execute_agents=True)
        self.assertEqual(invoke.call_args.args, (Role.SENIOR, ''))
        self.assertEqual(invoke.call_args.kwargs['action_type'], ACTION_TASK_DEFINITION)

    def test_task_definition_observes_new_ignored_contract_and_workflow_effect(self):
        self.add_next_action('Scope ADMIN static QR settings')
        runner = SupervisorRunner(self.config)
        initial, stop = runner.run_step(execute_agents=True)
        self.assertIsNone(stop)
        pre = capture_repository_baseline(self.config, '')
        self.next_task(planning=True)
        self.write_checkpoint(current_task='TASK-01-002')
        post = capture_repository_baseline(self.config, '')
        delta = compute_repository_delta(pre, post, self.repo_root)
        target = runner.get_status()
        effect = evaluate_postconditions(ACTION_TASK_DEFINITION, initial, target, delta)
        self.assertTrue(effect.postconditions_valid, effect)
        self.assertTrue(effect.transition_valid)
        self.assertTrue(get_git_state(self.repo_root).is_clean)

    def test_high_risk_missing_planning_fails_closed(self):
        p = self.next_task()
        p.write_text(p.read_text().replace('Risk: MEDIUM', 'Risk: HIGH'))
        state, stop = SupervisorRunner(self.config).run_step(dry_run=True)
        self.assertEqual(state.state, WorkflowState.NEXT_TASK_UNRESOLVED)
        self.assertIn('planning metadata', stop.reason)

    def test_unsatisfied_dependency_and_wrong_branch_are_not_selected(self):
        p = self.next_task('TASK-01-002')
        p.write_text(p.read_text() + '\nDependencies / approval gates: TASK-01-099\n')
        self.next_task('TASK-01-003', branch='feat/other')
        state, stop = SupervisorRunner(self.config).run_step(dry_run=True)
        self.assertEqual(state.state, WorkflowState.NEXT_TASK_UNRESOLVED)
        self.assertIn('dependency/approval gates', stop.reason)
        self.assertIn('branch', stop.reason)

    def test_accepted_dependency_allows_candidate(self):
        p = self.next_task(planning=True)
        p.write_text(p.read_text() + '\nDependencies / approval gates: ACCEPTED TASK-01-001\n')
        state, stop = SupervisorRunner(self.config).run_step(dry_run=True)
        self.assertIsNone(stop)
        self.assertEqual(state.active_task_id, 'TASK-01-002')

    def test_incomplete_closeout_fails_closed(self):
        self.rows = [('TASK-01-001', 'READY')]
        self.write_registry()
        self.next_task()
        state, stop = SupervisorRunner(self.config).run_step(dry_run=True)
        self.assertEqual(state.state, WorkflowState.NEXT_TASK_UNRESOLVED)
        self.assertIn('closeout', stop.reason)


class TestCommitReporting(AcceptedRepository):
    def setUp(self):
        super().setUp()
        self.config.enable_auto_commit = True
        self.task = parse_task_contract(self.accepted_path)
        (self.repo_root / 'fixture.txt').write_text('synthetic fixture\n', encoding='utf-8')

    def test_success_reports_actual_head_and_retry_does_not_commit_again(self):
        runner = SupervisorRunner(self.config)
        before = get_git_state(self.repo_root).head_sha
        with patch('tools.ks_supervisor.runner.run_hygiene_check', return_value=(0, 'fixture PASS')):
            ok, message = runner.execute_auto_commit(self.task, get_git_state(self.repo_root))
        after = get_git_state(self.repo_root).head_sha
        self.assertTrue(ok, message)
        self.assertNotEqual(before, after)
        self.assertIn(after[:8], message)
        self.add_next_action('Scope next authorized delivery contract')
        # A new run after a committed-but-crashed report must re-anchor, not recommit.
        with patch.object(runner, 'execute_auto_commit') as commit:
            state, stop = runner.run_step(execute_agents=True)
        commit.assert_not_called()
        self.assertIsNone(stop)
        self.assertEqual(state.state, WorkflowState.NO_ACTIVE_TASK)
        self.assertEqual(get_git_state(self.repo_root).head_sha, after)
        self.assertEqual(parse_task_contract(self.accepted_path).status, 'ACCEPTED')

    def test_commit_failure_fails_closed(self):
        runner = SupervisorRunner(self.config)
        before = get_git_state(self.repo_root).head_sha
        original = run_git
        def fail_commit(root, *args):
            if args[0] == 'commit':
                return 1, '', 'fixture commit failure'
            return original(root, *args)
        with patch('tools.ks_supervisor.runner.run_git', side_effect=fail_commit), patch(
                'tools.ks_supervisor.runner.run_hygiene_check', return_value=(0, 'fixture PASS')):
            ok, message = runner.execute_auto_commit(self.task, get_git_state(self.repo_root))
        self.assertFalse(ok)
        self.assertIn('git commit failed', message)
        self.assertEqual(get_git_state(self.repo_root).head_sha, before)

    def test_postcommit_head_failure_does_not_repeat_commit(self):
        runner = SupervisorRunner(self.config)
        original = run_git
        commits = []
        def fail_reporting(root, *args):
            if args == ('rev-parse', 'HEAD'):
                return 1, '', 'fixture reporting failure'
            if args[0] == 'commit':
                commits.append(args)
            return original(root, *args)
        with patch('tools.ks_supervisor.runner.run_git', side_effect=fail_reporting), patch(
                'tools.ks_supervisor.runner.run_hygiene_check', return_value=(0, 'fixture PASS')):
            ok, message = runner.execute_auto_commit(self.task, get_git_state(self.repo_root))
        self.assertFalse(ok)
        self.assertIn('POSTCOMMIT_HEAD_UNAVAILABLE', message)
        self.assertEqual(len(commits), 1)
        self.assertTrue(get_git_state(self.repo_root).is_clean)
        with patch('tools.ks_supervisor.runner.run_git') as git:
            ok, message = runner.execute_auto_commit(self.task, get_git_state(self.repo_root))
        git.assert_not_called()
        self.assertTrue(ok)
        self.assertEqual(message, 'No files to commit')
