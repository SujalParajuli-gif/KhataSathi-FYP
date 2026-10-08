"""V3 deterministic tools. Codex owns the loop; this module never invokes Codex.

No run_step, task authoring, planning, review, closeout or commit lives here.
Runtime records describe facts and budgets, not acceptance authority.
"""
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
from uuid import uuid4

from tools.ks_supervisor.adapters.antigravity import AntigravityAdapter, extract_event_info, parse_antigravity_stream, provider_auth_quota_signal
from tools.ks_supervisor.adapters.codex import CodexAdapter
from tools.ks_supervisor.adapters.base import redact_secrets
from tools.ks_supervisor.lock import SupervisorLock
from tools.ks_supervisor.runtime_logs import SupervisorRuntimeLogs
from tools.ks_supervisor.bounded_turns import validate_slice, slice_prompt
from tools.ks_supervisor.report_provenance import (REPORT_REWRITE_REASON, report_overlay,
    report_violations, save_report_bytes, digest)
from tools.ks_supervisor.models import select_model_for_action
from tools.ks_supervisor.permissions import CommandPermissions
from tools.ks_supervisor.repo import (
    capture_repository_baseline, compute_file_hash, compute_repository_delta,
    parse_checkpoint, parse_report, parse_review, parse_task_contract, remediation_review_context, run_git, _read_porcelain_entries,
)
from tools.ks_supervisor.state import (
    derive_workflow_state, find_plan_file, find_report_file, find_review_file, find_task_file,
)
from tools.ks_supervisor.targeted import canonical_argv, run_check
from tools.ks_supervisor.types import ExecutionMode, Role, WorkflowState
from tools.ks_supervisor.verification import VerificationEvidence
from tools.ks_supervisor.mission_history import current_mission, retired_missions, transitions, append_transition, fingerprint


class DirectCodexVerificationRequired(ValueError):
    """Toolbox subset does not cover this check; Codex can assess direct execution."""


MISSION_DEFINITION = {"path": ".agents/skills/khatasathi-workflow-router/SKILL.md", "section": 9}
CHAT_ROLES = {"ks-start": "MISSION_CONTROLLER", "ks-plan": "PLANNER", "ks-impl": "IMPLEMENTATION",
              "ks-senior": "SENIOR_REVIEW", "ks-next": "CLOSEOUT_ADVANCE"}
RUNTIME_LOG_VIOLATIONS = ["Worker changed existing runtime authority: " + name
                        for name in ("current_agent_stderr.log", "current_agent_stream.jsonl")]
RUNTIME_LOG_GATE_REASON = "; ".join(RUNTIME_LOG_VIOLATIONS)
AUTH_FALSE_POSITIVE_PROOF = {"provider_status": "SUCCESS", "exit_code": 0, "stderr_empty": True, "auth_or_quota_signal": False}
AUTH_OUTPUT_GATE_REASON = "PROVIDER_QUOTA_OR_AUTH_REQUIRED: Antigravity CLI is unauthenticated"


def chat_entrypoint(config, token):
    """Resolve AGENTS20 conceptual tokens, never intercept IDE input or run roles.

    AGENTS.md instructs the current Codex session to call this helper for exact
    user tokens. Terminal forwards the same token, so both read one definition.
    """
    token = token.strip()
    if token not in CHAT_ROLES:
        raise ValueError("Not an exact repository chat shortcut")
    info = inspect_repository(config)
    result = {"token": token, "role": CHAT_ROLES[token], "session": "CURRENT_CODEX_SESSION",
              "dispatch_authority": "AGENTS.md section 20", "inspection": info,
              "launch_codex": False, "requires_powershell": False}
    if token == "ks-start":
        result["mission_definition"] = MISSION_DEFINITION.copy()
        result["next"] = "EXECUTE_SHARED_MISSION_IN_CURRENT_SESSION"
    if info["recommended_category"] == "HUMAN_INPUT_REQUIRED":
        result["next"] = "HUMAN_INPUT_REQUIRED"
        result["human_input"] = {"event": "[HUMAN INPUT REQUIRED]", "reason": info["reason"],
                                 "requested_decision": "Resolve only the reported decision/authorization/target gate",
                                 "evidence": {"task": info["active_task"], "state": info["derived_state"], "budget": info["budget"]},
                                 "safe_resume": "Reply in this chat with the specific approval/decision; retain mission/evidence and re-inspect before resuming"}
    elif token != "ks-start":
        if info["accepted"] and token != "ks-next":
            result["next"] = "ACCEPTED_TASK_IMMUTABLE"
        else:
            action = ""
            if token == "ks-impl" and info["unresolved_blockers"]:
                action = "FIX"
            elif token == "ks-senior" and info["unresolved_blockers"]:
                action = "TARGETED_VERIFICATION"
            elif token == "ks-next":
                if info["recommended_category"] in {"TASK_DEFINITION", "NEXT_TASK"}:
                    action = "TASK_DEFINITION"
                elif info["recommended_category"] == "CLOSEOUT":
                    action = "CLOSEOUT"
                else:
                    action = None
            if action is None:
                result["next"] = "USE_EXISTING_ROUTER_STATE_TRANSITION"
                result["router_definition"] = {"path": MISSION_DEFINITION["path"], "section": 4}
            else:
                result["role_instructions"] = role_instructions(config, token, info["active_task"] or "", action)
    return result


