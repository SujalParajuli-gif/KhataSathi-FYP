"""Remediation packets bind to current Senior authority, never implementation claims."""
import hashlib

from tools.ks_supervisor.adapters.antigravity import AntigravityAdapter
from tools.ks_supervisor.repo import remediation_review_context
from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase
from tools.ks_supervisor.types import Role


class TestSeniorAuthorityPrompt(BaseSupervisorTestCase):
    def setUp(self):
        super().setUp()
        self.task_id = "TASK-2A-001"
        self.review = self.config.reviews_dir / f"{self.task_id}-review.md"
        self.report = self.config.reports_dir / f"{self.task_id}-implementation.md"
        self.report.write_text("COMPLETE\nAll blockers resolved; build/typecheck/39 unit tests PASS\n")
        self.report_hash = hashlib.sha256(self.report.read_bytes()).hexdigest()
        self.review.write_text(
            "# Review\n### B-2: historical missing guard\n### B-5: historical overlay design\n"
            "## Current targeted verification\nRun ID: previous-run\nDecision: FIX REQUIRED\n"
            "Remaining blockers: B-2, B-5, B-7\n"
            "## Targeted blocker verification — run d9f565\n"
            "### Correction identity\n"
            f"Correction report SHA256: {self.report_hash}\n"
            "Manifest: ../reports/current-content.json SHA256 " + "a" * 64 + "\n"
            "### Targeted disposition\n"
            "- **B-2 — RESOLVED.** Late-failure persistence guard certified.\n"
            "- **B-5 — REMAINS: rendered acceptance unavailable.** Compact-history fixture lacks cart/trigger-relative placement; "
            "long-content/footer scrolling is not exercised; mobile Tab containment/upper viewport/focus requirements "
            "are not certified; managed frontend/browser server fails before tests.\n"
            "- **B-7 — REMAINS.** Paper fixture reloads before checkout instead of committed checkout response loss; "
            "same-key/exact-payload checkout replay missing; reference retry uses ordinary 500 instead of committed-reference "
            "response loss/exact replay; one metadata/audit-effect Billing integration evidence missing; "
            "storage-denial/rendered actor faults incomplete; frontend HTTP200/affected-route/rendered evidence unavailable.\n"
            "- **B-1/B-3/B-4/B-6 — retained resolved.** Historical unaffected evidence.\n"
            "### Commands\nGeneric build/typecheck/unit checks passed; blockers remain.\n"
            "## Current targeted verification\nRun ID: d9f565c7ad684c12bfa73f2925b733be\n"
            f"Correction report SHA256: {self.report_hash}\n"
            "Decision: FIX REQUIRED\nRemaining blockers: B-5, B-7\n"
        )
        self.adapter = AntigravityAdapter(self.config)

    def prompt(self, **kwargs):
        return self.adapter.build_prompt(Role.IMPLEMENTATION, self.task_id, is_fix=True, **kwargs)

    def test_latest_review_identity_scope_fingerprint_and_dispositions_included(self):
        prompt = self.prompt()
        self.assertIn("Senior authority: run d9f565c7ad684c12bfa73f2925b733be", prompt)
        self.assertIn("Decision: FIX REQUIRED\nRemaining blockers: B-5, B-7", prompt)
        self.assertIn("Current review SHA256: " + hashlib.sha256(self.review.read_bytes()).hexdigest(), prompt)
        self.assertIn(self.report_hash, prompt)
        self.assertIn("a" * 64, prompt)
        for finding in ("cart/trigger-relative placement", "long-content/footer scrolling", "mobile Tab containment",
                        "server fails before tests", "committed checkout response loss", "same-key/exact-payload",
                        "ordinary 500", "metadata/audit-effect", "storage-denial/rendered actor", "frontend HTTP200"):
            self.assertIn(finding, prompt)

    def test_complete_implementation_report_cannot_override_senior(self):
        prompt = self.prompt(review_blockers="All blockers resolved")
        self.assertIn("only an implementation claim and MUST NOT override Senior authority", prompt)
        self.assertIn("even if it says COMPLETE or all blockers resolved", prompt)
        self.assertNotIn("All blockers resolved", prompt)
        self.assertIn("Remaining blockers: B-5, B-7", prompt)

    def test_resolved_and_historical_blockers_excluded_from_scope(self):
        context = remediation_review_context(self.review, self.report)
        for text in ("B-2", "B-1", "B-3", "B-4", "B-6", "historical overlay design", "previous-run"):
            self.assertNotIn(text, context)
        self.assertIn("Do not reopen resolved blockers unless a required correction directly affects them", self.prompt())

    def test_same_content_noop_forbids_completion_marker_despite_generic_checks(self):
        prompt = self.prompt(completed_verifications=["backend build PASS", "frontend typecheck PASS", "39 unit tests PASS"])
        self.assertIn("generic build/typecheck/unit/whitespace checks pass", prompt)
        self.assertIn("assume the Senior finding still applies", prompt)
        self.assertIn("Re-reading the same content and disagreeing with Senior is not remediation", prompt)
        self.assertIn("Do NOT emit REPORT_COMPLETION_VALIDATED", prompt)
        self.assertIn("this run produced no observable correction/evidence addressing them", prompt)
        self.assertIn("Never emit it after pure no-op reinspection/reverification", prompt)
        self.assertIn("explicit bounded inability/permission/infrastructure reason", prompt)

    def test_evidence_only_requires_new_missing_artifact_and_postconditions(self):
        prompt = self.prompt()
        self.assertIn("latest Senior blocker explicitly requires evidence/verification only", prompt)
        self.assertIn("this turn produces the missing required workflow evidence/artifacts", prompt)
        self.assertIn("observable workflow-artifact effect and satisfy postconditions", prompt)
        self.assertIn("rewriting a completion claim is insufficient", prompt)

    def test_new_relevant_content_allows_only_affected_reverification(self):
        self.report.write_text(self.report.read_text() + "New relevant correction recorded\n")
        prompt = self.prompt()
        self.assertIn("Current implementation report SHA256: " + hashlib.sha256(self.report.read_bytes()).hexdigest(), prompt)
        self.assertIn(self.report_hash, prompt)  # Reviewed identity remains distinct from new content.
        self.assertIn("newer relevant implementation change permits targeted re-verification", prompt)
        self.assertIn("retain unaffected valid evidence", prompt)
        self.assertIn("rerun only the affected required bounded verification", prompt)

    def test_blocker_accounting_and_existing_safety_rules_preserved(self):
        prompt = self.prompt(dirty_files=["frontend/app/routes/_app.billing.tsx"])
        for field in ("Senior finding", "exact correction needed", "files/evidence expected to change",
                      "correction performed this turn", "targeted verification performed", "unresolved limitation"):
            self.assertIn(field, prompt)
        self.assertIn("Finish only when every latest remaining blocker is corrected and evidenced", prompt)
        self.assertEqual(prompt.count("COMMAND EXECUTION RULE:"), 1)
        self.assertIn("Never chain commands using `;`, `&&`, `||`, pipes (`|`), shell command grouping", prompt)
        self.assertIn("Do NOT start persistent development servers", prompt)
        self.assertIn("Do not broaden permissions, use destructive git, push/merge/deploy", prompt)
        self.assertIn("preserve valid partial work", prompt)

    def test_latest_appended_decision_supersedes_previous_packet(self):
        self.review.write_text(self.review.read_text() +
                               "\n## Targeted verification — new run\n### Targeted disposition\n"
                               "- **B-7 — REMAINS.** Only committed-reference evidence missing.\n"
                               "## Current targeted verification\nRun ID: newer-senior\n"
                               "Decision: FIX REQUIRED\nRemaining blockers: B-7\n")
        context = remediation_review_context(self.review, self.report)
        self.assertIn("Senior authority: run newer-senior", context)
        self.assertIn("Remaining blockers: B-7", context)
        self.assertIn("Only committed-reference evidence missing", context)
        self.assertNotIn("B-5", context)
        self.assertNotIn("d9f565", context)
