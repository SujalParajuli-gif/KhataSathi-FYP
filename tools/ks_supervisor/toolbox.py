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

from tools.ks_supervisor.adapters.antigravity import AntigravityAdapter, extract_event_info
from tools.ks_supervisor.adapters.codex import CodexAdapter
from tools.ks_supervisor.adapters.base import redact_secrets
from tools.ks_supervisor.lock import SupervisorLock
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


class DirectCodexVerificationRequired(ValueError):
    """Toolbox subset does not cover this check; Codex can assess direct execution."""


MISSION_DEFINITION = {"path": ".agents/skills/khatasathi-workflow-router/SKILL.md", "section": 9}
CHAT_ROLES = {"ks-start": "MISSION_CONTROLLER", "ks-plan": "PLANNER", "ks-impl": "IMPLEMENTATION",
              "ks-senior": "SENIOR_REVIEW", "ks-next": "CLOSEOUT_ADVANCE"}


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
    PHASES = {"worker", "planning", "verification", "review", "closeout", "task_definition", "reanchor"}
    OUTCOMES = {"PASS", "FAIL", "FIX_REQUIRED", "APPROVED", "ACCEPTED", "SUCCESS", "NO_EFFECT",
                "INFRASTRUCTURE_FAILURE", "AUTH_QUOTA", "HUMAN_GATE"}

    def __init__(self, config):
        self.config = config
        self.path = config.runtime_dir / "v3" / "cycles.jsonl"

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
            return records
        except (ValueError, KeyError, TypeError):
            raise ValueError("Unreadable cycle authority; human recovery required")

    def budget(self, task_id):
        all_records = self.records()
        records = [r for r in all_records if r["task_id"] == task_id]
        if len(all_records) >= 60:
            return {"status": "HUMAN_INPUT_REQUIRED", "reason": "Finite 60-cycle budget exhausted; review history before explicit recovery"}
        infra_signature, infra_count, no_effect = "", 0, 0
        stagnation, last_blockers = {}, {}
        stopped = ""
        for record in records:
            outcome = record["outcome"]
            if outcome in {"AUTH_QUOTA", "HUMAN_GATE"}:
                stopped = record["reason"] or outcome
            if outcome == "INFRASTRUCTURE_FAILURE":
                signature = record["phase"] + ":" + record["failure_signature"]
                infra_count = infra_count + 1 if signature == infra_signature else 1
                infra_signature = signature
                if infra_count >= 3:
                    stopped = "Same infrastructure failure after two automatic retries"
            elif outcome in {"SUCCESS", "PASS"} and record["phase"] in {"worker", "verification"}:
                infra_signature, infra_count = "", 0
            if record["phase"] == "worker":
                no_effect = no_effect + 1 if outcome == "NO_EFFECT" else 0
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
        return {"status": "HUMAN_INPUT_REQUIRED" if stopped else "CONTINUE", "reason": stopped,
                "infrastructure_failures": infra_count, "no_effect_returns": no_effect,
                "stagnant_corrections": max(stagnation.values(), default=0), "cycles_used": len(all_records), "cycle_limit": 60}

    def append(self, task_id, phase, outcome, blockers=(), reason="", failure_signature="", run_id="", **metadata):
        if phase not in self.PHASES or outcome not in self.OUTCOMES:
            raise ValueError("Unsupported cycle phase/outcome")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", task_id or "NO_ACTIVE_TASK"):
            raise ValueError("Invalid cycle task")
        if not all(isinstance(b, str) and b for b in blockers):
            raise ValueError("Blockers must be stable nonempty identifiers")
        record = {"task_id": task_id, "phase": phase, "outcome": outcome, "blockers": list(blockers),
                  "reason": redact_secrets(reason), "failure_signature": failure_signature or _identity(reason),
                  "run_id": run_id or uuid4().hex, "recorded_at": datetime.now(timezone.utc).isoformat(), **metadata}
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
        # Worker returns always go to Codex verification. A record cannot waive
        # canonical Senior review: it recommends a role, never approves anything.
        records = [r for r in ledger.records() if r["task_id"] == task_id]
        relevant = [r for r in records if r["phase"] in {"worker", "verification", "review"}]
        latest = relevant[-1] if relevant else None
        review_identity = (review or {}).get("sha256")
        if latest and latest.get("content_identity") == identity and latest.get("senior_review_sha256") == review_identity:
            if latest["phase"] == "worker" and latest["outcome"] == "SUCCESS":
                category = "CODEX_VERIFY"
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