def _identity(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def _safe_path(config, path):
    if path is None:
        return None
    path = Path(path)
    if not path.resolve().is_relative_to(config.repo_root.resolve()) or path.is_symlink():
        raise ValueError("Artifact path escapes repository or is a symlink")
    return path


def _artifact(config, path, parser=None):
    path = _safe_path(config, path)
    if not path:
        return None
    parsed = parser(path) if parser else None
    result = {"path": path.relative_to(config.repo_root).as_posix(), "sha256": compute_file_hash(path)}
    if parsed:
        result.update({k: v for k, v in asdict(parsed).items() if k not in {"raw_content", "current_content"}})
    return result


def _packet_path(config, path):
    path = Path(path)
    if path.resolve().is_relative_to(config.runtime_dir.resolve()) and not path.is_symlink():
        return path
    return _safe_path(config, path)


def plan_state(config, task_id):
    path = _safe_path(config, find_plan_file(config.plans_dir, task_id))
    if not path:
        return {"state": "ABSENT", "path": None, "sha256": ""}
    # Physical final disposition, not a mention in a checklist or an old paragraph.
    text = path.read_text(encoding="utf-8")
    dispositions = re.findall(r"^\s*(?:\*\*)?Final plan disposition:\s*([^\n]+)", text, re.M | re.I)
    ready = bool(dispositions and dispositions[-1].split(".", 1)[0].strip("* \t").upper() == "IMPLEMENTATION-READY")
    return {**_artifact(config, path), "state": "IMPLEMENTATION_READY" if ready else "INCOMPLETE"}


def source_identity(config):
    """All tracked/visible source and tool inputs; secrets are hashed, never returned."""
    code, output, _ = run_git(config.repo_root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    if code:
        raise ValueError("Cannot fingerprint repository inputs")
    files = {}
    for name in sorted(set(output.split("\0")) - {""}):
        if name.lower().startswith(("docs/engineering/", ".agents/")) or name in {"AGENTS.md", "GEMINI.md"}:
            continue
        path = _safe_path(config, config.repo_root / name)
        if path.is_file():
            files[name] = compute_file_hash(path)
        else:
            files[name] = "<deleted>"
    for name in (".env", ".env.local", "backend/.env", "backend/.env.local", "frontend/.env", "frontend/.env.local"):
        path = _safe_path(config, config.repo_root / name)
        if path.is_file():
            files[name] = compute_file_hash(path)
    cp = parse_checkpoint(config.checkpoint_path)
    task_id = cp.current_task
    authority = {}
    if task_id and task_id.lower() not in {"none", "null"}:
        for kind, path in (("contract", find_task_file(config.tasks_dir, task_id)),
                           ("plan", find_plan_file(config.plans_dir, task_id)),
                           ("report", find_report_file(config.reports_dir, task_id))):
            authority[kind] = compute_file_hash(_safe_path(config, path)) if path else ""
    environment = {k: os.environ.get(k, "") for k in ("NODE_ENV", "CI", "PLAYWRIGHT_BASE_URL", "PORT", "DATABASE_URL")}
    return _identity({"files": files, "authority": authority, "repo_root": str(config.repo_root.resolve()),
                      "target_sha256": _identity(environment)})


class CycleLedger:
    """Append-only facts and finite budgets, shared across resumes. No action execution."""
    PHASES = {"worker", "planning", "verification", "review", "closeout", "task_definition", "reanchor", "remediation", "progress"}
    OUTCOMES = {"PASS", "FAIL", "FIX_REQUIRED", "APPROVED", "ACCEPTED", "SUCCESS", "NO_EFFECT",
                "INFRASTRUCTURE_FAILURE", "AUTH_QUOTA", "HUMAN_GATE", "REMEDIATED", "AUTH_CLASSIFIER_REMEDIATED", "REPORT_PROVENANCE_RECOVERED", "AWAITING_PROGRESS_INSPECTION", "PRODUCTIVE_CHECKPOINT", "BOUNDARY_READY"}

    def __init__(self, config, mission_id=None, legacy=False):
        self.config = config
        self.mission_id = None if legacy else mission_id or current_mission(config)
        if self.mission_id:
            _mission_path(config, self.mission_id)
        self.path = (config.runtime_dir / "v3" / "mission_cycles" / self.mission_id / "cycles.jsonl"
                     if self.mission_id else config.runtime_dir / "v3" / "cycles.jsonl")
        if self.mission_id and any(r["previous_mission"] == self.mission_id and r.get("legacy_recovery")
                                   for r in transitions(config)):
            self.path = config.runtime_dir / "v3/cycles.jsonl"

    def records(self):
        if not self.path.exists():
            return []
        try:
            records = [json.loads(line) for line in self.path.read_text(encoding="utf-8").splitlines()]
            for record in records:
                if (record["phase"] not in self.PHASES or record["outcome"] not in self.OUTCOMES
                        or not isinstance(record["blockers"], list) or not record["run_id"]
                        or not isinstance(record["task_id"], str) or not isinstance(record["reason"], str)
                        or not isinstance(record["failure_signature"], str)):
                    raise ValueError("Invalid cycle")
                if self.mission_id and "mission_cycles" in self.path.parts and record.get("mission_id") != self.mission_id:
                    raise ValueError("Cycle mission identity changed")
            return records
        except (ValueError, KeyError, TypeError):
            raise ValueError("Unreadable cycle authority; human recovery required")

    def budget(self, task_id):
        all_records = self.records()
        records = [r for r in all_records if r["task_id"] == task_id]
        if len(all_records) >= 60:
            return {"status": "HUMAN_INPUT_REQUIRED", "reason": "Finite 60-cycle budget exhausted; review history before explicit recovery",
                    "cycles_used": len(all_records), "cycle_limit": 60, "mission_id": self.mission_id}
        infra_signature, infra_count, no_effect = "", 0, 0
        stagnation, last_blockers = {}, {}
        stopped = ""
        gates = {}
        assessments = {}
        for assessment in records:
            if assessment["phase"] != "progress":
                continue
            original = next((r for r in records if r["phase"] == "worker" and r["run_id"] == assessment.get("worker_run_id")), None)
            if (not original or assessment.get("original_record_sha256") != _identity(original)
                    or assessment["outcome"] not in {"PRODUCTIVE_CHECKPOINT", "BOUNDARY_READY", "NO_EFFECT"}
                    or original["run_id"] in assessments or not assessment.get("mission_id")):
                raise ValueError("Invalid bound progress assessment authority")
            assessments[original["run_id"]] = assessment["outcome"]
        for record in records:
            outcome = record["outcome"]
            if outcome in {"AUTH_QUOTA", "HUMAN_GATE"}:
                gates[record["run_id"]] = record["reason"] or outcome
            if outcome == "REMEDIATED":
                original = next((r for r in records if r["run_id"] == record.get("resolved_run_id")
                                 and r["outcome"] == "HUMAN_GATE"), None)
                if (record["phase"] != "remediation" or not original
                        or record.get("original_record_sha256") != _identity(original)
                        or original["reason"] != RUNTIME_LOG_GATE_REASON
                        or not record.get("authorization") or not record.get("mission_id")):
                    raise ValueError("Invalid runtime-log remediation authority")
                gates.pop(original["run_id"], None)
            if outcome == "AUTH_CLASSIFIER_REMEDIATED":
                original = next((r for r in records if r["run_id"] == record.get("resolved_run_id") and r["outcome"] == "AUTH_QUOTA"), None)
                if (record["phase"] != "remediation" or not original or original["reason"] != AUTH_OUTPUT_GATE_REASON or record.get("original_record_sha256") != _identity(original)
                        or not record.get("authorization") or not record.get("mission_id")
                        or record.get("provider_evidence") != AUTH_FALSE_POSITIVE_PROOF):
                    raise ValueError("Invalid auth-output false-positive remediation authority")
                gates.pop(original["run_id"], None)
            if outcome == "REPORT_PROVENANCE_RECOVERED":
                validate_report_recovery(self.config, record, records)
                gates.pop(record["resolved_run_id"], None)
            effective = assessments.get(record["run_id"], outcome) if record["phase"] == "worker" and outcome not in {"AUTH_QUOTA", "HUMAN_GATE"} else outcome
            if effective == "INFRASTRUCTURE_FAILURE":
                signature = record["phase"] + ":" + record["failure_signature"]
                infra_count = infra_count + 1 if signature == infra_signature else 1
                infra_signature = signature
                if infra_count >= 3:
                    stopped = "Same infrastructure failure after two automatic retries"
            elif outcome in {"SUCCESS", "PASS"} and record["phase"] in {"worker", "verification"}:
                infra_signature, infra_count = "", 0
            if record["phase"] == "worker":
                no_effect = no_effect + 1 if effective == "NO_EFFECT" else 0
                if no_effect >= 2:
                    stopped = "Repeated no-effect worker; inspect missing scope/tool access"
            if record["phase"] in {"review", "verification"} and outcome in {"FAIL", "FIX_REQUIRED"}:
                current = set(record["blockers"])
                phase = record["phase"]
                if phase in last_blockers:
                    stagnation[phase] = 0 if current < last_blockers[phase] else stagnation.get(phase, 0) + 1
                last_blockers[phase] = current
                if stagnation.get(phase, 0) >= 3:
                    stopped = "Three correction cycles without strict remaining-blocker reduction"
        stopped = stopped or next(iter(gates.values()), "")
        return {"status": "HUMAN_INPUT_REQUIRED" if stopped else "CONTINUE", "reason": stopped,
                "infrastructure_failures": infra_count, "no_effect_returns": no_effect,
                "stagnant_corrections": max(stagnation.values(), default=0), "cycles_used": len(all_records), "cycle_limit": 60,
                "mission_id": self.mission_id}

    def append(self, task_id, phase, outcome, blockers=(), reason="", failure_signature="", run_id="", **metadata):
        if self.mission_id:
            if self.mission_id in retired_missions(self.config) or _read_mission(self.config, self.mission_id)["status"] != "ACTIVE":
                raise ValueError("Historical mission ledger is sealed")
            if metadata.get("mission_id") not in {None, self.mission_id}:
                raise ValueError("Cycle belongs to a different mission")
            metadata["mission_id"] = self.mission_id
        elif transitions(self.config):
            raise ValueError("Legacy mission ledger is sealed")
        if phase not in self.PHASES or outcome not in self.OUTCOMES:
            raise ValueError("Unsupported cycle phase/outcome")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", task_id or "NO_ACTIVE_TASK"):
            raise ValueError("Invalid cycle task")
        if not all(isinstance(b, str) and b for b in blockers):
            raise ValueError("Blockers must be stable nonempty identifiers")
        if phase == "progress":
            original = next((r for r in self.records() if r["run_id"] == metadata.get("worker_run_id")
                             and r["task_id"] == task_id and r["phase"] == "worker"), None)
            if (not original or metadata.get("original_record_sha256") != _identity(original)
                    or not metadata.get("mission_id") or outcome not in {"PRODUCTIVE_CHECKPOINT", "BOUNDARY_READY", "NO_EFFECT"}
                    or any(r.get("worker_run_id") == original["run_id"] for r in self.records())):
                raise ValueError("Progress must bind an unassessed original worker record")
        if outcome == "REMEDIATED":
            original = next((r for r in self.records() if r["run_id"] == metadata.get("resolved_run_id")
                             and r["task_id"] == task_id and r["outcome"] == "HUMAN_GATE"), None)
            if (phase != "remediation" or not original or original["reason"] != RUNTIME_LOG_GATE_REASON
                    or metadata.get("original_record_sha256") != _identity(original)
                    or not metadata.get("authorization") or not metadata.get("mission_id")):
                raise ValueError("Remediation must bind the exact authorized runtime-log gate")
        if outcome == "AUTH_CLASSIFIER_REMEDIATED":
            original = next((r for r in self.records() if r["run_id"] == metadata.get("resolved_run_id") and r["task_id"] == task_id and r["outcome"] == "AUTH_QUOTA"), None)
            if (phase != "remediation" or not original or original["reason"] != AUTH_OUTPUT_GATE_REASON or metadata.get("original_record_sha256") != _identity(original)
                    or not metadata.get("authorization") or not metadata.get("mission_id")
                    or metadata.get("provider_evidence") != AUTH_FALSE_POSITIVE_PROOF
                    or any(r.get("resolved_run_id") == original["run_id"] for r in self.records())):
                raise ValueError("Auth remediation must bind the exact authorized false-positive gate")
        record = {"task_id": task_id, "phase": phase, "outcome": outcome, "blockers": list(blockers),
                  "reason": redact_secrets(reason), "failure_signature": failure_signature or _identity(reason),
                  "run_id": run_id or uuid4().hex, "recorded_at": datetime.now(timezone.utc).isoformat(), **metadata}
        if outcome == "REPORT_PROVENANCE_RECOVERED":
            validate_report_recovery(self.config, record, self.records())
        self.records()  # Fail closed on corrupt history; never discard it.
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, sort_keys=True) + "\n")
        return {"record": record, "budget": self.budget(task_id)}


