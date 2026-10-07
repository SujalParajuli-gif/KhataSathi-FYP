"""Installed provider grants allow only enumerated source verification shapes."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools.ks_supervisor.permissions import (
    CLI_PROJECT, CommandPermissions, configure_source_verification_permissions,
)


class TestSourceVerificationPermissions(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.project = self.home / f'.gemini/config/projects/{CLI_PROJECT}.json'
        self.settings = self.home / '.gemini/antigravity-cli/settings.json'
        self.project.parent.mkdir(parents=True)
        self.settings.parent.mkdir(parents=True)
        self.settings.write_text('{}')
        self.project.write_text(json.dumps({'id': CLI_PROJECT, 'other': 'preserved',
            'permissionGrants': {'permissionGrants': {'allow': [
                'command(regex:git .*)', 'command(regex:node --test backend/dist/tests/.*)',
                'unsandboxed(git)', 'read_file(workspace/)'], 'deny': [], 'ask': []}}}))
        home = patch('tools.ks_supervisor.permissions.Path.home', return_value=self.home)
        home.start()
        self.addCleanup(home.stop)
        configure_source_verification_permissions()

    def assert_allowed(self, *commands):
        for command in commands:
            with self.subTest(command=command):
                self.assertTrue(CommandPermissions().authorized(command)[0])

    def assert_denied(self, *commands):
        for command in commands:
            with self.subTest(command=command):
                self.assertFalse(CommandPermissions().authorized(command)[0])

    def test_exact_prisma_validate(self):
        self.assert_allowed('pnpm --dir backend exec prisma validate')

    def test_generate_and_backend_build(self):
        self.assert_allowed('pnpm --dir backend exec prisma generate', 'pnpm --dir backend run build',
                            'pnpm.cmd --dir backend exec prisma validate')

    def test_explicit_tests_typecheck_browser_and_diff(self):
        self.assert_allowed('node --test backend/dist/tests/paymentAccounts.test.js backend/dist/tests/payments.test.js',
            'pnpm --dir frontend run typecheck', 'pnpm --dir frontend run test:routes',
            'node --experimental-strip-types --test frontend/tests/billingPaymentAccounts.test.mjs',
            'pnpm --dir frontend run test:browser -- tests/browser/settings-payment-accounts.spec.ts tests/browser/billing-payment-accounts.spec.ts',
            'git diff --check')

    def test_database_mutations_denied(self):
        self.assert_denied(*['pnpm --dir backend exec prisma ' + suffix for suffix in
                            ('migrate deploy', 'migrate reset', 'db push', 'db seed', 'db execute')])

    def test_connected_fixtures_denied_even_with_an_allowed_test(self):
        self.assert_denied('node --test backend/dist/tests/paymentAccounts.mysql.test.js',
            'node --test backend/dist/tests/paymentAccountsMigration.mysql.test.js',
            'node --test backend/dist/tests/payments.test.js backend/dist/tests/requestCheckout.mysql.test.js')

    def test_arbitrary_commands_and_startups_denied(self):
        self.assert_denied('pnpm install', 'npm test', 'node -e alert()', 'node arbitrary.js',
            'node --test backend/dist/tests/arbitrary.test.js', 'pwd', 'dir', 'cd backend',
            'curl https://example.com', 'git push', 'git merge main', 'git reset --hard',
            'pnpm --dir backend run dev', 'pnpm --dir frontend run dev',
            'pnpm --dir backend run build -- arbitrary', 'pnpm --dir backend exec prisma validate --schema /tmp/schema.prisma')

    def test_chaining_substitution_and_grouping_denied(self):
        command = 'pnpm --dir backend exec prisma validate'
        for separator in (';', '&&', '||', '|', '\n', '\r\n'):
            self.assert_denied(command + separator + ' git diff --check')
        self.assert_denied('(' + command + ')', command + ' > output', command + ' $(whoami)',
                           command + ' `whoami`', '{' + command + '}')

    def test_outside_paths_traversal_and_wildcards_denied(self):
        for path in ('../outside.test.js', '/tmp/payments.test.js', 'C:/outside.test.js',
                     'backend/dist/tests/../../../outside.test.js', 'backend/dist/tests/*.test.js',
                     'backend/dist/tests/payments.test.js/../outside.js'):
            self.assert_denied('node --test ' + path)
        self.assert_denied('pnpm --dir frontend run test:browser -- ../outside.spec.ts',
                           'pnpm --dir frontend run test:browser -- tests/browser/*.spec.ts')

    def test_no_broad_grants_and_noncommand_fields_preserved(self):
        data = json.loads(self.project.read_text())
        grants = data['permissionGrants']['permissionGrants']
        self.assertEqual(data['other'], 'preserved')
        self.assertIn('read_file(workspace/)', grants['allow'])
        self.assertNotIn('command(*)', json.dumps(grants))
        self.assertNotIn('--dangerously-skip-permissions', json.dumps(grants))
        self.assertFalse(any(r.startswith('unsandboxed(') for r in grants['allow']))
        command_rules = [r for r in grants['allow'] if r.startswith('command(')]
        self.assertEqual(len(command_rules), 7)
        self.assertTrue(all(r.startswith('command(regex:^') and r.endswith('$)') for r in command_rules))

    def test_deny_and_ask_precedence_preserved(self):
        for location, name in ((self.settings, 'deny'), (self.project, 'ask')):
            data = json.loads(location.read_text())
            grants = data.setdefault('permissions', {}) if location == self.settings else data['permissionGrants']['permissionGrants']
            grants[name] = ['command(pnpm --dir backend exec prisma validate)']
            location.write_text(json.dumps(data))
            configure_source_verification_permissions()
            self.assert_denied('pnpm --dir backend exec prisma validate')
            updated = json.loads(location.read_text())
            actual = updated['permissions'] if location == self.settings else updated['permissionGrants']['permissionGrants']
            self.assertEqual(actual[name], grants[name])

    def test_setup_idempotent_and_reading_policy_does_not_write(self):
        before = self.project.read_bytes()
        configure_source_verification_permissions()
        self.assertEqual(before, self.project.read_bytes())
        self.assert_allowed('git diff --check')
        self.assertEqual(before, self.project.read_bytes())

    def test_global_broad_grant_requires_separate_review(self):
        before = self.project.read_bytes()
        self.settings.write_text(json.dumps({'permissions': {'allow': ['command(regex:git .*)']}}))
        with self.assertRaisesRegex(ValueError, 'Global command grants'):
            configure_source_verification_permissions()
        self.assertEqual(before, self.project.read_bytes())
