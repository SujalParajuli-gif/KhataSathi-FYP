"""Exact report prefixes, rejected evidence, approved recovery; no live provider."""
import json
from unittest.mock import patch

from tools.ks_supervisor.tests.test_supervisor import BaseSupervisorTestCase
from tools.ks_supervisor.tests import test_bounded_turns as bounded
from tools.ks_supervisor.toolbox import (CycleLedger, begin_mission, inspect_repository,
    recover_report_provenance_gate, record_cycle)
from tools.ks_supervisor.report_provenance import report_violations, digest, REPORT_REWRITE_REASON
from tools.ks_supervisor.repo import compute_file_hash, run_git


class ReportProvenanceTests(BaseSupervisorTestCase):
    packet = bounded.BoundedTurnsTests.packet
    result = bounded.BoundedTurnsTests.result
    turn = bounded.BoundedTurnsTests.turn
    assess = bounded.BoundedTurnsTests.assess
    worker = bounded.BoundedTurnsTests.worker

    def setUp(self):
        super().setUp()
        self.task_id = "TASK-2A-002"
        self.write_checkpoint(current_task=self.task_id)
        self.contract = self.write_task(task_id=self.task_id)
        self.plan = self.config.plans_dir / f"{self.task_id}-plan.md"
        self.plan.write_text("Final plan disposition: IMPLEMENTATION-READY.\nStep 4: storage\n")
        self.source = self.repo_root / "backend/src/partial.ts"
        self.source.parent.mkdir(parents=True)
        self.source.write_text("existing partial\n")
        self.completed = self.repo_root / "backend/src/completed.ts"
        self.completed.write_text("completed interface\n")
        self.report = self.config.reports_dir / f"{self.task_id}-implementation.md"
        self.prior = b"Status: IN_PROGRESS\r\n## Older worker\r\nUnverified claim\r\n\r\n\n"
        self.report.write_bytes(self.prior)
        self.mission = begin_mission(self.config)["mission_id"]
        self.mission_path = self.config.runtime_dir / "v3/missions" / f"{self.mission}.json"
        self.mission_before = self.mission_path.read_bytes()
        self.prompts = []

    def section(self, run_id):
        return f"\n## Worker turn {run_id}\nCodex-recovered checkpoint\nNew source progress; checks NOT RUN\n".encode()

    def rejected(self):
        def rewrite(role, task_id, **kw):
            result = self.worker(role, task_id, **kw)
            self.report.write_bytes(self.report.read_bytes().replace(b"Unverified claim", b"Verified claim"))
            return result
        return self.turn(rewrite)

    def recover(self, output, authorization="Explicit test approval", prior=None, section=None):
        directory = self.config.runtime_dir / "v3/workers" / output["run_id"]
        prior_path = directory / "recovery-input-prior.bin"
        prior_path.write_bytes(self.prior if prior is None else prior)
        section_path = directory / "recovery-input-section.bin"
        section_path.write_bytes(self.section(output["run_id"]) if section is None else section)
        return recover_report_provenance_gate(self.config, self.task_id, self.mission, output["run_id"],
            authorization, prior_path, directory / "report-candidate.bin", section_path, compute_file_hash(self.report))

    def test_pure_append_accepted_exact_mixed_newlines(self):
        output = self.turn()
        self.assertEqual(output["violations"], [])
        self.assertTrue(self.report.read_bytes().startswith(self.prior))

    def test_historical_edit_rejected_and_candidate_retained(self):
        output = self.rejected()
        self.assertEqual(output["violations"], [REPORT_REWRITE_REASON])
        evidence = output["cycle"]["record"]["report_provenance"]
        from pathlib import Path
        self.assertEqual(Path(evidence["prior"]["path"]).read_bytes(), self.prior)
        self.assertEqual(Path(evidence["candidate"]["path"]).read_bytes(), self.report.read_bytes())
        self.assertEqual(evidence["candidate"]["sha256"], compute_file_hash(self.report))

    def test_deleting_reordering_summarizing_history_rejected(self):
        for candidate in (b"", b"Summary of earlier work\n", b"Unverified claim\n" + self.prior,
                          self.prior.replace(b"\r\n", b"\n"), self.prior[:-1]):
            with self.subTest(candidate=candidate):
                self.assertEqual(report_violations(self.prior, candidate), [REPORT_REWRITE_REASON])

    def test_appended_correction_accepted(self):
        def correction(role, task_id, **kw):
            result = self.worker(role, task_id, **kw)
            with self.report.open("ab") as stream:
                stream.write(b"Correction to older claim: still unverified.\n")
            return result
        self.assertEqual(self.turn(correction)["violations"], [])

    def test_turn_identity_exactly_one_section_required(self):
        run_id = "a" * 32
        for section in (self.section("b" * 32), self.section(run_id) * 2, self.section(run_id) + b"## Other section\n", b"unnamed append\n"):
            self.assertTrue(report_violations(self.prior, self.prior + section, run_id))
        self.assertEqual(report_violations(self.prior, self.prior + self.section(run_id), run_id), [])

    def test_recovery_restores_exact_history_and_appends_current_information(self):
        output = self.rejected()
        result = self.recover(output)
        self.assertEqual(self.report.read_bytes(), self.prior + self.section(output["run_id"]))
        self.assertEqual(result["record"]["outcome"], "REPORT_PROVENANCE_RECOVERED")
        self.assertEqual(inspect_repository(self.config)["recommended_category"], "CODEX_INSPECT_CHECKPOINT")
        self.assertEqual(self.assess(output)["record"]["outcome"], "PRODUCTIVE_CHECKPOINT")

    def test_source_mission_history_counters_preserved_without_operations(self):
        ledger = CycleLedger(self.config)
        ledger.append(self.task_id, "verification", "INFRASTRUCTURE_FAILURE", failure_signature="older")
        ledger.append(self.task_id, "review", "FIX_REQUIRED", blockers=["B1"])
        ledger.append(self.task_id, "review", "FIX_REQUIRED", blockers=["B1"])
        output = self.rejected()
        history, source = ledger.path.read_bytes(), self.source.read_bytes()
        contract, plan = self.contract.read_bytes(), self.plan.read_bytes()
        budget = ledger.budget(self.task_id)
        head = run_git(self.repo_root, "rev-parse", "HEAD")[1]
        with patch("tools.ks_supervisor.toolbox.AntigravityAdapter.invoke") as invoke, \
             patch("tools.ks_supervisor.toolbox.run_check") as check, \
             patch("tools.ks_supervisor.toolbox.run_git", wraps=run_git) as git:
            recovered = self.recover(output)
            invoke.assert_not_called()
            check.assert_not_called()
            self.assertFalse(any(any(word in str(call).lower() for word in
                ("commit", "reset", "clean", "deploy", "migrate", "push")) for call in git.call_args_list))
        self.assertTrue(ledger.path.read_bytes().startswith(history))
        self.assertEqual(self.source.read_bytes(), source)
        self.assertEqual(self.mission_path.read_bytes(), self.mission_before)
        self.assertEqual(self.contract.read_bytes(), contract)
        self.assertEqual(self.plan.read_bytes(), plan)
        self.assertEqual(run_git(self.repo_root, "rev-parse", "HEAD")[1], head)
        for key in ("infrastructure_failures", "no_effect_returns", "stagnant_corrections"):
            self.assertEqual(recovered["budget"][key], budget[key])
        self.assertEqual(recovered["budget"]["cycles_used"], budget["cycles_used"] + 1)
        self.assertIn(output["cycle"]["record"], ledger.records())

    def test_automated_prompt_requires_cumulative_exact_append(self):
        output = self.turn()
        prompt = self.prompts[-1]
        for phrase in ("Existing canonical implementation report bytes are immutable", "EXACT_PRIOR_CONTENT",
                       "Append exactly ONE", "## Worker turn " + output["run_id"], "trailing newlines/EOF",
                       "corrections explicitly", "leave the report untouched"):
            self.assertIn(phrase, prompt)
        self.assertNotIn("progress at the start and before returning", prompt)

    def test_wrong_prior_or_unapproved_recovery_rejected(self):
        output = self.rejected()
        candidate = self.report.read_bytes()
        for authorization, prior in (("", self.prior), ("approved", self.prior[:-1])):
            with self.assertRaises(ValueError):
                self.recover(output, authorization=authorization, prior=prior)
            self.assertEqual(self.report.read_bytes(), candidate)

    def test_wrong_turn_recovery_and_duplicate_recovery_rejected(self):
        output = self.rejected()
        with self.assertRaises(ValueError):
            self.recover(output, section=self.section("a" * 32))
        self.recover(output)
        with self.assertRaises(ValueError):
            self.recover(output)

    def test_other_gate_remains_sticky(self):
        output = self.rejected()
        CycleLedger(self.config).append(self.task_id, "worker", "AUTH_QUOTA", reason="Real quota exhausted")
        result = self.recover(output)
        self.assertEqual(result["budget"]["status"], "HUMAN_INPUT_REQUIRED")
        self.assertIn("Real quota", result["budget"]["reason"])

    def test_recovery_proof_tampering_and_generic_remediation_rejected(self):
        output = self.rejected()
        with self.assertRaises(ValueError):
            record_cycle(self.config, self.task_id, "remediation", "REPORT_PROVENANCE_RECOVERED")
        recovered = self.recover(output)
        from pathlib import Path
        Path(recovered["record"]["report_recovery"]["recovered"]["path"]).write_bytes(b"replacement")
        with self.assertRaises(ValueError):
            CycleLedger(self.config).budget(self.task_id)

    def test_no_report_update_allowed_without_fabricated_section(self):
        def no_report(role, task_id, **kw):
            self.source.write_text(self.source.read_text() + "source progress\n")
            return self.result(task_id, kw["run_id"], stdout="No report update appropriate; Codex recover facts")
        output = self.turn(no_report)
        self.assertEqual(output["violations"], [])
        self.assertFalse(output["cycle"]["record"]["report_updated"])

    def test_absent_report_left_absent_is_not_a_rewrite_but_deletion_is(self):
        self.assertEqual(report_violations(b"", None, prior_exists=False), [])
        self.assertEqual(report_violations(b"", None, prior_exists=True), [REPORT_REWRITE_REASON])
        self.report.unlink()
        def no_report(role, task_id, **kw):
            self.source.write_text(self.source.read_text() + "source only\n")
            return self.result(task_id, kw["run_id"])
        self.assertEqual(self.turn(no_report)["violations"], [])

    def test_legacy_gate_requires_existing_independent_hash_records(self):
        first = self.turn()
        self.assess(first)
        self.prior = self.report.read_bytes()
        output = self.rejected()
        # Reproduce a historical return recorded before per-turn byte snapshots.
        original = output["cycle"]["record"]
        original.pop("report_provenance")
        ledger = CycleLedger(self.config)
        records = ledger.records()
        records[-1] = original
        ledger.path.write_text("".join(json.dumps(r) + "\n" for r in records))
        directory = self.config.runtime_dir / "v3/workers" / output["run_id"]
        (directory / "return.json").write_text(json.dumps(output))
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.recover(output)
        audit_dir = self.config.runtime_dir / "v3/auth-classifier-repair"
        audit_dir.mkdir()
        (audit_dir / "new-report-provenance-gate.json").write_text(json.dumps(dict(
            worker_run_id=output["run_id"], mission_id=self.mission,
            violations=[REPORT_REWRITE_REASON], before_report_sha256=digest(self.prior),
            after_report_sha256=compute_file_hash(self.report))))
        self.recover(output)
        self.assertEqual(self.report.read_bytes(), self.prior + self.section(output["run_id"]))