def inspect_repository(config):
    state = derive_workflow_state(config)
    task, git, cp = state.task_contract, state.git_state, state.checkpoint
    task_id = state.active_task_id
    plan = plan_state(config, task_id) if task_id else {"state": "NOT_REQUIRED"}
    report_path = find_report_file(config.reports_dir, task_id) if task_id else None
    review_path = find_review_file(config.reviews_dir, task_id) if task_id else None
    report = _artifact(config, report_path, parse_report)
    review = _artifact(config, review_path, parse_review)
    ledger = CycleLedger(config)
    budget = ledger.budget(task_id)
    identity = source_identity(config)
    accepted = bool(task and (task.status.upper() == "ACCEPTED" or cp.current_task_status.upper() == "ACCEPTED"))
    category = {
        WorkflowState.NO_ACTIVE_TASK: "TASK_DEFINITION",
        WorkflowState.READY_FOR_PLANNING: "PLAN",
        WorkflowState.PLAN_READY_FOR_IMPLEMENTATION: "GEMINI_IMPLEMENT",
        WorkflowState.DIRECT_IMPLEMENTATION: "GEMINI_IMPLEMENT",
        WorkflowState.IMPLEMENTATION_IN_PROGRESS: "GEMINI_CONTINUE",
        WorkflowState.FIX_REQUIRED: "GEMINI_FIX",
        WorkflowState.FIX_AWAITING_TARGETED_VERIFICATION: "CODEX_VERIFY",
        WorkflowState.IMPLEMENTED_AWAITING_REVIEW: "CODEX_VERIFY",
        WorkflowState.APPROVED_AWAITING_CLOSEOUT: "CLOSEOUT",
        WorkflowState.ACCEPTED_WITH_COMMIT_WORTHY_CHANGES: "ACCEPTED_HYGIENE",
        WorkflowState.ACCEPTED_NO_COMMIT_WORTHY_CHANGES: "NEXT_TASK",
    }.get(state.state, "HUMAN_INPUT_REQUIRED")
    if state.is_hard_stop or budget["status"] == "HUMAN_INPUT_REQUIRED":
        category = "HUMAN_INPUT_REQUIRED"
    elif not accepted and task and (task.planning_required or task.risk.upper() == "HIGH" or task.execution_mode == ExecutionMode.PLANNED_IMPLEMENTATION) and plan["state"] != "IMPLEMENTATION_READY":
        category = "PLAN"
    elif not accepted and category != "CLOSEOUT":
        # Worker returns require Codex inspection/verification. A record cannot waive
        # canonical Senior review: it recommends a role, never approves anything.
        records = [r for r in ledger.records() if r["task_id"] == task_id]
        relevant = [r for r in records if r["phase"] in {"worker", "verification", "review", "progress"}]
        latest = relevant[-1] if relevant else None
        review_identity = (review or {}).get("sha256")
        if latest and latest["phase"] == "worker" and latest["outcome"] == "AWAITING_PROGRESS_INSPECTION":
            category = "CODEX_INSPECT_CHECKPOINT"  # External edits cannot waive inspection.
        elif (latest and latest["phase"] == "worker" and latest["outcome"] == "HUMAN_GATE"
              and any(r["outcome"] == "REPORT_PROVENANCE_RECOVERED"
                      and r.get("resolved_run_id") == latest["run_id"] for r in records)):
            category = "CODEX_INSPECT_CHECKPOINT"  # Recovery is not source acceptance.
        elif latest and latest.get("content_identity") == identity and latest.get("senior_review_sha256") == review_identity:
            if latest["phase"] == "worker" and latest["outcome"] == "SUCCESS":
                category = "CODEX_VERIFY"
            elif latest["phase"] == "progress":
                category = "CODEX_VERIFY" if latest["outcome"] == "BOUNDARY_READY" else "GEMINI_CONTINUE"
            elif latest["phase"] == "verification":
                category = ("CODEX_REVIEW" if latest["outcome"] == "PASS" else
                            "CODEX_RECOVER_INFRASTRUCTURE" if latest["outcome"] == "INFRASTRUCTURE_FAILURE" else "GEMINI_FIX")
            elif latest["phase"] == "review" and latest["outcome"] == "FIX_REQUIRED":
                category = "GEMINI_FIX"
        elif latest and latest["phase"] == "verification" and latest.get("senior_review_sha256") == review_identity:
            category = "CODEX_VERIFY"  # Newly changed content invalidates that pass.
    if not accepted and category == "CLOSEOUT":
        reviews = [r for r in ledger.records() if r["task_id"] == task_id and r["phase"] == "review"]
        if reviews and (reviews[-1].get("content_identity") != identity
                        or reviews[-1].get("senior_review_sha256") != (review or {}).get("sha256")):
            category = "CODEX_VERIFY"  # V3 approval never survives a changed reviewed input.
    branch_ok = bool(task and task.branch_worktree and git.branch == re.split(r";|\s+/\s+", task.branch_worktree)[0].strip(" `")
                     and git.branch not in {"main", "master", "UI/UX-fixes-after-production"})
    return {"schema_version": 3, "workflow_version": cp.workflow_version_effective,
            "branch": git.branch, "head": git.head_sha,
            "dirty_paths": sorted({name for _, name in _read_porcelain_entries(config.repo_root, untracked_mode="all")}),
            "staged_paths": git.staged_files, "active_task": task_id or None,
            "task_status": task.status if task else None, "checkpoint_task_status": cp.current_task_status,
            "phase": cp.current_phase, "risk": task.risk if task else None,
            "difficulty": task.difficulty if task else None, "planning_required": bool(task and task.planning_required),
            "plan": plan, "implementation_report": report, "senior_review": review,
            "unresolved_blockers": review["blockers"] if review else [], "accepted": accepted,
            "derived_state": state.state.value, "recommended_category": category,
            "reason": budget["reason"] or state.stop_reason or state.reason,
            "content_identity": identity, "budget": budget,
            "allowed_operations": {"inspect": True, "delegate_gemini": branch_ok and category in {"GEMINI_IMPLEMENT", "GEMINI_CONTINUE", "GEMINI_FIX"},
                                   "verify_source": bool(task and not accepted and category != "HUMAN_INPUT_REQUIRED"),
                                   "codex_logical_roles": category != "HUMAN_INPUT_REQUIRED"},
            "gated_operations": ["migration execution", "connected fixtures/configured DB writes", "production/deploy/external providers", "destructive operations", "push/merge"],
            "commit_policy": "Codex must apply existing accepted-scope/branch/index/hygiene gates and current user restrictions; toolbox never commits",
            "verification": VerificationEvidence(config, task_id).plan(SourcePermissions()) if task_id else None}


def _active(config, task_id):
    info = inspect_repository(config)
    if info["active_task"] != task_id or info["accepted"]:
        raise ValueError("Task mismatch or permanently accepted task; cannot reopen")
    if info["recommended_category"] == "HUMAN_INPUT_REQUIRED":
        raise ValueError("HUMAN_INPUT_REQUIRED: " + info["reason"])
    return info


def worker_prompt(config, task_id, mode, info, correction="", current_diff_path=""):
    contract = find_task_file(config.tasks_dir, task_id)
    prompt = AntigravityAdapter(config).build_prompt(
        Role.IMPLEMENTATION, task_id, is_fix=mode == "fix", task=parse_task_contract(contract),
        canonical_paths={"task": contract.relative_to(config.repo_root).as_posix(),
                         "plan": info["plan"].get("path"),
                         "report": (info["implementation_report"] or {}).get("path", f"docs/engineering/ai/reports/{task_id}-implementation.md"),
                         "review": (info["senior_review"] or {}).get("path", f"docs/engineering/ai/reviews/{task_id}-review.md")},
        review_blockers=correction, workspace_only=True)
    return prompt + "\nMission context:\n" + json.dumps({"contract": str(contract.relative_to(config.repo_root)), "plan": info["plan"],
                      "report": info["implementation_report"], "review": info["senior_review"],
                      "branch": info["branch"], "head": info["head"], "dirty_paths": info["dirty_paths"],
                      "current_diff_path": current_diff_path,
                      "diff_instructions": "Read the captured current tracked diff with workspace file tools; inspect new/untracked files from dirty_paths directly. Never run Git."}, sort_keys=True)


def _protected(config, task_id):
    """Protect all authority; the active implementation report alone is writable."""
    paths = [config.repo_root / "AGENTS.md", config.repo_root / "GEMINI.md"]
    paths += [p for p in (config.repo_root / "docs/engineering").rglob("*") if p.is_file()]
    paths += [p for p in (config.repo_root / ".agents").rglob("*") if p.is_file()]
    report = find_report_file(config.reports_dir, task_id)
    return {str(p.relative_to(config.repo_root)): compute_file_hash(_safe_path(config, p)) for p in paths if p != report}