def delegate_gemini(config, task_id, mode="implement", correction_path=None, mission_id=None):
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
        (directory / "launch.json").write_text(json.dumps(launch, indent=2), encoding="utf-8")
        # Existing runtime proof is also authority. The worker cannot rewrite a
        # previous ledger/plan/result to turn a missing check into a reusable pass.
        runtime_before = {p: compute_file_hash(p) for p in config.runtime_dir.rglob("*")
                          if p.is_file() and p.name not in {"supervisor.lock", "supervisor.lock.json"}}
        forbidden_tools = []
        def observe(event):
            lock.update_heartbeat()
            tool = extract_event_info(event).get("tool_name") or ""
            if tool.lower().replace("_", "") in {"runcommand", "shell", "terminal", "executecommand"}:
                forbidden_tools.append(tool)
        try:
            result = AntigravityAdapter(config).invoke(Role.IMPLEMENTATION, task_id, prompt=prompt, profile=profile,
                     hard_timeout=config.get_agent_hard_timeout(info["risk"]), run_id=run_id, action="V3_WORKER_" + mode.upper(), verification_observer=observe)
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
        if result_info.get("auth_or_quota_failure"):
            outcome = "AUTH_QUOTA"
        elif violations or result_info.get("soft_permission_denial"):
            outcome = "HUMAN_GATE"
        elif not result_info["success"]:
            outcome = "INFRASTRUCTURE_FAILURE"
        elif not any(not p.lower().startswith(("docs/engineering/", ".agents/")) for p in changed):
            # Report claims alone must not create an endless apparent-progress loop.
            outcome = "NO_EFFECT"
        else:
            outcome = "SUCCESS"
        reason = "; ".join(violations) or result_info.get("error_message") or outcome
        cycle = CycleLedger(config).append(task_id, "worker", outcome, reason=reason, run_id=run_id,
                  failure_signature=_identity({k: result_info.get(k) for k in ("infrastructure_failure", "exit_code", "timed_out", "timeout_kind")}),
                  content_identity=source_identity(config), mode=mode, changed_paths=changed,
                  report_updated=any(a.startswith("report:") for a in delta.changed_workflow_artifacts),
                  runtime_location=str(directory), senior_review_sha256=(info["senior_review"] or {}).get("sha256"),
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


def _read_mission(config, mission_id):
    try:
        data = json.loads(_mission_path(config, mission_id).read_text(encoding="utf-8"))
        if (data["mission_id"] != mission_id or data["repo_root"] != str(config.repo_root.resolve())
                or data["status"] not in {"ACTIVE", "COMPLETE"} or not isinstance(data["events"], list) or not data["branch"]
                or not re.fullmatch(r"[0-9a-f]{40,64}", data["initial_head"])
                or (data["task_id"] is not None and not re.fullmatch(r"[A-Za-z0-9_-]+", data["task_id"]))):
            raise ValueError("Invalid mission facts")
        return data
    except (OSError, ValueError, KeyError, TypeError):
        raise ValueError("Unreadable mission authority; preserve history and request human recovery")


def _save_mission(config, data):
    path = _mission_path(config, data["mission_id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")


def begin_mission(config):
    """Bind facts for one Codex invocation; no task or role execution."""
    with SupervisorLock(config, role="V3_MISSION_BIND"):
        info = inspect_repository(config)
        if info["recommended_category"] == "HUMAN_INPUT_REQUIRED":
            raise ValueError(info["reason"])
        # An accepted task with nothing left to commit is not active work.
        task_id = None if info["recommended_category"] in {"TASK_DEFINITION", "NEXT_TASK"} else info["active_task"]
        data = {"mission_id": uuid4().hex, "repo_root": str(config.repo_root.resolve()), "task_id": task_id,
                "status": "ACTIVE", "initial_head": info["head"], "branch": info["branch"], "events": ["KS-START", "REANCHOR"],
                "created_at": datetime.now(timezone.utc).isoformat()}
        _save_mission(config, data)
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
