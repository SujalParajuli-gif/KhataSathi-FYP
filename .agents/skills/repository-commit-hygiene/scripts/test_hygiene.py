"""Exercise the policy against disposable real Git indexes and commits."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CHECKER = Path(__file__).with_name("check_hygiene.py")


class HygieneTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="khatasathi-hygiene-test-")
        self.repo = self.temp.name
        self.git("init", "-q")
        self.blob = self.git("hash-object", "-w", "--stdin", data=b"fixture\n").strip().decode()

    def tearDown(self):
        # Git marks loose objects read-only on Windows. Clear only fixture attributes.
        for path in Path(self.repo).rglob("*"):
            if path.is_file():
                path.chmod(0o600)
        self.temp.cleanup()

    def git(self, *args, data=None):
        return subprocess.run(["git", "-C", self.repo, *args], input=data,
                              capture_output=True, check=True).stdout

    def stage(self, path):
        self.git("update-index", "--add", "--cacheinfo", f"100644,{self.blob},{path}")

    def check(self, expected, *args):
        result = subprocess.run([sys.executable, str(CHECKER), "--repo", self.repo, *args],
                                capture_output=True, text=True)
        self.assertEqual(expected, result.returncode, result.stdout + result.stderr)
        return result.stdout

    def test_approved_source_and_assets(self):
        for path in ["README.md", "screenshots/Billing.png", "frontend/app/real component.tsx",
                     "backend/src/scripts/seedProductSearchAliases.ts", "deploy/scripts/backup.sh"]:
            self.stage(path)
        self.check(0, "--pre-push")

    def test_exact_canonical_workflow_allowlist(self):
        allowed = ["AGENTS.md", "GEMINI.md", "docs/engineering/ai/README.md",
                   "docs/engineering/ai/tasks/TASK_TEMPLATE.md",
                   "docs/engineering/ai/reports/IMPLEMENTATION_REPORT_TEMPLATE.md",
                   "docs/engineering/ai/reviews/REVIEW_TEMPLATE.md",
                   ".agents/skills/repository-commit-hygiene/SKILL.md",
                   ".agents/skills/repository-commit-hygiene/scripts/check_hygiene.py",
                   ".agents/skills/repository-commit-hygiene/scripts/test_hygiene.py",
                   ".agents/skills/khatasathi-workflow-router/SKILL.md",
                   ".agents/skills/khatasathi-implementation-planner/SKILL.md"]
        for path in allowed:
            self.stage(path)
        self.check(0, "--pre-push")

    def test_other_ai_artifacts_remain_forbidden(self):
        forbidden = ["agents.md", "docs/engineering/IMPLEMENTATION_CHECKPOINT.md",
                     "docs/engineering/PROJECT_PROGRESS.md",
                     "docs/engineering/ai/TASK_REGISTRY.md",
                     "docs/engineering/ai/tasks/TASK-WF-001-workflow-v2-bootstrap.md",
                     "docs/engineering/ai/reports/TASK-WF-001-implementation.md",
                     "docs/engineering/ai/reviews/TASK-WF-001-review.md",
                     ".agents/skills/product-photo-insertion-and-extraction/SKILL.md",
                     ".agents/skills/khatasathi-workflow-router/scratch.md"]
        for path in forbidden:
            self.stage(path)
        output = self.check(1)
        for path in forbidden:
            self.assertIn(path, output)

    def test_forbidden_paths(self):
        bad = ["NOTES.MD", ".AGENTS/skills/example/SKILL.md", "deploy/production.env",
               "backend/src/scripts/auditCleanPilot.ts", "scripts/package/mapping.csv",
               "frontend/node_modules/example/index.js", "frontend/test-results/log.json",
               "document-storage/customer.pdf", "frontend/public/.well-known/appspecific/com.chrome.devtools.json"]
        for path in bad:
            self.stage(path)
        output = self.check(1)
        for path in bad:
            self.assertIn(path, output)

    def stage_content(self, path, content_bytes):
        blob = self.git("hash-object", "-w", "--stdin", data=content_bytes).strip().decode()
        self.git("update-index", "--add", "--cacheinfo", f"100644,{blob},{path}")

    def test_staged_cleanup_vs_push(self):
        self.stage("README.md")
        self.stage("GUIDE.md")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture")
        self.git("update-index", "--force-remove", "GUIDE.md")
        self.assertIn("PENDING CLEANUP", self.check(0))
        self.assertIn("HEAD", self.check(1, "--pre-push"))

    def test_sensitive_content_hard_stop(self):
        # Synthetic private key (always blocked regardless of content)
        secret_key_body = "SYNTHETIC_PRIVATE_KEY_PAYLOAD_DO_NOT_EXPOSE"
        key_type = "RSA PRIVATE KEY"
        self.stage_content("backend/src/server.ts",
                           f"-----BEGIN {key_type}-----\n{secret_key_body}\n-----END {key_type}-----\n".encode())
        output = self.check(1)
        self.assertIn("BLOCK [index:content]", output)
        self.assertIn("suspected ssh-or-private-key", output)
        self.assertIn("Remediation:", output)
        self.assertNotIn(secret_key_body, output)

        # Clear and test synthetic API key
        self.git("update-index", "--force-remove", "backend/src/server.ts")
        secret_token = "live_secret_api_token_abcdef1234567890"
        self.stage_content("frontend/app/config.ts",
                           f'const api_key = "{secret_token}";\n'.encode())
        output = self.check(1)
        self.assertIn("BLOCK [index:content]", output)
        self.assertIn("suspected api-key-or-token", output)
        self.assertNotIn(secret_token, output)

        # Clear and test synthetic credential-bearing connection string
        self.git("update-index", "--force-remove", "frontend/app/config.ts")
        secret_pass = "secret_password_987654321"
        db_scheme = "mysql"
        self.stage_content("backend/src/db.ts",
                           f'const uri = "{db_scheme}://appuser:{secret_pass}@internal.db.corp:3306/db";\n'.encode())
        output = self.check(1)
        self.assertIn("BLOCK [index:content]", output)
        self.assertIn("suspected credential-connection-string", output)
        self.assertNotIn(secret_pass, output)

        # Clear and test synthetic database dump
        self.git("update-index", "--force-remove", "backend/src/db.ts")
        dump_data = "customer_data_record_dump"
        dump_header = "-- " + "MySQL dump 10.13"
        sql_stmt = "INSERT " + "INTO `users` VALUES"
        self.stage_content("backend/src/seed.sql",
                           f'{dump_header}\n{sql_stmt} (1, "{dump_data}");\n'.encode())
        output = self.check(1)
        self.assertIn("BLOCK [index:content]", output)
        self.assertIn("suspected database-dump", output)
        self.assertNotIn(dump_data, output)

    def test_sensitive_content_placeholder_bypass_resistance(self):
        # 1. Bearer token + trailing // example => blocked
        bearer_val = "synthetic_bearer_token_bypass_check_1234567890_long"
        self.stage_content("frontend/app/api.ts",
                           f'const auth = "Bearer {bearer_val}"; // example\n'.encode())
        output = self.check(1)
        self.assertIn("BLOCK [index:content]", output)
        self.assertIn("suspected bearer-token", output)
        self.assertNotIn(bearer_val, output)

        # 2. API key-like value + nearby example/test text => blocked when value itself is not safe placeholder
        self.git("update-index", "--force-remove", "frontend/app/api.ts")
        api_key_val = "prod_synthetic_api_key_12345678901234567890"
        self.stage_content("frontend/app/api.ts",
                           f'const apiKey = "{api_key_val}"; // test example fixture\n'.encode())
        output = self.check(1)
        self.assertIn("BLOCK [index:content]", output)
        self.assertIn("suspected api-key-or-token", output)
        self.assertNotIn(api_key_val, output)

        # 3. Explicit safe synthetic placeholder value => allowed if existing policy permits it
        self.git("update-index", "--force-remove", "frontend/app/api.ts")
        safe_bearer = "test-token-safe-placeholder-value-1234567890"
        safe_api_key = "test-api-key-placeholder-1234567890"
        self.stage_content("frontend/app/api.ts",
                           f'const auth = "Bearer {safe_bearer}";\nconst apiKey = "{safe_api_key}";\n'.encode())
        output = self.check(0)
        self.assertIn("PASS: path and content policy", output)

        # 4. Confirm private keys remain unconditionally blocked even if surrounded by test/example text
        self.git("update-index", "--force-remove", "frontend/app/api.ts")
        key_body = "SYNTHETIC_PRIVATE_KEY_PAYLOAD_DO_NOT_EXPOSE"
        key_type = "RSA PRIVATE KEY"
        self.stage_content("frontend/app/api.ts",
                           f'// test fixture example\n-----BEGIN {key_type}-----\n{key_body}\n-----END {key_type}-----\n'.encode())
        output = self.check(1)
        self.assertIn("suspected ssh-or-private-key", output)
        self.assertNotIn(key_body, output)


if __name__ == "__main__":
    unittest.main()