def delegate_gemini(config, task_id, mode="implement", correction_path=None, mission_id=None, continuation_path=None):
    if mode not in {"implement", "fix"}:
        raise ValueError("Unknown worker mode")
    with SupervisorLock(config, task_id=task_id, role="V3_GEMINI_WORKER") as lock:
        if mission_id:
            mission_guard(config, mission_id, task_id)
        info = _active(config, task_id)
        if not info["allowed_operations"]["delegate_gemini"]:
            raise ValueError("Worker not allowed by current branch/plan/category")
        if mode == "implement" and info["recommended_category"] == "GEMINI_FIX":
            raise ValueError("Latest blockers require fix mode, not implementation restart")
        continuation = None
        if continuation_path:
            continuation = validate_slice(json.loads(_packet_path(config, continuation_path).read_text(encoding="utf-8")),
                                          task_id, mission_id, info["content_identity"], info["plan"].get("sha256"))
        previous = [r for r in CycleLedger(config).records() if r["task_id"] == task_id and r["phase"] == "progress"]
        if previous and not continuation:
            raise ValueError("Productive/no-progress continuation requires a narrowed slice, never a broad retry")
        correction = ""
        if mode == "fix":
            review_path = find_review_file(config.reviews_dir, task_id)
            if review_path:
                review = parse_review(review_path)
                if review and review.decision == "FIX_REQUIRED":
                    correction = remediation_review_context(review_path, find_report_file(config.reports_dir, task_id) or config.reports_dir / f"{task_id}-implementation.md")
            if correction_path:
                packet = json.loads(_safe_path(config, correction_path).read_text(encoding="utf-8"))
                failures = packet.get("failures")
                precise = isinstance(failures, list) and bool(failures) and all(
                    isinstance(f, dict) and isinstance(f.get("id"), str) and f["id"]
                    and isinstance(f.get("diagnostic"), str) and f["diagnostic"]
                    and isinstance(f.get("correction", f.get("expected")), str) and f.get("correction", f.get("expected"))
                    for f in failures)
                if packet.get("task_id") != task_id or packet.get("content_identity") != info["content_identity"] or not precise:
                    raise ValueError("Correction packet must identify current task/content and precise failures")
                correction += "\nCodex source-verification corrections:\n" + json.dumps(packet)
            if not correction.strip():
                raise ValueError("Fix requires current Senior blockers or content-bound correction packet")
        run_id = uuid4().hex
        directory = config.runtime_dir / "v3" / "workers" / run_id
        directory.mkdir(parents=True, exist_ok=False)
        code, diff, _ = run_git(config.repo_root, "diff", "--no-ext-diff", "HEAD", "--")
        if code:
            raise ValueError("Cannot capture current Git diff for worker continuation")
        diff_path = directory / "current-diff.patch"
        diff_path.write_text(redact_secrets(diff), encoding="utf-8")
        prompt = worker_prompt(config, task_id, mode, info, correction, str(diff_path))
        report_path = find_report_file(config.reports_dir, task_id) or config.reports_dir / f"{task_id}-implementation.md"
        report_existed = report_path.exists()
        report_before = report_path.read_bytes() if report_existed else b""
        report_evidence = {"prior": save_report_bytes(directory, "report-prior.bin", report_before), "prior_exists": report_existed}
        if continuation:
            prompt += slice_prompt(continuation, report_path.relative_to(config.repo_root).as_posix())
        if mission_id:
            prompt += report_overlay(run_id)
        before = capture_repository_baseline(config, task_id, info["derived_state"])
        protected = _protected(config, task_id)
        # Snapshot clean tracked files too: detecting only dirty paths misses reset-to-HEAD edits.
        _, tracked, _ = run_git(config.repo_root, "ls-files", "-z")
        tracked_before = {n: compute_file_hash(_safe_path(config, config.repo_root / n)) for n in tracked.split("\0") if n}
        _, index_before, _ = run_git(config.repo_root, "diff", "--cached", "--binary")
        profile = select_model_for_action(WorkflowState.FIX_REQUIRED if mode == "fix" else WorkflowState.IMPLEMENTATION_IN_PROGRESS,
                                         Role.IMPLEMENTATION, derive_workflow_state(config).task_contract, config=config).profile
        launch = {"run_id": run_id, "task_id": task_id, "mode": mode, "model": profile.model,
                  "effort": profile.effort, "content_identity": info["content_identity"], "prompt_sha256": _identity(prompt)}
        if continuation:
            launch["continuation"] = continuation
        (directory / "launch.json").write_text(json.dumps(launch, indent=2), encoding="utf-8")
        # Existing runtime proof is also authority. The worker cannot rewrite a
        # previous ledger/plan/result to turn a missing check into a reusable pass.
        runtime_before = {p: compute_file_hash(p) for p in config.runtime_dir.rglob("*")
                          if p.is_file() and p.name not in {"supervisor.lock", "supervisor.lock.json"}}
        forbidden_tools = []
        runtime_logs = SupervisorRuntimeLogs(config, run_id)
        def observe(event):
            lock.update_heartbeat()
            tool = extract_event_info(event).get("tool_name") or ""
            if tool.lower().replace("_", "") in {"runcommand", "shell", "terminal", "executecommand"}:
                forbidden_tools.append(tool)
        try:
            result = AntigravityAdapter(config).invoke(Role.IMPLEMENTATION, task_id, prompt=prompt, profile=profile,
                     hard_timeout=config.get_agent_hard_timeout(info["risk"]), run_id=run_id, action="V3_WORKER_" + mode.upper(), verification_observer=observe,
                     runtime_logs=runtime_logs)
            result_info = {k: asdict(result)[k] for k in ("success", "process_started", "process_completed", "auth_or_quota_failure",
                           "soft_permission_denial", "infrastructure_failure", "error_message", "session_id", "token_usage", "exit_code", "duration_seconds", "timed_out", "timeout_kind")}
            result_info = json.loads(redact_secrets(json.dumps(result_info)))
        except (OSError, RuntimeError) as exc:
            result = None
            result_info = {"success": False, "error_message": type(exc).__name__, "infrastructure_failure": "AGENT_LAUNCH_FAILED"}
        after = capture_repository_baseline(config, task_id, info["derived_state"])
        delta = compute_repository_delta(before, after, config.repo_root)
        changed = sorted(set(delta.new_files + delta.modified_files + delta.deleted_files +
                             [n for n, digest in tracked_before.items() if compute_file_hash(config.repo_root / n) != digest]))
        _, index_after, _ = run_git(config.repo_root, "diff", "--cached", "--binary")
        violations = []
        if continuation:
            allowed = set(continuation["files"]) | {report_path.relative_to(config.repo_root).as_posix()}
            for name in changed:
                if name.replace("\\", "/") not in allowed:
                    violations.append("Worker changed outside bounded slice: " + name)
        report_candidate = report_path.read_bytes() if report_path.exists() else None
        violations.extend(report_violations(report_before, report_candidate, run_id if mission_id else None, report_existed))
        violations.extend(runtime_logs.violations())
        if delta.head_changed or delta.branch_changed or index_before != index_after:
            violations.append("Worker changed HEAD, branch or index")
        for name, digest in protected.items():
            if compute_file_hash(config.repo_root / name) != digest:
                violations.append("Worker changed protected authority: " + name)
        for name in set(_protected(config, task_id)) - set(protected):
            violations.append("Worker created protected authority: " + name)
        for path, digest in runtime_before.items():
            if compute_file_hash(path) != digest:
                violations.append("Worker changed existing runtime authority: " + path.relative_to(config.runtime_dir).as_posix())
        if forbidden_tools:
            violations.append("Worker attempted forbidden shell tool: " + ", ".join(sorted(set(forbidden_tools))))
        if result and (result.task_id != task_id or result.run_id != run_id or result.role != Role.IMPLEMENTATION
                       or result.provider != "antigravity" or result.model_name != profile.model or result.effort != profile.effort):
            violations.append("Worker result invocation identity mismatch")
        if result and result.success and (not result.process_started or not result.process_completed or result.exit_code != 0 or result.timed_out):
            violations.append("Worker success claim has inconsistent execution lifecycle")
        if report_candidate is not None:
            report_evidence["candidate"] = save_report_bytes(directory, "report-candidate.bin", report_candidate)
        report_evidence["violations"] = report_violations(report_before, report_candidate, run_id if mission_id else None, report_existed)
        if result_info.get("auth_or_quota_failure"):
            outcome = "AUTH_QUOTA"
        elif violations or result_info.get("soft_permission_denial"):
            outcome = "HUMAN_GATE"
        elif (continuation or result_info.get("timed_out")) and (result_info["success"] or result_info.get("timed_out")):
            outcome = ("AWAITING_PROGRESS_INSPECTION" if any(p.startswith(("backend/", "frontend/")) for p in changed) else "NO_EFFECT")
        elif not result_info["success"]:
            outcome = "INFRASTRUCTURE_FAILURE"
        elif not any(not p.lower().startswith(("docs/engineering/", ".agents/")) for p in changed):
            # Report claims alone must not create an endless apparent-progress loop.
            outcome = "NO_EFFECT"
        else:
            outcome = "SUCCESS"
        reason = "; ".join(violations) or result_info.get("error_message") or outcome
        recovered_auth = [r["resolved_run_id"] for r in CycleLedger(config).records()
                          if r["task_id"] == task_id and r["outcome"] == "AUTH_CLASSIFIER_REMEDIATED"]
        cycle = CycleLedger(config).append(task_id, "worker", outcome, reason=reason, run_id=run_id,
                  failure_signature=_identity({k: result_info.get(k) for k in ("infrastructure_failure", "exit_code", "timed_out", "timeout_kind")}),
                  content_identity=source_identity(config), mode=mode, changed_paths=changed,
                  report_updated=any(a.startswith("report:") for a in delta.changed_workflow_artifacts),
                  runtime_location=str(directory), senior_review_sha256=(info["senior_review"] or {}).get("sha256"),
                  mission_id=mission_id, bounded_slice=continuation, report_provenance=report_evidence,
                  provider_recovery=({"event": "PROVIDER_RESUME_CONFIRMED", "recovered_gate_runs": recovered_auth}
                                     if result_info.get("success") and recovered_auth else None),
                  senior_review_length=(find_review_file(config.reviews_dir, task_id).stat().st_size
                                        if info["senior_review"] else 0))
        output = {**launch, "result": result_info, "changed_paths": changed,
                  "workflow_effects": delta.changed_workflow_artifacts, "violations": violations,
                  "outcome": outcome, "cycle": cycle, "verification_owner": "Codex Senior",
                  "next": "HUMAN_INPUT_REQUIRED" if cycle["budget"]["status"] == "HUMAN_INPUT_REQUIRED" else "RETURN_TO_CODEX"}
        (directory / "return.json").write_text(json.dumps(output, indent=2), encoding="utf-8")
        return output


