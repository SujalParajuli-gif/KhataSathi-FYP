"""Supervisor-owned implementation completion provenance, independent of session history."""
from dataclasses import asdict
import json
from pathlib import Path
import re
from typing import Optional

from tools.ks_supervisor.config import SupervisorConfig
from tools.ks_supervisor.adapters.antigravity import parse_antigravity_stream
from tools.ks_supervisor.repo import compute_file_hash, get_git_state
from tools.ks_supervisor.types import AgentInvocation, AgentResult


def completion_path(config: SupervisorConfig, task_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", task_id):
        raise ValueError("Invalid completion task identifier")
    return config.runtime_dir / "completion_attestations" / f"{task_id}.json"


def write_completion(config: SupervisorConfig, record: dict) -> None:
    path = completion_path(config, record["task_id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, indent=2), encoding="utf-8")
    temporary.replace(path)


def validation_marker_present(result: AgentResult, marker: str) -> bool:
    """Accept a final-result message, never a tool-call argument containing the marker."""
    if marker in result.final_message.splitlines() or marker in result.stdout.splitlines():
        return True
    event = parse_antigravity_stream(result.stdout)["final_result"]
    if isinstance(event, dict):
        for key in ("result", "text", "message", "content", "output"):
            value = event.get(key)
            if isinstance(value, str) and marker in value.splitlines():
                return True
    return False


def completion_record(config: SupervisorConfig, invocation: AgentInvocation,
                      report: Path, result: Optional[AgentResult] = None) -> dict:
    return {
        "schema_version": 1, "status": "PENDING", "task_id": invocation.task_id,
        "run_id": invocation.run_id, "result_run_id": result.run_id if result else invocation.run_id,
        "role": invocation.role.value, "action": invocation.action,
        "invocation": {**asdict(invocation), "role": invocation.role.value},
        "report_path": report.relative_to(config.repo_root).as_posix(),
        "report_sha256": compute_file_hash(report),
        "report_mtime_ns": report.stat().st_mtime_ns if report.is_file() else 0,
        "workflow_state_before": invocation.workflow_state_before,
        "workflow_state_after": "", "success": bool(result and result.success),
        "process_completed": bool(result and result.process_completed),
        "provider_reported_success": bool(result and result.provider_reported_success),
        "postconditions_valid": bool(result and result.postconditions_valid),
        "workflow_transition_valid": bool(result and result.workflow_transition_valid),
        "timed_out": bool(result and result.timed_out),
        "soft_permission_denial": bool(result and result.soft_permission_denial),
        "denied_actions": result.denied_actions if result else [],
        "exit_code": result.exit_code if result else None,
    }


def report_completion_valid(config: SupervisorConfig, task_id: str, report: Path,
                            candidate: Optional[dict] = None, *, pending: bool = False) -> bool:
    """Only the live verifier may supply a candidate; read-only routing needs VERIFIED evidence."""
    try:
        stored = json.loads(completion_path(config, task_id).read_text(encoding="utf-8"))
        record = candidate if candidate is not None else stored
        if pending:
            record = pending_completion(config, task_id, report)
            if not record:
                return False
        invocation = record["invocation"]
        if (record["schema_version"] != 1 or record["task_id"] != task_id
                or invocation["task_id"] != task_id or not record["run_id"]
                or record["run_id"] != record["result_run_id"]
                or invocation["run_id"] != record["run_id"]
                or record["role"] != invocation["role"] or record["role"] != "IMPLEMENTATION"
                or record["action"] != invocation["action"]
                or record["workflow_state_before"] != invocation["workflow_state_before"]
                or record["action"] not in ("IMPLEMENTATION", "FIX_REQUIRED_REMEDIATION")
                or record["report_path"] != report.relative_to(config.repo_root).as_posix()
                or not record["report_sha256"] or record["report_sha256"] != compute_file_hash(report)
                or record["report_mtime_ns"] != report.stat().st_mtime_ns
                or any(record.get(flag) is not True for flag in
                       ("success", "process_completed", "provider_reported_success"))
                or record.get("timed_out") is not False or record.get("soft_permission_denial") is not False
                or record.get("denied_actions") != [] or record.get("exit_code") != 0):
            return False
        if candidate is not None:
            return (stored["status"] == "PENDING" and stored["run_id"] == record["run_id"]
                    and stored["invocation"] == invocation)
        if record.get("completion_context") is not None and record["completion_context"] != completion_context(config, task_id):
            return False
        expected_after = ("FIX_AWAITING_TARGETED_VERIFICATION" if record["action"] == "FIX_REQUIRED_REMEDIATION"
                          else "IMPLEMENTED_AWAITING_REVIEW")
        return (record["status"] == ("VERIFICATION_PENDING" if pending else "VERIFIED") and record["workflow_state_after"] == expected_after
                and record.get("postconditions_valid") is True
                and record.get("workflow_transition_valid") is True
                and (record["action"] != "FIX_REQUIRED_REMEDIATION"
                     or record["workflow_state_before"] == "FIX_REQUIRED"))
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return False


def completion_context(config, task_id):
    """Bind continuation to product content, runtime target and workflow authority."""
    from tools.ks_supervisor.verification import VerificationEvidence
    git = get_git_state(config.repo_root)
    return {"content": VerificationEvidence(config, task_id).snapshot(
                {"command": "", "kind": "completion", "scopes": ["backend", "frontend"]}),
            "branch": git.branch, "head": git.head_sha,
            "authority": {p.relative_to(config.repo_root).as_posix(): compute_file_hash(p)
                          for directory in (config.tasks_dir, config.reviews_dir)
                          for p in directory.glob(f"{task_id}*.md")}}


def pending_completion(config, task_id, report):
    """Read pending proof; recover only the old invalidation-only classification.

    Compatibility reads never rewrite failed attestations or historical telemetry.
    """
    try:
        record = json.loads(completion_path(config, task_id).read_text(encoding="utf-8"))
        context = completion_context(config, task_id)
        if record["status"] == "VERIFICATION_PENDING":
            return record if record.get("completion_context") == context else None
        if record["status"] != "UNCOMMITTED":
            return None
        if not re.fullmatch(r"[A-Za-z0-9_-]+", record["run_id"]):
            return None
        from tools.ks_supervisor.verification import VerificationEvidence, bounded_check
        runtime = config.runtime_dir
        stop = json.loads((runtime / "stop_report.json").read_text(encoding="utf-8"))
        last = json.loads((runtime / "last_agent_run.json").read_text(encoding="utf-8"))
        session = json.loads((runtime / "session.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        review = config.reviews_dir / f"{task_id}-review.md"
        if (stop["state"] != "AGENT_RESULT_MISMATCH" or stop["task_id"] != task_id
                or stop["reason"] != "INVALIDATED_VERIFICATION_EVIDENCE: affected bounded checks require current-content verification"
                or record["action"] != "FIX_REQUIRED_REMEDIATION"
                or record["report_sha256"] != compute_file_hash(report)
                or record["report_mtime_ns"] != report.stat().st_mtime_ns
                or last["review_sha256_before"] != last["review_sha256_after"]
                or last["review_sha256_after"] != compute_file_hash(review)):
            return None
        for item in (last, session):
            if (any(item[k] != record["run_id"] for k in ("run_id", "result_run_id", "verifier_run_id"))
                    or item["invocation"] != record["invocation"] or item["task_id"] != task_id
                    or item["role"] != item["result_role"] or item["role"] != record["role"]
                    or item["provider"] != item["result_provider"] or item["provider"] != record["invocation"]["provider"]
                    or item["model"] != item["result_model"] or item["model"] != record["invocation"]["model"]
                    or item["effort"] != record["invocation"]["effort"]
                    or item["action"] != record["action"] or item["workflow_state_before"] != record["workflow_state_before"]
                    or item["workflow_state_after"] != "FIX_AWAITING_TARGETED_VERIFICATION"
                    or item["exit_code"] != 0 or item["timed_out"] or item["soft_permission_denial"]
                    or item["denied_actions"] or item.get("infrastructure_failure") or item.get("auth_or_quota_failure")
                    or not item["process_completed"] or not item["provider_reported_success"]
                    or not item["observable_repo_effect"]):
                return None
        delta = last["delta"]
        if delta["head_changed"] or delta["branch_changed"] or not delta["observable_effect"]:
            return None
        evidence = VerificationEvidence(config, task_id)
        plan = evidence.plan()
        changed = {p for p in delta["modified_files"] + delta["new_files"] + delta["deleted_files"]
                   if not p.startswith("docs/engineering/")}
        # A terminal check from this implementation must bind its changed content.
        covered = set()
        for item in evidence.data["checks"].values():
            if item.get("run_id") == record["run_id"] and item.get("outcome") == "PASS":
                check = bounded_check(item["check"]["command"])
                if check and evidence.snapshot(check) == item["snapshot"]:
                    covered.update(item["snapshot"]["files"])
        if not changed or not plan["required_verification"]:
            return None
        if not changed <= covered:
            # Older observers may not have captured terminal typecheck hashes.
            # Only an explicit supervisor repair binding may fill that gap;
            # prose, timestamps and successful exit flags are insufficient.
            binding_path = runtime / "completion_recovery" / f"{record['run_id']}.json"
            binding = json.loads(binding_path.read_text(encoding="utf-8"))
            if (binding.get("authorization") != "EXPLICIT_USER_INVALIDATION_ONLY_RECOVERY"
                    or binding.get("invocation") != record["invocation"]
                    or binding.get("completion_context") != context
                    or binding.get("report_sha256") != record["report_sha256"]
                    or binding.get("sources") != {name: compute_file_hash(runtime / name) for name in
                                                ("last_agent_run.json", "session.jsonl", "stop_report.json")}):
                return None
        if any(not set(i["invalidated_by"]) <= changed for i in plan["required_verification"]):
            return None
        if {i["check_id"] for i in plan["required_verification"]} != {
                i["check_id"] for i in stop["evidence"]["required_verification"]}:
            return None
        return {**record, "status": "VERIFICATION_PENDING", "success": True,
                "postconditions_valid": True, "workflow_transition_valid": True,
                "workflow_state_after": "FIX_AWAITING_TARGETED_VERIFICATION",
                "verification_expected_checks": [i["check_id"] for i in plan["required_verification"] + plan["reusable_verification"]],
                "completion_context": context, "legacy_invalidation_recovery": True}
    except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError):
        return None
