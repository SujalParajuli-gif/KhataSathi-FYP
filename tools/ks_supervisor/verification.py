"""Content-bound bounded-check evidence, independent of whole-agent completion."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
from typing import Optional

from tools.ks_supervisor.repo import compute_file_hash, run_git
from tools.ks_supervisor.permissions import CommandPermissions


# Conservative subsystem coverage includes source, specs, package/config/schema
# and nonignored assets. These shared execution inputs affect either subsystem.
SHARED_INPUTS = ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc",
                 "tsconfig.json", ".env", ".env.local")


def compact_verification_plan(plan: Optional[dict], run_id: str = "") -> dict:
    """Provider-facing decisions only; provenance stays in the frozen runtime plan.

    The supervisor has already compared content hashes. Do not delegate that
    comparison to Gemini or duplicate coverage/path/policy maps in its argv.
    """
    plan = plan or {}
    summary = {"plan_run_id": run_id, "evidence_authority": "Supervisor-validated current content identity"}
    for section in ("reusable_verification", "invalidated_verification", "required_verification"):
        summary[section] = []
        for item in plan.get(section, []):
            reasons = item.get("invalidated_by", item.get("reason", []))
            if isinstance(reasons, str):
                reasons = [reasons]
            reason = (f"{len(reasons)} covered inputs/identity conditions changed; "
                      + "; ".join(str(r)[:160] for r in reasons[:3])) if reasons else "Content identity valid"
            summary[section].append({
                "check_id": item.get("check_id", ""), "command": item.get("command", ""),
                "subsystem": item.get("subsystem", ""), "status": item.get("status", section),
                "authorized": item.get("authorized", False), "reason": reason,
            })
    summary["verification_gaps"] = [str(g)[:240] for g in plan.get("verification_gaps", [])[:3]]
    if not plan:
        summary["verification_gaps"] = ["No supervisor plan supplied; do not assume checks passed."]
    return summary


def bounded_check(command: str) -> Optional[dict]:
    """Identify evidence targets, never grant command permission or broaden test scope."""
    if any(token in command for token in (";", "&", "|", "(", ")", "`", "$", "\n", "\r", "<", ">", "{", "}")):
        return None
    try:
        args = shlex.split(command.replace("\\", "/"))
    except ValueError:
        return None
    if not args:
        return None
    args[0] = re.sub(r"\.(cmd|exe)$", "", args[0], flags=re.I)
    kind, scopes = "", []
    if args == ["pnpm", "--dir", "backend", "run", "build"]:
        kind, scopes = "backend build", ["backend"]
    elif args in (["pnpm", "--dir", "frontend", "run", "typecheck"],
                  ["pnpm", "--dir", "frontend", "exec", "tsc", "--noEmit"]):
        kind, scopes = "frontend typecheck", ["frontend"]
    elif args[:6] == ["pnpm", "--dir", "frontend", "exec", "playwright", "test"]:
        if not args[6:] or not args[6].startswith("tests/") or any("*" in a or ".." in a for a in args[6:]):
            return None
        kind, scopes = "frontend targeted Playwright", ["frontend"]
    elif args[:2] == ["node", "--test"] and args[2:] and all(
            a.startswith("backend/") and ".." not in a and "*" not in a for a in args[2:]):
        kind, scopes = "backend targeted tests", ["backend"]
    elif args in (["pnpm", "--dir", "frontend", "run", "lint"],
                  ["pnpm", "--dir", "backend", "run", "lint"]):
        kind, scopes = f"{args[2]} lint", [args[2]]
    if not kind:
        return None  # In particular, broad `pnpm --dir backend test` is not evidence coverage.
    return {"command": shlex.join(args), "kind": kind, "scopes": scopes}


def compact_senior_verification_context(plan: Optional[dict], run_id: str = "", evidence_location: str = "") -> dict:
    """Project validated evidence for a reviewer, without exposing coverage maps."""
    summary = compact_verification_plan(plan, run_id)
    summary["evidence_location"] = evidence_location
    for compact, item in zip(summary["reusable_verification"], (plan or {}).get("reusable_verification", [])):
        compact.update(outcome=item["outcome"], result_summary=str(item["result_summary"])[:240],
                       verifier_run_id=item["verifier_run_id"], result_sha256=item["result_sha256"],
                       content_identity="valid/current at Senior launch", content_identity_sha256=item["content_identity_sha256"],
                       target_sha256=item["target_sha256"], recorded_at=item.get("recorded_at"),
                       evidence_location=evidence_location or item["evidence_location"],
                       output_location=item.get("output_location"))
    return summary


def senior_verification_prompt(plan: Optional[dict], run_id: str = "", evidence_location: str = "") -> str:
    return (
        "\n## Supervisor-owned current-content verification context\n"
        "VALID REUSABLE VERIFICATION / INVALIDATED VERIFICATION / REQUIRED VERIFICATION:\n"
        + json.dumps(compact_senior_verification_context(plan, run_id, evidence_location), indent=2, sort_keys=True)
        + "\nReuse valid supervisor-owned current-content evidence only when content/target identity matches. "
        "Cite verifier run/check IDs, command, result and content identity in the Senior review. "
        "Do not rerun a passing bounded check solely to reproduce evidence unless independent confirmation is materially necessary. "
        "If an optional independent rerun is unavailable for unrelated infrastructure/startup reasons, preserve earlier valid evidence "
        "unless that failure actually invalidates its target/content assumptions. Distinguish 'independent rerun unavailable' from "
        "'acceptance evidence unavailable'; report each independent rerun and outcome separately. "
        "Never reuse failed, stale, mismatched or unverifiable evidence; required checks remain unsatisfied. "
        "Senior remains final authority over every blocker: a suite PASS does not establish missing source/test semantics or automatically resolve a blocker. "
        "Keep the latest Senior blocker scope and unresolved findings authoritative, including B-5/B-7 when listed. "
        "For a committed-reference response-loss blocker, inspect commit-before-loss, reload, identical reference payload/expected tuple "
        "and one total metadata/audit effect; verification reuse alone cannot resolve B-7.\n"
        "If reusing evidence, record: Reused current-content Supervisor targeted verification from verifier run <id>, check <id>, "
        "command <command>, result <n/n passed>, content identity matched at Senior launch.\n"
    )


class VerificationEvidence:
    def __init__(self, config, task_id: str):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", task_id):
            raise ValueError("Invalid verification task identifier")
        self.config, self.task_id = config, task_id
        self.path = config.runtime_dir / "verification_evidence" / f"{task_id}.json"
        self.gaps = []
        try:
            self.data = json.loads(self.path.read_text(encoding="utf-8"))
            if (self.data["schema_version"] != 1 or self.data["task_id"] != task_id
                    or not isinstance(self.data["checks"], dict) or not isinstance(self.data["diagnostics"], list)):
                raise ValueError("Invalid evidence ledger")
        except (OSError, ValueError, KeyError, TypeError):
            self.data = {"schema_version": 1, "task_id": task_id, "checks": {}, "diagnostics": []}
            self.gaps.append("No readable content-bound ledger: historical prose/logs alone are not verified passes.")
        self.started = {}
        self.pending = {}
        self.frozen_plan = None
        self.attempts = []
        self.plan_path = None

    def snapshot(self, check: dict) -> dict:
        code, output, _ = run_git(self.config.repo_root, "ls-files", "-z", "--cached", "--others",
                                  "--exclude-standard", "--", *check["scopes"])
        if code:
            raise OSError("Cannot determine verification coverage path set")
        paths = set(output.split("\0")) - {""}
        # Explicit test targets may be ignored generated files (backend/dist).
        # Fingerprint the actual executed spec as well as subsystem inputs.
        args = shlex.split(check["command"])
        if check["kind"] == "backend targeted tests":
            paths.update(args[2:])
        elif check["kind"] == "frontend targeted Playwright":
            paths.update("frontend/" + a for a in args[6:] if a.startswith("tests/"))
        paths.update(p for p in SHARED_INPUTS if (self.config.repo_root / p).is_file())
        for scope in check["scopes"]:
            paths.update(f"{scope}/{p}" for p in (".env", ".env.local", ".env.test")
                         if (self.config.repo_root / scope / p).is_file())
        identities = {}
        for name in sorted(paths):
            path = self.config.repo_root / name
            if not path.resolve().is_relative_to(self.config.repo_root.resolve()) or path.is_symlink():
                raise OSError("Unsafe verification coverage path")
            digest = compute_file_hash(path)
            if not digest:
                raise OSError(f"Cannot fingerprint verification coverage: {name}")
            identities[name] = digest
        # Values can contain targets/secrets; record a digest only.
        environment = {k: os.environ.get(k, "") for k in
                       ("NODE_ENV", "CI", "PLAYWRIGHT_BASE_URL", "PORT", "DATABASE_URL")}
        return {"files": identities, "repo_root": str(self.config.repo_root.resolve()),
                "target_sha256": hashlib.sha256(json.dumps(environment, sort_keys=True).encode()).hexdigest()}

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.data, indent=2), encoding="utf-8")
        temporary.replace(self.path)

    def record_result(self, check, record):
        """Append history before moving the latest-result index; never alter old proof."""
        previous = self.data["checks"].get(check["command"])
        history = self.data.setdefault("history", [])
        if previous and previous not in history:
            history.append(previous)
        history.append(record)
        self.data["checks"][check["command"]] = record
        self.save()

    def plan(self, permissions=None) -> dict:
        permissions = permissions or CommandPermissions()
        reusable, invalidated = [], []
        for command, record in self.data["checks"].items():
            try:
                check = bounded_check(command)
                legacy = bool(check and check["kind"] == "frontend targeted Playwright"
                              and record["check"] == {**check, "scopes": ["backend", "frontend"]})
                if (not check or (record["check"] != check and not legacy) or record["task_id"] != self.task_id
                        or not record["run_id"] or record["outcome"] != "PASS" or not record["snapshot"]["files"]
                        or record.get("verifier_run_id", record["run_id"]) != record["run_id"]
                        or not isinstance(record["result_summary"], str)
                        or not re.fullmatch(r"[a-f0-9]{64}", record["result_sha256"])):
                    raise ValueError("Invalid verification identity")
                current = self.snapshot(check)
                old = record["snapshot"]
                # Narrow only the contemporaneously captured legacy hashes. Never
                # substitute today's hashes or persist fabricated provenance.
                covered = {n: h for n, h in old["files"].items() if not legacy
                           or n.startswith("frontend/") or n in SHARED_INPUTS}
                changed = sorted(n for n in set(covered) | set(current["files"])
                                 if covered.get(n) != current["files"].get(n))
                reasons = changed + (["runtime target/environment changed"]
                                     if old["target_sha256"] != current["target_sha256"]
                                     or old["repo_root"] != current["repo_root"] else [])
                item = {**check, "run_id": record["run_id"], "outcome": "PASS", "covered_files": covered,
                        "target_sha256": old["target_sha256"], "result_sha256": record["result_sha256"],
                        "result_summary": record["result_summary"],
                        "verifier_run_id": record.get("verifier_run_id", record["run_id"]),
                        "recorded_at": record.get("recorded_at"),
                        "evidence_location": str(self.path), "output_location": record.get("output_path"),
                        "content_identity_sha256": hashlib.sha256(json.dumps(
                            {**old, "files": covered}, sort_keys=True).encode()).hexdigest(),
                        "invalidated_by": reasons, "coverage_interpretation": "legacy narrowed from captured hashes" if legacy else "subsystem"}
                (invalidated if reasons else reusable).append(item)
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                invalidated.append({"command": command, "invalidated_by": ["Missing or invalid coverage identity"]})
        for items, status in ((reusable, "reusable"), (invalidated, "invalidated")):
            for item in items:
                proposed = item["command"]
                check = bounded_check(proposed)
                candidates = [check["command"]] if check else []
                # Executable suffixes are equivalent, unlike replacing a test
                # suite with a build or guessing targets for test:fast.
                if candidates:
                    binary, rest = candidates[0].split(" ", 1)
                    candidates.append(binary + (".cmd" if binary == "pnpm" else ".exe") + " " + rest)
                authorized, reason = False, "No known bounded equivalent; cannot substitute verification semantics"
                command = proposed
                for candidate in candidates:
                    authorized, reason = permissions.authorized(candidate)
                    if authorized:
                        command = candidate
                        break
                item.update(check_id=hashlib.sha256(proposed.encode()).hexdigest()[:16],
                            proposed_command=proposed, command=command,
                            subsystem=check["scopes"][0] if check else "unknown",
                            coverage_scope=check["scopes"] + list(SHARED_INPUTS) if check else [],
                            authorized=authorized, authorization_reason=reason,
                            status=status, required_this_run=status != "reusable")
        return {"reusable_verification": reusable, "invalidated_verification": invalidated,
                "required_verification": [{**i, "status": "required", "reason": i["invalidated_by"]} for i in invalidated],
                "permission_policy": permissions.metadata(),
                "verification_gaps": self.gaps + ([] if self.data["checks"] else ["No content-bound checks recorded; inspect missing required Senior evidence without assuming PASS."])}

    def freeze(self, run_id: str, plan: dict, provider: str = "antigravity"):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", run_id):
            raise ValueError("Invalid verification run identifier")
        self.frozen_plan = json.loads(json.dumps(plan))
        self.plan_path = self.config.runtime_dir / "verification_plans" / f"{run_id}.json"
        self.plan_path.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive creation: a frozen plan for this run is never overwritten.
        with self.plan_path.open("x", encoding="utf-8") as stream:
            json.dump({"schema_version": 1, "run_id": run_id, "task_id": self.task_id,
                       "provider": provider, "plan": self.frozen_plan}, stream, indent=2)

    def diagnose_attempt(self, command, run_id):
        check = bounded_check(command)
        identity = check["command"] if check else command
        plan = self.frozen_plan or self.plan()
        required = any((bounded_check(i["command"]) or {}).get("command") == identity
                       for i in plan["required_verification"])
        reusable = any((bounded_check(i["command"]) or {}).get("command") == identity
                       for i in self.plan()["reusable_verification"])
        kind = "PLANNER_REQUIRED_VERIFICATION" if required else (
            "REDUNDANT_VERIFICATION_REQUEST" if reusable else "AGENT_INVENTED_VERIFICATION")
        diagnostic = {"kind": kind, "run_id": run_id, "command": command,
                      "planner_required": required, "out_of_plan": not required,
                      "reusable_at_request": reusable, "plan_path": str(self.plan_path) if self.plan_path else None}
        self.attempts.append(diagnostic)
        self.data["diagnostics"].append(diagnostic)
        self.data["diagnostics"] = self.data["diagnostics"][-50:]
        self.save()
        # Diagnostics are separate from the immutable plan, and survive a crash.
        if self.plan_path:
            path = self.plan_path.with_suffix(".attempts.json")
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps({"run_id": run_id, "attempts": self.attempts}, indent=2), encoding="utf-8")
            temporary.replace(path)

    def observe(self, event: dict, run_id: str):
        """Observe real tool events at command start/end; final agent claims are never check results."""
        step = event.get("step_update", {})
        if not isinstance(step, dict) or step.get("tool_name") not in ("run_command", "command_status"):
            return
        info = step.get("tool_info", {})
        if not isinstance(info, dict) or not isinstance(info.get("parameters", {}), dict):
            return
        parameters = info.get("parameters", {})
        if step["tool_name"] == "command_status":
            command_id = parameters.get("CommandId") or parameters.get("command_id")
            key = self.pending.get((run_id, command_id))
            if key not in self.started or step.get("state") not in ("DONE", "ERROR"):
                return
            check = self.started[key][0]
        else:
            command = parameters.get("CommandLine", "")
            if not isinstance(command, str):
                return
            # Unknown verification commands must remain observable, never PASS.
            if step.get("state") == "ACTIVE" and (bounded_check(command) or re.search(
                    r"\b(test(?::[\w-]+)?|build|lint|typecheck|tsc|playwright)\b", command)):
                self.diagnose_attempt(command, run_id)
            check = bounded_check(command)
            if not check:
                return
            cwd = parameters.get("Cwd") or parameters.get("cwd")
            if cwd and Path(cwd).resolve() != self.config.repo_root.resolve():
                return  # Never attribute a check in another workspace to this content.
            key = (run_id, step.get("step_index"))
        if step.get("state") == "ACTIVE":
            before = self.snapshot(check)
            self.started[key] = (check, before)
            return
        if step.get("state") not in ("DONE", "ERROR") or key not in self.started:
            return
        started_check, before = self.started[key]
        if started_check != check:
            return
        output = info.get("output", "")
        if not isinstance(output, str):
            return
        command_id = info.get("command_id") or info.get("CommandId")
        id_match = re.search(r"Command ID:\s*([A-Za-z0-9_-]+)", output, re.I)
        if command_id or id_match:
            self.pending[(run_id, command_id or id_match.group(1))] = key
        if (re.search(r"(?:still running|background command|command is running)", output, re.I)
                or (step["tool_name"] == "run_command" and (command_id or id_match))):
            return
        self.started.pop(key)
        explicit_exit = info.get("exit_code", info.get("ExitCode"))
        match = re.search(r"(?:exit code|ExitCode):?\s*(-?\d+)", output, re.I)
        if explicit_exit is None and match:
            explicit_exit = int(match.group(1))
        failures = re.search(r"(?:\b[1-9]\d* failed\b|\b[1-9]\d* failing\b|error TS\d+|ERR_PNPM|permission.*denied|timed out|^# fail [1-9]\d*|Found [1-9]\d* errors)", output, re.I | re.M)
        positive = re.search(r"(?:\b[1-9]\d* passed\b|^# pass [1-9]\d*$)", output, re.M)
        passed = (step["state"] == "DONE" and not info.get("error") and not failures
                  and (explicit_exit == 0 or (explicit_exit is None and positive)))
        if not passed:
            if explicit_exit is not None or failures or step["state"] == "ERROR":
                # A denied/timed-out command did not disprove an earlier valid result.
                if (explicit_exit not in (None, 0) or failures) and not re.search(r"permission|denied|timed out", output + str(info.get("error", "")), re.I):
                    self.record_result(check, {
                        "task_id": self.task_id, "run_id": run_id, "check": check, "outcome": "FAIL",
                        "snapshot": before, "result_sha256": hashlib.sha256(output.encode()).hexdigest(),
                    })
            return
        after = self.snapshot(check)
        if before != after or not before["files"]:
            return  # Do not bind an ambiguous mid-command content change to a PASS.
        self.record_result(check, {
            "task_id": self.task_id, "run_id": run_id, "check": check, "outcome": "PASS", "snapshot": after,
            "result_sha256": hashlib.sha256(output.encode()).hexdigest(),
            "result_summary": positive.group(0) if positive else "Command completed with exit code 0",
            "recorded_at": datetime.now(timezone.utc).isoformat(),
        })  # Persist now, even if the agent later times out or is denied another command.