class SourcePermissions:
    """Reuse the narrow fallback policy as a ceiling, without provider shell grants."""
    def __init__(self):
        path = Path(__file__).with_name("source_verification_permissions.json")
        self.rules = json.loads(path.read_text(encoding="utf-8"))
        self.digest = compute_file_hash(path)

    def authorized(self, command):
        if any(rule in self.rules.get("allow", []) for rule in ("command(*)", "unsandboxed(*)")):
            return False, "Broad grants are forbidden"
        for rule in self.rules.get("deny", []) + self.rules.get("ask", []):
            if CommandPermissions.matches(rule, command):
                return False, "Source policy denies command"
        allowed = any(CommandPermissions.matches(rule, command) for rule in self.rules.get("allow", []))
        return allowed, "Narrow source policy" if allowed else "Not in narrow source policy"

    def metadata(self):
        return {"owner": "Codex Senior", "source_policy_sha256": self.digest}


def verify_source(config, task_id, commands, content_identity, source_reviewed=False, mission_id=None):
    if not source_reviewed or not commands:
        raise ValueError("Codex must review source-only checks and select explicit commands; empty checks cannot certify acceptance")
    with SupervisorLock(config, task_id=task_id, role="V3_CODEX_VERIFICATION") as lock:
        if mission_id:
            mission_guard(config, mission_id, task_id)
        info = _active(config, task_id)
        if info["content_identity"] != content_identity:
            raise ValueError("Content changed after Codex selected verification commands")
        policy, selected = SourcePermissions(), []
        # Preflight entire batch before any executable runs.
        for command in commands:
            operational = bool(re.search(r"migrat|mysql|fixture|connected|\b(?:ssh|deploy|push|reset|clean|dev)\b", command, re.I))
            try:
                check, _ = canonical_argv(command)
            except ValueError:
                if operational:
                    raise ValueError("HUMAN_INPUT_REQUIRED: Operational/destructive/target check is outside source-only authority")
                raise DirectCodexVerificationRequired("Unsupported source helper check; Codex must inspect existing authority and perform/record a direct check if safe")
            allowed, reason = policy.authorized(check["command"])
            if not allowed:
                if operational:
                    raise ValueError("HUMAN_INPUT_REQUIRED: " + reason)
                raise DirectCodexVerificationRequired(reason + "; Codex retains direct verification ownership")
            selected.append({"command": check["command"], "check_id": _identity(check["command"])[:16]})
        evidence = VerificationEvidence(config, task_id)
        run_id, records = uuid4().hex, []
        plan = evidence.plan(policy)
        evidence.freeze(run_id, plan, provider="codex-senior")
        reusable = {item["command"]: item for item in plan["reusable_verification"]}
        for item in selected:
            if item["command"] in reusable:
                records.append({"command": item["command"], "outcome": "PASS", "reused": True,
                                "evidence": reusable[item["command"]]})
            else:
                records.append(run_check(config, evidence, item, run_id, config.agent_timeout_seconds, lock.update_heartbeat))
        unavailable = any(r["outcome"] == "UNAVAILABLE" for r in records)
        failed = [r["check_id"] for r in records if r["outcome"] != "PASS"]
        outcome = "INFRASTRUCTURE_FAILURE" if unavailable else "FAIL" if failed else "PASS"
        cycle = CycleLedger(config).append(task_id, "verification", outcome, blockers=failed, run_id=run_id,
                  failure_signature=_identity([(r.get("check_id"), r.get("error")) for r in records if r["outcome"] == "UNAVAILABLE"]),
                  reason="Source checks " + outcome, content_identity=source_identity(config),
                  selected_commands=[i["command"] for i in selected], senior_review_sha256=(info["senior_review"] or {}).get("sha256"))
        return {"task_id": task_id, "run_id": run_id, "outcome": outcome, "checks": records,
                "cycle": cycle, "acceptance_certified": False,
                "next": "RETURN_TO_CODEX", "limits": "Selected source checks only; no startup/configured-schema/connected fixture certification"}


def record_cycle(config, task_id, phase, outcome, blockers=(), reason="", failure_signature="", mission_id=None):
    if phase in {"remediation", "progress"} or outcome in {"REMEDIATED", "AUTH_CLASSIFIER_REMEDIATED", "REPORT_PROVENANCE_RECOVERED", "PRODUCTIVE_CHECKPOINT", "BOUNDARY_READY", "AWAITING_PROGRESS_INSPECTION"}:
        raise ValueError("Use explicit bound remediation or worker-checkpoint assessment")
    with SupervisorLock(config, task_id=task_id or "NO_ACTIVE_TASK", role="V3_CYCLE_RECORD"):
        if mission_id:
            mission_guard(config, mission_id, task_id)
        state = inspect_repository(config)
        if state["active_task"] != (task_id or None):
            raise ValueError("Cycle task does not match active authority")
        if phase == "review":
            review = state["senior_review"]
            if outcome in {"APPROVED", "FIX_REQUIRED"} and (not review or review["decision"] != outcome or set(blockers) != set(review["blockers"])):
                raise ValueError("Review cycle must match physical canonical latest Senior decision/blockers")
            if outcome == "APPROVED" and not (state["implementation_report"] or {}).get("is_complete"):
                raise ValueError("Approval requires a physical complete implementation report")
            if review:
                path = _safe_path(config, config.repo_root / review["path"])
                current = path.read_bytes()
                history = [r for r in CycleLedger(config).records() if r["task_id"] == task_id
                           and r.get("senior_review_sha256") and r.get("senior_review_length")]
                if history:
                    previous = history[-1]
                    length = previous["senior_review_length"]
                    if len(current) < length or hashlib.sha256(current[:length]).hexdigest() != previous["senior_review_sha256"]:
                        raise ValueError("Senior review authority must be append-only; prior recorded content was rewritten")
        if outcome == "ACCEPTED" and not state["accepted"]:
            raise ValueError("Acceptance cycle requires physical accepted task authority")
        return CycleLedger(config).append(task_id, phase, outcome, blockers, reason, failure_signature,
                                          content_identity=state["content_identity"],
                                          senior_review_sha256=(state["senior_review"] or {}).get("sha256"),
                                          senior_review_length=(find_review_file(config.reviews_dir, task_id).stat().st_size
                                                                if state["senior_review"] else 0))


def _mission_path(config, mission_id):
    if not re.fullmatch(r"[0-9a-f]{32}", mission_id):
        raise ValueError("Invalid mission identity")
    return config.runtime_dir / "v3" / "missions" / f"{mission_id}.json"


def record_worker_checkpoint(config, task_id, mission_id, worker_run_id, assessment):
    """Record Codex's structural inspection, never provider/task acceptance.

    Historical productive timeouts may be assessed append-only. Genuine gates
    remain sticky and cannot be reclassified by this surface.
    """
    with SupervisorLock(config, task_id=task_id, role="V3_PROGRESS_INSPECTION"):
        mission = _read_mission(config, mission_id)
        info = inspect_repository(config)
        if (mission["status"] != "ACTIVE" or mission["task_id"] != task_id or info["active_task"] != task_id
                or info["accepted"] or mission["branch"] != info["branch"] or mission["initial_head"] != info["head"]):
            raise ValueError("Checkpoint must preserve the bound active task/mission/branch/HEAD")
        ledger = CycleLedger(config)
        records = ledger.records()
        original = next((r for r in records if r["task_id"] == task_id and r["phase"] == "worker" and r["run_id"] == worker_run_id), None)
        if not original or any(r.get("worker_run_id") == worker_run_id for r in records):
            raise ValueError("Checkpoint requires an unassessed recorded worker turn")
        if not re.fullmatch(r"[0-9a-f]{32}", worker_run_id):
            raise ValueError("Invalid worker run ID")
        result_path = config.runtime_dir / "v3/workers" / worker_run_id / "return.json"
        output = json.loads(result_path.read_text(encoding="utf-8"))
        result = output["result"]
        remediated = any(r["outcome"] in {"REMEDIATED", "AUTH_CLASSIFIER_REMEDIATED", "REPORT_PROVENANCE_RECOVERED"} and r.get("resolved_run_id") == worker_run_id
                         and r.get("original_record_sha256") == _identity(original) for r in records)
        auth_remediated = any(r["outcome"] == "AUTH_CLASSIFIER_REMEDIATED" and r.get("resolved_run_id") == worker_run_id for r in records)
        report_remediated = any(r["outcome"] == "REPORT_PROVENANCE_RECOVERED" and r.get("resolved_run_id") == worker_run_id for r in records)
        if (output["run_id"] != worker_run_id or output["task_id"] != task_id
                or output["outcome"] != original["outcome"] or output["cycle"]["record"] != original
                or (result.get("auth_or_quota_failure") and not auth_remediated) or result.get("soft_permission_denial")
                or (output["violations"] and not (remediated and (output["violations"] == RUNTIME_LOG_VIOLATIONS
                    or report_remediated and output["violations"] == [REPORT_REWRITE_REASON])))
                or (original["outcome"] == "AUTH_QUOTA" and not auth_remediated)
                or (original["outcome"] == "HUMAN_GATE" and not remediated)
                or not (result.get("success") or result.get("timed_out") or auth_remediated)):
            raise ValueError("Genuine auth/provenance/infrastructure gate cannot become productive progress")
        if (assessment.get("task_id") != task_id or assessment.get("mission_id") != mission_id
                or assessment.get("content_identity") != info["content_identity"]
                or assessment.get("plan_sha256") != info["plan"].get("sha256")
                or info["plan"]["state"] != "IMPLEMENTATION_READY"
                or not isinstance(assessment.get("meaningful_progress"), bool)
                or not isinstance(assessment.get("verification_boundary"), bool)
                or not isinstance(assessment.get("inspection"), str) or not assessment["inspection"].strip()):
            raise ValueError("Codex assessment must bind current source/ready plan and explain actual inspection")
        for key in ("progressed_plan_steps", "acceptance_criteria", "remaining_slices"):
            values = assessment.get(key)
            if not isinstance(values, list) or not all(isinstance(v, str) and v.strip() for v in values):
                raise ValueError("Checkpoint requires " + key)
        changed = original.get("changed_paths", [])
        product = [p for p in changed if p.startswith(("backend/", "frontend/"))]
        meaningful = assessment["meaningful_progress"]
        if meaningful and (not product or not assessment["progressed_plan_steps"] or not assessment["acceptance_criteria"]):
            raise ValueError("Report/provider claims alone cannot establish meaningful product progress")
        if assessment["verification_boundary"] and not meaningful:
            raise ValueError("No-progress cannot certify a verification boundary")
        if not assessment["verification_boundary"] and not assessment["remaining_slices"]:
            raise ValueError("Continuation requires concrete remaining slices")
        hashes = {name: compute_file_hash(_safe_path(config, config.repo_root / name)) for name in product}
        if meaningful and not any(hashes.values()):
            raise ValueError("Observable product source must still exist")
        outcome = "BOUNDARY_READY" if assessment["verification_boundary"] else "PRODUCTIVE_CHECKPOINT" if meaningful else "NO_EFFECT"
        report = find_report_file(config.reports_dir, task_id)
        return ledger.append(task_id, "progress", outcome, reason=assessment["inspection"],
                             worker_run_id=worker_run_id, original_record_sha256=_identity(original),
                             worker_return_sha256=compute_file_hash(result_path), mission_id=mission_id,
                             content_identity=info["content_identity"], changed_paths=changed, changed_file_sha256=hashes,
                             report_updated=original.get("report_updated", False), report_sha256=compute_file_hash(report) if report else "",
                             progressed_plan_steps=assessment["progressed_plan_steps"], acceptance_criteria=assessment["acceptance_criteria"],
                             remaining_slices=assessment["remaining_slices"], meaningful_progress=meaningful,
                             senior_review_sha256=(info["senior_review"] or {}).get("sha256"), plan_sha256=assessment["plan_sha256"])


def _read_mission(config, mission_id):
    try:
        data = json.loads(_mission_path(config, mission_id).read_text(encoding="utf-8"))
        if (data["mission_id"] != mission_id or data["repo_root"] != str(config.repo_root.resolve())
                or data["status"] not in {"ACTIVE", "COMPLETE"} or not isinstance(data["events"], list) or not data["branch"]
                or not re.fullmatch(r"[0-9a-f]{40,64}", data["initial_head"])
                or (data["task_id"] is not None and not re.fullmatch(r"[A-Za-z0-9_-]+", data["task_id"]))):
            raise ValueError("Invalid mission facts")
        if mission_id in retired_missions(config):
            return {**data, "status": "COMPLETE", "historical_status": "COMPLETED_ARCHIVED"}
        return data
    except (OSError, ValueError, KeyError, TypeError):
        raise ValueError("Unreadable mission authority; preserve history and request human recovery")


def _save_mission(config, data):
    if data["mission_id"] in retired_missions(config):
        raise ValueError("Historical mission authority is sealed")
    path = _mission_path(config, data["mission_id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")


def begin_mission(config, previous_mission=None, authorization=""):
    """Bind facts for one Codex invocation; no task or role execution."""
    with SupervisorLock(config, role="V3_MISSION_BIND"):
        info = inspect_repository(config)
        previous = current_mission(config)
        recovery = bool(previous_mission)
        if recovery and (previous or not authorization.strip()):
            raise ValueError("Explicit initial historical recovery authorization required")
        preserved = []
        if recovery:
            old = _read_mission(config, previous_mission)
            old_task = parse_task_contract(find_task_file(config.tasks_dir, old["task_id"]))
            old_review = parse_review(find_review_file(config.reviews_dir, old["task_id"]))
            old_report = parse_report(find_report_file(config.reports_dir, old["task_id"]))
            # The historical direct-completion review uses the canonical Result
            # heading plus a later operational follow-up, rather than Decision.
            # Recognize only explicit unchanged source approval and empty blockers;
            # never reinterpret an unknown/failed current review in normal roles.
            legacy_approval = bool(old_review and old_review.decision == "UNKNOWN" and not old_review.blockers
                and re.search(r"^## Result\s+APPROVED\. Zero BLOCKERS\.", old_review.raw_content, re.M)
                and "source APPROVED/ACCEPTED unchanged." in old_review.current_content
                and "No new BLOCKER." in old_review.current_content
                and not re.search(r"\bFIX[ _]REQUIRED\b", old_review.current_content, re.I))
            if (not old_task or old_task.status != "ACCEPTED" or not old_review or not (old_review.decision == "APPROVED" or legacy_approval)
                    or old_review.blockers or not old_report or not old_report.is_complete):
                raise ValueError("Historical recovery requires accepted completed task evidence")
            if CycleLedger(config, legacy=True).budget(old["task_id"]).get("cycles_used", 0) < 60:
                raise ValueError("Historical recovery requires an exhausted legacy ledger")
            previous = previous_mission
            preserved = [fingerprint(config, p) for p in config.runtime_dir.rglob("*")
                         if p.is_file() and p.name not in {"supervisor.lock", "supervisor.lock.json"}]
        elif previous:
            old = _read_mission(config, previous)
            if old["status"] == "ACTIVE":
                raise ValueError("Existing mission is active; resume its identity and budgets")
            result = old.get("result", {})
            if (not old["task_id"] or old["task_id"] != info["active_task"]
                    or result.get("status") != "MISSION COMPLETE" or result.get("result") != "ACCEPTED"
                    or result.get("task_id") != old["task_id"]
                    or result.get("commit", {}).get("sha") != info["head"]):
                raise ValueError("Fresh mission requires observed completed task/commit authority")
            preserved = [fingerprint(config, _mission_path(config, previous))]
            ledger_path = CycleLedger(config, previous).path
            if ledger_path.exists():
                preserved.append(fingerprint(config, ledger_path))
        state = derive_workflow_state(config)
        if info["recommended_category"] == "HUMAN_INPUT_REQUIRED" and not (recovery or previous):
            raise ValueError(info["reason"])
        if (recovery or previous) and (state.is_hard_stop or not info["accepted"]
                or info["dirty_paths"] or info["staged_paths"]
                or info["branch"] in {"main", "master", "UI/UX-fixes-after-production"}
                or info["derived_state"] != "ACCEPTED_NO_COMMIT_WORTHY_CHANGES"):
            raise ValueError("Fresh mission requires clean valid Workflow v2 re-anchor and completed prior work")
        # An accepted task with nothing left to commit is not active work.
        task_id = None if recovery or previous or info["recommended_category"] in {"TASK_DEFINITION", "NEXT_TASK"} else info["active_task"]
        data = {"mission_id": uuid4().hex, "repo_root": str(config.repo_root.resolve()), "task_id": task_id,
                "status": "ACTIVE", "initial_head": info["head"], "branch": info["branch"], "events": ["KS-START", "REANCHOR"],
                "created_at": datetime.now(timezone.utc).isoformat()}
        _save_mission(config, data)
        append_transition(config, {"mission_id": data["mission_id"], "previous_mission": previous,
                                  "previous_status": "COMPLETED_ARCHIVED" if previous else None,
                                  "legacy_recovery": recovery,
                                  "authorization": authorization, "preserved": preserved,
                                  "reanchor_head": info["head"], "branch": info["branch"],
                                  "reanchor_content_identity": info["content_identity"],
                                  "previous_budget": CycleLedger(config, legacy=True).budget(old["task_id"]) if recovery else None,
                                  "created_at": data["created_at"]})
        info = inspect_repository(config)
        return {**data, "inspection": info, "next": "USE_EXISTING_ROLE_DEFINITIONS"}


def bind_mission(config, mission_id, task_id):
    """After existing NO_ACTIVE_TASK role registers a task, bind exactly once."""
    with SupervisorLock(config, task_id=task_id, role="V3_MISSION_BIND"):
        data = _read_mission(config, mission_id)
        if data["status"] != "ACTIVE" or data["task_id"] is not None:
            raise ValueError("Mission already bound or complete; a second task cannot begin")
        _active(config, task_id)
        data["task_id"] = task_id
        data["events"].append("TASK")
        _save_mission(config, data)
        return data


def mission_guard(config, mission_id, task_id):
    data = _read_mission(config, mission_id)
    if data["status"] != "ACTIVE" or not data["task_id"] or data["task_id"] != task_id:
        raise ValueError("Mission task boundary: a second task cannot begin; run ks-start again")
    info = inspect_repository(config)
    if info["active_task"] != task_id:
        raise ValueError("Mission task changed in canonical authority; stop rather than advance")
    if info["branch"] != data["branch"]:
        raise ValueError("Mission branch changed; stop rather than switch worktrees")
    if info["recommended_category"] == "HUMAN_INPUT_REQUIRED":
        raise ValueError(info["reason"])
    return data


def validate_report_recovery(config, record, records):
    """Only a hash-bound, explicitly approved report repair resolves this gate."""
    original = next((r for r in records if r["run_id"] == record.get("resolved_run_id")
                     and r["task_id"] == record["task_id"] and r["phase"] == "worker"), None)
    if (record["phase"] != "remediation" or not original or original["outcome"] != "HUMAN_GATE"
            or original["reason"] != REPORT_REWRITE_REASON
            or record.get("original_record_sha256") != _identity(original)
            or not record.get("authorization") or not record.get("mission_id")
            or original.get("mission_id") != record["mission_id"]):
        raise ValueError("Invalid report provenance recovery authority")
    evidence = record.get("report_recovery", {})
    values = {}
    for key in ("prior", "candidate", "recovered", "section", "worker_return"):
        item = evidence.get(key, {})
        path = Path(item.get("path", ""))
        if (not path.is_file() or path.is_symlink()
                or not path.resolve().is_relative_to(config.runtime_dir.resolve())):
            raise ValueError("Report recovery evidence escapes authoritative runtime")
        values[key] = path.read_bytes()
        if digest(values[key]) != item.get("sha256"):
            raise ValueError("Report recovery evidence was modified")
    if (values["candidate"].startswith(values["prior"])
            or values["recovered"] != values["prior"] + values["section"]
            or report_violations(b"", values["section"], original["run_id"])
            or b"Codex-recovered checkpoint" not in values["section"]):
        raise ValueError("Recovery must restore exact history and append only current-turn evidence")
    output = json.loads(values["worker_return"])
    if (output.get("cycle", {}).get("record") != original
            or output.get("violations") != [REPORT_REWRITE_REASON]):
        raise ValueError("Recovery proof does not match original worker gate")


def recover_report_provenance_gate(config, task_id, mission_id, blocked_run_id, authorization,
                                   prior_path, candidate_path, section_path, current_report_sha256):
    """Restore approved exact history; retain rejected report/worker/source evidence.

    No source edits, provider calls, mission mutation or retry/correction resets.
    Older runs require a recorded prior hash and Supervisor candidate audit hash.
    """
    with SupervisorLock(config, task_id=task_id, role="V3_REPORT_PROVENANCE_RECOVERY"):
        mission = _read_mission(config, mission_id)
        info = inspect_repository(config)
        if (mission["status"] != "ACTIVE" or mission["task_id"] != task_id
                or info["active_task"] != task_id or info["accepted"]
                or mission["branch"] != info["branch"] or mission["initial_head"] != info["head"]
                or not isinstance(authorization, str) or not authorization.strip()
                or not re.fullmatch(r"[0-9a-f]{32}", blocked_run_id)):
            raise ValueError("Report recovery requires unchanged bound mission and explicit authorization")
        ledger = CycleLedger(config)
        records = ledger.records()
        original = next((r for r in records if r["task_id"] == task_id and r["run_id"] == blocked_run_id
                         and r["phase"] == "worker"), None)
        if (not original or original["outcome"] != "HUMAN_GATE" or original["reason"] != REPORT_REWRITE_REASON
                or original.get("mission_id") != mission_id
                or any(r.get("resolved_run_id") == blocked_run_id for r in records)):
            raise ValueError("Only the unresolved exact report rewrite gate can be recovered")
        directory = config.runtime_dir / "v3/workers" / blocked_run_id
        output_path = _packet_path(config, directory / "return.json")
        output = json.loads(output_path.read_text(encoding="utf-8"))
        result = output["result"]
        if (output["cycle"]["record"] != original or output["violations"] != [REPORT_REWRITE_REASON]
                or result.get("auth_or_quota_failure") or result.get("soft_permission_denial")
                or not (result.get("success") or result.get("timed_out"))):
            raise ValueError("Other genuine worker gates cannot be resolved as report recovery")
        inputs = [Path(p) for p in (prior_path, candidate_path, section_path)]
        if any(p.is_symlink() or not p.resolve().is_relative_to(config.runtime_dir.resolve()) for p in inputs):
            raise ValueError("Report recovery inputs must be Supervisor-owned runtime files")
        prior, candidate, section = [p.read_bytes() for p in inputs]
        provenance = original.get("report_provenance")
        if provenance:
            prior_hash = provenance["prior"]["sha256"]
            candidate_hash = provenance["candidate"]["sha256"]
        else:
            # Narrow historical bridge: require both preexisting recorded hashes.
            preceding = records[:records.index(original)]
            previous = next((r for r in reversed(preceding) if r["task_id"] == task_id
                             and r["phase"] == "progress" and r.get("report_sha256")), None)
            audit_path = config.runtime_dir / "v3/auth-classifier-repair/new-report-provenance-gate.json"
            audit = json.loads(_packet_path(config, audit_path).read_text(encoding="utf-8"))
            if (not previous or audit.get("worker_run_id") != blocked_run_id
                    or audit.get("mission_id") != mission_id
                    or audit.get("violations") != [REPORT_REWRITE_REASON]
                    or audit.get("before_report_sha256") != previous["report_sha256"]):
                raise ValueError("Historical report bytes lack recorded prior/candidate hash authority")
            prior_hash, candidate_hash = previous["report_sha256"], audit["after_report_sha256"]
        if digest(prior) != prior_hash or digest(candidate) != candidate_hash:
            raise ValueError("Recovered report bytes do not match recorded provenance hashes")
        report = _safe_path(config, find_report_file(config.reports_dir, task_id))
        if not report or compute_file_hash(report) != current_report_sha256:
            raise ValueError("Canonical report changed during recovery inspection")
        recovered = prior + section
        # All proof validates before replacing the rejected canonical candidate.
        proof_dir = directory / ("report-recovery-" + uuid4().hex)
        proof_dir.mkdir(exist_ok=False)
        evidence = {key: save_report_bytes(proof_dir, key + ".bin", value)
                    for key, value in (("prior", prior), ("candidate", candidate), ("section", section),
                                       ("recovered", recovered), ("canonical-at-recovery", report.read_bytes()))}
        evidence["worker_return"] = {"path": str(output_path), "sha256": compute_file_hash(output_path)}
        metadata = dict(resolved_run_id=blocked_run_id, original_record_sha256=_identity(original),
                        mission_id=mission_id, authorization=authorization.strip(), report_recovery=evidence,
                        changed_file_sha256={p: compute_file_hash(_safe_path(config, config.repo_root / p))
                                             for p in original["changed_paths"] if p.startswith(("backend/", "frontend/"))})
        validate_report_recovery(config, {"task_id": task_id, "phase": "remediation", **metadata}, records)
        scratch = report.with_name(report.name + ".recovery-" + uuid4().hex)
        try:
            with scratch.open("xb") as stream:
                stream.write(recovered)
            os.replace(scratch, report)
        finally:
            if scratch.exists():
                scratch.unlink()
        return ledger.append(task_id, "remediation", "REPORT_PROVENANCE_RECOVERED",
                             reason="Explicit approved report repair: exact historical bytes restored; Codex-recovered turn appended; original violation retained",
                             **metadata)


def recover_runtime_log_gate(config, task_id, mission_id, blocked_run_id, authorization):
    """Append a human-authorized resolution of one exact adapter-log false gate.

    No mission rewrite, task transition, counter reset, invocation or Git mutation.
    Unrelated gates, auth failures, corrupt authority and exhausted budgets remain.
    """
    with SupervisorLock(config, task_id=task_id, role="V3_RUNTIME_LOG_REMEDIATION"):
        mission = _read_mission(config, mission_id)
        info = inspect_repository(config)
        if (mission["status"] != "ACTIVE" or mission["task_id"] != task_id
                or info["active_task"] != task_id or info["accepted"]
                or mission["branch"] != info["branch"] or mission["initial_head"] != info["head"]
                or not isinstance(authorization, str) or not authorization.strip()
                or not re.fullmatch(r"[0-9a-f]{32}", blocked_run_id)):
            raise ValueError("Runtime-log recovery requires the unchanged bound mission and explicit authorization")
        ledger = CycleLedger(config)
        records = ledger.records()
        original = next((r for r in records if r["run_id"] == blocked_run_id and r["task_id"] == task_id), None)
        if (not original or original["phase"] != "worker" or original["outcome"] != "HUMAN_GATE"
                or original["reason"] != RUNTIME_LOG_GATE_REASON
                or any(r.get("resolved_run_id") == blocked_run_id for r in records)):
            raise ValueError("Only the unresolved exact adapter-log false gate can be remediated")
        directory = config.runtime_dir / "v3" / "workers" / blocked_run_id
        result = json.loads((directory / "return.json").read_text(encoding="utf-8"))
        if (result["run_id"] != blocked_run_id or result["task_id"] != task_id
                or result["outcome"] != "HUMAN_GATE" or result["violations"] != RUNTIME_LOG_VIOLATIONS
                or result["result"].get("auth_or_quota_failure") or result["result"].get("soft_permission_denial")):
            raise ValueError("Worker return contains a genuine or mismatched gate")
        return ledger.append(task_id, "remediation", "REMEDIATED",
                             reason="Explicit human-approved adapter log-ownership repair; continue preserved partial task",
                             resolved_run_id=blocked_run_id, original_record_sha256=_identity(original),
                             mission_id=mission_id, authorization=authorization.strip(),
                             repair_content_identity=source_identity(config),
                             worker_return_sha256=compute_file_hash(directory / "return.json"))


def recover_auth_output_gate(config, task_id, mission_id, blocked_run_id, authorization):
    """Recover only a proven successful-provider/model-prose false AUTH_QUOTA.

    Original gate/return/logs, other quota gates, mission and counters are never
    rewritten. No provider probe, task mutation or product command is executed.
    """
    with SupervisorLock(config, task_id=task_id, role="V3_AUTH_OUTPUT_REMEDIATION"):
        mission = _read_mission(config, mission_id)
        info = inspect_repository(config)
        if (mission["status"] != "ACTIVE" or mission["task_id"] != task_id or info["active_task"] != task_id
                or info["accepted"] or mission["branch"] != info["branch"] or mission["initial_head"] != info["head"]
                or not isinstance(authorization, str) or not authorization.strip()
                or not re.fullmatch(r"[0-9a-f]{32}", blocked_run_id)):
            raise ValueError("Auth-output recovery requires the unchanged bound mission and explicit authorization")
        ledger = CycleLedger(config)
        records = ledger.records()
        original = next((r for r in records if r["task_id"] == task_id and r["run_id"] == blocked_run_id and r["phase"] == "worker"), None)
        if (not original or original["outcome"] != "AUTH_QUOTA" or original["reason"] != AUTH_OUTPUT_GATE_REASON
                or any(r.get("resolved_run_id") == blocked_run_id for r in records)):
            raise ValueError("Only an unresolved recorded auth-output false gate can be recovered")
        directory = config.runtime_dir / "v3/workers" / blocked_run_id
        paths = [directory / "return.json", directory / "logs/current_agent_stream.jsonl", directory / "logs/current_agent_stderr.log"]
        for path in paths:
            if path.is_symlink() or not path.resolve().is_relative_to(config.runtime_dir.resolve()):
                raise ValueError("Provider recovery evidence escapes authoritative runtime")
        output = json.loads(paths[0].read_text(encoding="utf-8"))
        result = output["result"]
        stdout = paths[1].read_text(encoding="utf-8")
        stderr = paths[2].read_text(encoding="utf-8")
        final = parse_antigravity_stream(stdout)["final_result"] or {}
        provider = final.get("result", final)
        status = provider.get("status") if isinstance(provider, dict) else None
        if (output["run_id"] != blocked_run_id or output["task_id"] != task_id
                or output["outcome"] != "AUTH_QUOTA" or output["cycle"]["record"] != original
                or output["violations"] or result.get("soft_permission_denial")
                or not result.get("auth_or_quota_failure") or not result.get("process_started")
                or not result.get("process_completed") or result.get("exit_code") != 0 or result.get("timed_out")
                or status != "SUCCESS" or stderr or provider_auth_quota_signal(stdout, stderr, 0)[0]
                or not re.search(r"\bunauthenticated\b", str(provider.get("response", "")), re.I)):
            raise ValueError("Genuine auth/quota/failed provider/provenance gate cannot be recovered as model prose")
        return ledger.append(task_id, "remediation", "AUTH_CLASSIFIER_REMEDIATED",
                             reason="Explicit user-approved auth-output classifier repair; successful provider product prose was falsely classified",
                             resolved_run_id=blocked_run_id, original_record_sha256=_identity(original),
                             mission_id=mission_id, authorization=authorization.strip(), provider_evidence=AUTH_FALSE_POSITIVE_PROOF,
                             evidence_sha256={p.name: compute_file_hash(p) for p in paths},
                             repair_content_identity=source_identity(config))


def role_instructions(config, shortcut, task_id="", action="", mission_id=None):
    """Reuse manual role builders in this session; never launch nested Codex."""
    info = inspect_repository(config)
    if action != "TASK_DEFINITION":
        task_id = task_id or info["active_task"] or ""
        if not task_id:
            raise ValueError("Manual role requires an active task; use ks-next task definition first")
    if mission_id and action == "TASK_DEFINITION":
        data = _read_mission(config, mission_id)
        if data["status"] != "ACTIVE" or data["task_id"] is not None or info["recommended_category"] not in {"TASK_DEFINITION", "NEXT_TASK"}:
            raise ValueError("Task definition is only allowed before a mission is bound")
    elif mission_id:
        mission_guard(config, mission_id, task_id)
    if shortcut == "ks-plan":
        prompt = CodexAdapter(config).build_prompt(Role.PLANNER, task_id)
    elif shortcut == "ks-senior":
        prompt = CodexAdapter(config).build_prompt(Role.SENIOR, task_id,
                     action_type="TARGETED_VERIFICATION" if action == "TARGETED_VERIFICATION" else "REVIEW")
    elif shortcut == "ks-impl":
        review_path = find_review_file(config.reviews_dir, task_id)
        if action == "FIX" and not review_path:
            raise ValueError("Fix role requires canonical Senior context; source-only corrections use delegate-gemini --correction")
        correction = remediation_review_context(review_path, find_report_file(config.reports_dir, task_id)) if action == "FIX" else ""
        prompt = worker_prompt(config, task_id, "fix" if action == "FIX" else "implement", info, correction)
    elif shortcut == "ks-next":
        if action not in {"CLOSEOUT", "TASK_DEFINITION"}:
            raise ValueError("ks-next role instructions require CLOSEOUT or TASK_DEFINITION")
        prompt = CodexAdapter(config).build_prompt(Role.SENIOR, task_id, action_type=action)
        prompt += "\nFollow khatasathi-workflow-router sections 1-5 and AGENTS13 for canonical closeout/dashboard/commit authority."
    else:
        raise ValueError("Unknown manual role")
    return {"role": shortcut, "task_id": task_id, "instructions": prompt, "execution": "CURRENT_SESSION_OR_WORKSPACE_WORKER",
            "mission_id": mission_id, "authority": "Existing role builder, AGENTS.md and installed role skill"}


def finish_mission(config, mission_id, accepted_files, next_task_id="", next_title=""):
    """Validate observed completion/commit, report a candidate, seal task boundary.

    Codex runs existing closeout and hygiene/commit policy; this tool does neither.
    Next task is descriptive only. No contract, checkpoint or plan is authored.
    """
    with SupervisorLock(config, role="V3_MISSION_FINISH"):
        data = _read_mission(config, mission_id)
        if data["status"] != "ACTIVE" or not data["task_id"]:
            raise ValueError("Mission unbound or already complete")
        task_id = data["task_id"]
        info = inspect_repository(config)
        if info["active_task"] not in {None, task_id}:
            raise ValueError("Next task was activated before mission boundary")
        task_path = _safe_path(config, find_task_file(config.tasks_dir, task_id))
        review_path = _safe_path(config, find_review_file(config.reviews_dir, task_id))
        report_path = _safe_path(config, find_report_file(config.reports_dir, task_id))
        if not task_path or not review_path or not report_path:
            raise ValueError("Mission completion requires physical contract, review and report")
        task = parse_task_contract(task_path)
        review = parse_review(review_path)
        report = parse_report(report_path)
        authorized_branch = re.split(r";|\s+/\s+", task.branch_worktree)[0].strip(" `") if task else ""
        if (not authorized_branch or info["branch"] != authorized_branch or info["branch"] != data["branch"]
                or info["branch"] in {"main", "master", "UI/UX-fixes-after-production"}):
            raise ValueError("Mission commit branch does not match authorized worktree")
        records = [r for r in CycleLedger(config).records() if r["task_id"] == task_id]
        closeouts = [r for r in records if r["phase"] == "closeout" and r["outcome"] == "ACCEPTED"]
        if (not task or task.status != "ACCEPTED" or not review or review.decision != "APPROVED" or review.blockers
                or not report or not report.is_complete
                or not closeouts):
            raise ValueError("Mission requires canonical ACCEPTED, zero blockers, complete report and recorded closeout")
        if (closeouts[-1].get("content_identity") != info["content_identity"]
                or closeouts[-1].get("senior_review_sha256") != compute_file_hash(find_review_file(config.reviews_dir, task_id))):
            raise ValueError("Accepted content or Senior evidence changed after closeout")
        if info["budget"]["status"] == "HUMAN_INPUT_REQUIRED":
            raise ValueError(info["budget"]["reason"])
        if next_task_id == task_id:
            raise ValueError("Next candidate must differ from completed mission")
        paths = sorted(set(accepted_files))
        if not paths:
            raise ValueError("A task commit requires explicit accepted scope")
        for name in paths:
            if not name or name.startswith(("-", "/")) or "\\" in name or ".." in Path(name).parts:
                raise ValueError("Invalid accepted commit path")
        if set(paths) & set(info["dirty_paths"]) or info["staged_paths"]:
            raise ValueError("Accepted commit content remains dirty or index is mixed")
        code, changed, _ = run_git(config.repo_root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")
        parent_code, parent, _ = run_git(config.repo_root, "rev-parse", "HEAD^")
        message_code, message, _ = run_git(config.repo_root, "log", "-1", "--format=%s")
        if (code or parent_code or message_code or parent.strip() != data["initial_head"]
                or info["head"] == data["initial_head"] or sorted(changed.splitlines()) != paths
                or not message.startswith(task_id + ": ")):
            raise ValueError("Observed atomic commit does not match mission HEAD, task message and exact accepted scope")
        data["status"] = "COMPLETE"
        data["events"] += ["COMMIT", "REANCHOR", "REPORT NEXT TASK", "STOP"]
        data["result"] = {"status": "MISSION COMPLETE", "task_id": task_id, "result": "ACCEPTED",
                          "senior_review": "ACCEPTED", "remaining_blockers": 0, "closeout": "COMPLETE",
                          "commit": {"sha": info["head"], "message": message.strip()},
                          "working_tree": "DIRTY" if info["dirty_paths"] else "CLEAN", "dirty_paths": info["dirty_paths"],
                          "next_task": {"id": next_task_id or None, "title": next_title, "started": False},
                          "stop": "KS-START STOPPED AT TASK BOUNDARY. Run ks-start to begin the next task."}
        _save_mission(config, data)
        return data["result"]
