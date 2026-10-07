"""KhataSathi Workflow Supervisor - Antigravity Headless CLI (`agy`) Adapter."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time
from uuid import uuid4
from typing import Any, Callable, Dict, List, Optional, Tuple

from tools.ks_supervisor.adapters.base import BaseAgentAdapter, redact_secrets, sanitize_environment
from tools.ks_supervisor.config import SupervisorConfig
from tools.ks_supervisor.permissions import CLI_PROJECT
from tools.ks_supervisor.repo import remediation_review_context
from tools.ks_supervisor.types import AgentResult, Role, WorkflowState
from tools.ks_supervisor.verification import compact_verification_plan


def invocation_size(argv: List[str], prompt: str, limit: int) -> dict:
    """Measure exactly the argv passed to Popen, including Windows quoting.

    CreateProcessW counts UTF-16 code units and the terminating NUL. Python's
    string length alone undercounts non-BMP characters such as emoji.
    """
    serialized = subprocess.list2cmdline(argv)
    return {"prompt_chars": len(prompt), "serialized_argv_chars": len(serialized),
            "serialized_argv_utf16_units": len(serialized.encode("utf-16-le")) // 2,
            "configured_limit": limit}


SOFT_PERMISSION_DENIAL_PATTERNS = [
    r"permission\s+check\s+failed",
    r"user\s+denied\s+permission",
    r"headless\s+mode\s+cannot\s+prompt",
    r"auto-denied",
    r"required\s+the\s+[\"']?command[\"']?\s+permission",
    r"permission\s+denied",
    r"tool\s+execution\s+(?:was\s+)?denied",
    r"tool\s+call\s+rejected",
    r"tool\s+permission\s+(?:was\s+)?denied",
    r"operation\s+not\s+permitted",
    r"write\s+permission\s+(?:is\s+)?required",
    r"unauthorized\s+to\s+modify",
    r"access\s+denied\s+to\s+path",
    r"prompted\s+for\s+approval\s+and\s+denied",
    r"soft-denied",
    r"permission_denied",
    r"denied_actions",
    r"deniedActions",
]

AUTH_OR_QUOTA_PATTERNS: List[Tuple[str, str]] = [
    (r"quota\s+(?:exceeded|exhausted|limit|reached)", "Provider quota exceeded or plan limit reached"),
    (r"resource_exhausted", "Provider resource exhausted"),
    (r"rate\s+limit", "Provider rate limit exceeded"),
    (r"authentication\s+required", "Authentication required for Google AI account"),
    (r"login\s+required", "Login required for Google AI account"),
    (r"unauthenticated", "Antigravity CLI is unauthenticated"),
    (r"unauthorized", "Unauthorized / authentication credentials invalid"),
    (r"invalid\s+(?:api\s+)?key", "Invalid API key / credentials"),
    (r"credentials?\s+(?:expired|invalid|missing)", "Credentials expired, invalid, or missing"),
    (r"insufficient\s+(?:quota|credits?)", "Insufficient quota or credits on account"),
    (r"credit\s+balance", "Credit balance exhausted"),
    (r"plan\s+(?:limit|upgrade\s+required)", "Plan limit reached / account upgrade required"),
    (r"429\s+Too\s+Many\s+Requests", "HTTP 429 Too Many Requests (Rate limit / Quota)"),
    (r"401\s+Unauthorized", "HTTP 401 Unauthorized"),
    (r"403\s+Forbidden", "HTTP 403 Forbidden"),
    (r"please\s+log\s+in", "Login required"),
    (r"agy\s+auth\s+login", "Authentication required (run `agy auth login`)"),
]


_SESSION_KEYS = ("session_id", "sessionId", "conversation_id", "conversationId", "thread_id", "threadId")
_USAGE_KEYS = ("usage", "token_usage", "tokenUsage", "usageMetadata", "usage_metadata")
_TOKEN_FIELDS = (
    "input_tokens", "output_tokens", "prompt_tokens", "completion_tokens", "total_tokens",
    "cached_tokens", "reasoning_tokens", "thoughts_tokens",
    "promptTokens", "completionTokens", "totalTokens", "promptTokenCount",
    "candidatesTokenCount", "totalTokenCount", "thoughtsTokenCount", "cachedContentTokenCount",
)
_RESULT_TYPES = {"result", "final", "final_result", "done", "complete", "completed", "turn_complete", "end"}


def _walk_json(node: Any, depth: int = 0):
    """Yield every dict nested inside a JSON value (bounded depth)."""
    if depth > 8:
        return
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk_json(v, depth + 1)
    elif isinstance(node, list):
        for v in node:
            yield from _walk_json(v, depth + 1)


def extract_event_info(data: Dict[str, Any]) -> Dict[str, Any]:
    """Extract step index, tool name, tool target, tool state, session id, and usage from event data."""
    info: Dict[str, Any] = {
        "step_index": None,
        "tool_name": None,
        "tool_target": None,
        "tool_state": None,
        "session_id": None,
        "usage": {},
    }
    if not isinstance(data, dict):
        return info

    for node in _walk_json(data):
        # Step index
        for sk in ("step_index", "stepIndex", "step", "step_num", "index"):
            val = node.get(sk)
            if isinstance(val, int) and not isinstance(val, bool):
                info["step_index"] = val

        # Session / conversation
        for k in _SESSION_KEYS:
            if isinstance(node.get(k), str) and node.get(k):
                info["session_id"] = node[k]

        # Token usage
        for k in _USAGE_KEYS:
            if isinstance(node.get(k), dict):
                for uk, uv in node[k].items():
                    if isinstance(uv, (int, float)):
                        info["usage"][uk] = uv
        for k in _TOKEN_FIELDS:
            if isinstance(node.get(k), (int, float)) and not isinstance(node.get(k), bool):
                info["usage"][k] = node[k]

        # Tool calls / tools
        tool_val = node.get("tool_name") or node.get("toolName") or node.get("tool")
        if isinstance(tool_val, str) and tool_val:
            info["tool_name"] = tool_val

        # Function call / tool_call
        if node.get("type") in ("tool_call", "tool_use", "call", "tool_invocation") or "tool_calls" in node:
            t_name = node.get("name") or node.get("tool")
            if isinstance(t_name, str) and t_name:
                info["tool_name"] = t_name

        # Targets / commands
        for tk in ("command", "CommandLine", "path", "file", "TargetFile", "AbsolutePath", "SearchPath", "target", "query"):
            t_val = node.get(tk)
            if isinstance(t_val, str) and t_val:
                info["tool_target"] = redact_secrets(t_val.strip()[:200])

        # Tool state
        for st in ("state", "status", "tool_state"):
            s_val = node.get(st)
            if isinstance(s_val, str) and s_val:
                info["tool_state"] = s_val

    return info


def terminate_process_tree(proc: subprocess.Popen) -> None:
    """Safely terminate a child process tree on Windows or POSIX."""
    if not hasattr(proc, "pid") or proc.pid is None:
        try:
            proc.kill()
        except Exception:
            pass
        return
    try:
        if os.name == "nt":
            if isinstance(proc.pid, int) and proc.pid > 0:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                    capture_output=True,
                    check=False,
                    timeout=5,
                )
            else:
                proc.kill()
        else:
            proc.kill()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def parse_antigravity_stream(raw_output: str) -> Dict[str, Any]:
    """Parse NDJSON stream output from `agy --output-format stream-json`.

    Each line is parsed independently so one malformed line can never discard later events
    (the previous implementation aborted its whole token scan on the first bad line).
    The last event that looks like a final result is preserved rather than thrown away.
    """
    parsed: Dict[str, Any] = {
        "session_id": None,
        "soft_denial": False,
        "denied_actions": [],
        "usage": {},
        "final_result": None,
        "final_status": None,
        "is_error": None,
        "event_count": 0,
        "unparsed_line_count": 0,
        "event_types": [],
    }
    usage: Dict[str, Any] = parsed["usage"]

    for line in raw_output.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
        except ValueError:
            parsed["unparsed_line_count"] += 1
            if any(re.search(p, line, re.IGNORECASE) for p in SOFT_PERMISSION_DENIAL_PATTERNS):
                parsed["soft_denial"] = True
            continue

        parsed["event_count"] += 1
        if not isinstance(data, dict):
            continue

        ev_type = str(data.get("type") or data.get("event") or "").lower()
        if ev_type and ev_type not in parsed["event_types"]:
            parsed["event_types"].append(ev_type)

        for node in _walk_json(data):
            for k in _SESSION_KEYS:
                if isinstance(node.get(k), str) and node.get(k):
                    parsed["session_id"] = node[k]
            for k in _USAGE_KEYS:
                if isinstance(node.get(k), dict):
                    for uk, uv in node[k].items():
                        if isinstance(uv, (int, float)):
                            usage[uk] = uv
            for k in _TOKEN_FIELDS:
                if isinstance(node.get(k), (int, float)) and not isinstance(node.get(k), bool):
                    usage[k] = node[k]

            # Look for denied_actions structures (e.g. from final result or permission check events)
            for dk in ("denied_actions", "deniedActions", "denied_action", "deniedAction"):
                val = node.get(dk)
                if val:
                    parsed["soft_denial"] = True
                    if isinstance(val, list):
                        for item in val:
                            if isinstance(item, dict):
                                act = item.get("action") or item.get("tool") or item.get("command") or str(item)
                                tgt = item.get("target") or item.get("name") or ""
                                desc = f"{act} / {tgt}".strip(" /") if tgt else str(act)
                            else:
                                desc = str(item)
                            if desc and desc not in parsed["denied_actions"]:
                                parsed["denied_actions"].append(desc)
                    elif isinstance(val, dict):
                        act = val.get("action") or val.get("tool") or str(val)
                        if act and act not in parsed["denied_actions"]:
                            parsed["denied_actions"].append(str(act))
                    elif isinstance(val, str) and val not in parsed["denied_actions"]:
                        parsed["denied_actions"].append(val)

            # Check explicit permission failure keys on events
            status_val = str(node.get("status") or node.get("permission") or "").lower()
            if status_val in ("permission_denied", "denied", "auto_denied", "auto-denied", "rejected"):
                parsed["soft_denial"] = True
                act_name = str(node.get("action") or node.get("tool") or node.get("name") or "command")
                if act_name not in parsed["denied_actions"]:
                    parsed["denied_actions"].append(act_name)

        if ev_type in _RESULT_TYPES or "result" in data and ev_type in ("", "result"):
            parsed["final_result"] = data
            status = data.get("status") or data.get("subtype") or data.get("state")
            if status is not None:
                parsed["final_status"] = str(status)
            if isinstance(data.get("is_error"), bool):
                parsed["is_error"] = data["is_error"]
            elif isinstance(data.get("error"), (str, dict)) and data.get("error"):
                parsed["is_error"] = True

        if any(re.search(p, str(data), re.IGNORECASE) for p in SOFT_PERMISSION_DENIAL_PATTERNS):
            parsed["soft_denial"] = True

    return parsed


def parse_antigravity_stream_json(raw_output: str) -> Tuple[Optional[str], bool, Dict[str, Any]]:
    """Backward-compatible wrapper returning (session_id, soft_denial, token_usage)."""
    p = parse_antigravity_stream(raw_output)
    return p["session_id"], p["soft_denial"], p["usage"]


class AntigravityAdapter(BaseAgentAdapter):
    """Adapter for invoking official Antigravity headless CLI (`agy`) for implementation."""

    def __init__(self, config: SupervisorConfig):
        super().__init__(config)
        self.bin_name = self._resolve_binary()

    def _resolve_binary(self) -> str:
        """Resolve official `agy` headless CLI executable path."""
        # 1. Explicit config or environment override
        if self.config.antigravity_bin:
            resolved = shutil.which(self.config.antigravity_bin)
            if resolved:
                return resolved
            if Path(self.config.antigravity_bin).exists():
                return self.config.antigravity_bin
            return self.config.antigravity_bin

        # 2. Standard PATH lookup for agy
        for candidate in ["agy", "agy.cmd", "agy.exe"]:
            resolved = shutil.which(candidate)
            if resolved:
                return resolved

        # 3. Optional experimental IDE fallback (disabled by default for MVP)
        if self.config.allow_ide_fallback and os.name == "nt":
            local_appdata = os.environ.get("LOCALAPPDATA", "")
            if local_appdata:
                win_ide_cmd = Path(local_appdata) / "Programs" / "Antigravity IDE" / "bin" / "antigravity-ide.cmd"
                if win_ide_cmd.exists():
                    return str(win_ide_cmd)

        return self.config.antigravity_bin or "agy"

    def check_availability(self) -> Dict[str, Any]:
        """Verify if the official `agy` headless CLI binary exists and is accessible."""
        bin_path = self._resolve_binary()
        is_ide_fallback = "antigravity-ide" in bin_path.lower()

        if is_ide_fallback and not self.config.allow_ide_fallback:
            return {
                "available": False,
                "status": "NOT_READY",
                "error": "Antigravity IDE binary found, but official headless CLI ('agy') is required for unattended execution",
                "binary": bin_path,
                "is_headless": False,
            }

        resolved_path = shutil.which(bin_path) or (bin_path if Path(bin_path).exists() else None)
        if not resolved_path:
            return {
                "available": False,
                "status": "NOT_READY",
                "error": f"Antigravity CLI binary '{bin_path}' not found on PATH or disk",
                "binary": bin_path,
                "is_headless": not is_ide_fallback,
            }

        try:
            res = subprocess.run(
                [str(resolved_path), "--version"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.config.doctor_timeout_seconds,
            )
            version_str = res.stdout.strip() or res.stderr.strip()
            if res.returncode == 0:
                return {
                    "available": True,
                    "status": "READY",
                    "version": version_str if version_str else "Detected",
                    "binary": str(resolved_path),
                    "is_headless": not is_ide_fallback,
                }
            return {
                "available": False,
                "status": "NOT_READY",
                "error": f"Binary '{bin_path}' returned exit code {res.returncode}: {version_str}",
                "binary": str(resolved_path),
                "is_headless": not is_ide_fallback,
            }
        except Exception as e:
            return {
                "available": False,
                "status": "NOT_READY",
                "error": str(e),
                "binary": bin_path,
                "is_headless": not is_ide_fallback,
            }

    def get_available_models(self) -> Tuple[bool, List[str], Optional[str]]:
        """Query `agy models` to fetch verified available Gemini models for the authenticated account."""
        bin_path = self._resolve_binary()
        resolved_path = shutil.which(bin_path) or (bin_path if Path(bin_path).exists() else None)
        if not resolved_path:
            return False, [], f"MODEL_DISCOVERY_FAILED: Antigravity CLI binary '{bin_path}' not found on PATH or disk"

        try:
            res = subprocess.run(
                [str(resolved_path), "models"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=sanitize_environment(self.config),
                cwd=str(self.config.repo_root),
                timeout=self.config.antigravity_model_discovery_timeout_seconds,
            )
            combined = (res.stdout or "") + "\n" + (res.stderr or "")
            if res.returncode != 0:
                is_auth_quota, auth_reason = self.check_for_auth_or_quota_failure(combined)
                if is_auth_quota:
                    return False, [], f"PROVIDER_QUOTA_OR_AUTH_REQUIRED: {auth_reason}"
                return False, [], f"MODEL_DISCOVERY_FAILED: `agy models` failed with exit code {res.returncode}: {res.stderr.strip()[:200]}"

            models: List[str] = []
            for line in res.stdout.splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                matches = re.findall(r"\b[a-zA-Z0-9_\-\.]+(?:gemini|pro|flash|claude|gpt)[a-zA-Z0-9_\-\.]*\b", line, re.IGNORECASE)
                for m in matches:
                    clean_m = m.strip().strip("-").strip("*").strip("`").strip()
                    if clean_m and clean_m not in models:
                        models.append(clean_m)
                direct_matches = re.findall(r"\bgemini-[0-9a-zA-Z\.\-_]+\b", line, re.IGNORECASE)
                for dm in direct_matches:
                    if dm not in models:
                        models.append(dm)

            return True, models, None
        except subprocess.TimeoutExpired:
            return False, [], (
                f"MODEL_DISCOVERY_TIMEOUT: `agy models` timed out after "
                f"{self.config.antigravity_model_discovery_timeout_seconds} seconds; "
                "model availability could not be determined."
            )
        except Exception as e:
            return False, [], f"MODEL_DISCOVERY_FAILED: `agy models` discovery failed: {e}"

    def build_prompt(
        self,
        role: Role,
        task_id: str,
        is_fix: bool = False,
        task: Optional[Any] = None,
        git_state: Optional[Any] = None,
        review_blockers: Optional[str] = None,
        canonical_paths: Optional[Dict[str, str]] = None,
        dirty_files: Optional[List[str]] = None,
        completed_verifications: Optional[List[str]] = None,
        verification_plan: Optional[Dict[str, Any]] = None,
        run_id: str = "",
        permission_stop_continuation: bool = False,
        workspace_only: bool = False,
    ) -> str:
        """Build instructions as a compact execution packet for Antigravity Gemini agent."""
        paths = canonical_paths or {}
        task_path = paths.get("task", f"docs/engineering/ai/tasks/{task_id}.md")
        review_path = paths.get("review", f"docs/engineering/ai/reviews/{task_id}-review.md")
        report_path = paths.get("report", f"docs/engineering/ai/reports/{task_id}-implementation.md")
        plan_path = paths.get("plan")
        checkpoint_path = paths.get("checkpoint", "docs/engineering/IMPLEMENTATION_CHECKPOINT.md")

        report_full = self.config.repo_root / report_path
        report_status = "present on disk" if report_full.exists() else "not yet created (create when complete)"

        task_title = f" — {task.title}" if task and getattr(task, "title", None) else ""
        branch_name = git_state.branch if git_state and getattr(git_state, "branch", None) else "active worktree"
        head_sha = git_state.head_sha[:8] if git_state and getattr(git_state, "head_sha", None) else "HEAD"

        if workspace_only:
            return (
                f"KS_V3_WORKSPACE_WORKER task={task_id} mode={'fix' if is_fix else 'implement'}\n"
                f"### KhataSathi Execution Packet — {'FIX_REQUIRED Remediation' if is_fix else 'Implementation'}\n"
                f"Task Contract: {task_path}\nImplementation Plan: {plan_path}\n"
                f"Implementation Report: {report_path} ({report_status})\nSenior Review: {review_path}\n"
                f"Checkpoint: {checkpoint_path}\nBranch: {branch_name} | HEAD: {head_sha}\n"
                "Follow the existing ks-impl role in GEMINI.md, the contract and completed plan; read only relevant frozen architecture.\n"
                "Implement the smallest robust scoped change; in fix mode correct ONLY latest authoritative Senior blockers/source failures and direct regressions.\n"
                "Continue existing partial implementation; never restart/reset/clean/revert. Preserve unrelated changes and authority/plan/review/checkpoint/registry files.\n"
                "V3 overlay overrides legacy shell/check duties: use built-in workspace file/search/edit tools only. Do not use RunCommand, run_command or shell. Do not run tests, Prisma, Git, servers, migrations, deploy or connected DB operations; do not request command(*) permission.\n"
                "Codex owns verification after return. Update the implementation report with exact corrections, files, limitations and suggested checks marked NOT RUN by this worker. Do not self-approve or closeout.\n"
                "No verification command request/execution or REPORT_COMPLETION_VALIDATED marker is required for v3 return.\n"
                + (f"Latest authoritative correction context:\n{review_blockers}\n" if is_fix else "")
            )

        nav_instructions = (
            "### Navigation & Tool Rules (CRITICAL - DO NOT VIOLATE)\n"
            "- Use built-in workspace discovery tools ONLY for directory and file search: `list_dir`, `find_by_name`, `grep_search`, and `view_file`.\n"
            "- Do NOT use `Get-ChildItem`, `dir`, `ls`, Python, shell scripts, or other terminal commands simply to locate/list repository files. Headless mode auto-denies unapproved shell commands.\n"
            "- Use shell commands ONLY for explicitly permitted operations: Git inspection (`git status`, `git diff`) and bounded test/build commands (build, typecheck, targeted tests, Playwright tests). Never start persistent development servers.\n"
            "- A missing optional workflow artifact is NOT fatal.\n"
            "- If an expected implementation report does not exist, use built-in workspace discovery tools to confirm the canonical location rather than shell navigation.\n"
            "- Create/update a required implementation report only when Workflow v2 requires it.\n"
        )

        server_prohibition = (
            "### Persistent Development Servers Strictly Prohibited (CRITICAL)\n"
            "- Headless agents MUST NOT start persistent development servers such as:\n"
            "  * `pnpm --dir backend run dev`\n"
            "  * `pnpm --dir frontend run dev`\n"
            "  * `npm run dev`\n"
            "  * other indefinitely running local servers\n"
            "  unless a task explicitly requires live-server verification and the supervisor has a bounded, managed server lifecycle for that task.\n"
            "- Headless execution will auto-deny persistent dev-server commands and fail the turn as a permission denial.\n"
            "- Note: Playwright browser tests already start/manage their own temporary local webserver automatically; do NOT attempt manual server startup.\n"
        )

        bounded_verification = (
            "### Bounded Verification & Early Completion Rules\n"
            "- COMMAND EXECUTION RULE: Run every shell verification command as a separate `run_command` invocation.\n"
            "- Never chain commands using `;`, `&&`, `||`, pipes (`|`), shell command grouping, or equivalent multi-command shell syntax.\n"
            "- Invoke each allowed backend build, backend test, frontend typecheck, Playwright, lint, or git inspection command independently.\n"
            "- REQUIRED VERIFICATION THIS RUN commands have been checked against the existing provider policy. Use their exact canonical authorized forms; never invent test:fast or substitute a build for a required test.\n"
            "- Before any additional verification request after edits, confirm it is affected, bounded, and covered by the same existing policy. If no approved equivalent can satisfy it, STOP and report REQUIRED_VERIFICATION_UNEXECUTABLE; do not request an unauthorized command.\n"
            "- Reuse an already-passed bounded check only when its recorded content/revision and runtime target match the current relevant content and no subsequent relevant change invalidates that evidence. Inspect the existing report and working tree diff before relying on earlier results.\n"
            "- Do not rerun already-passed, still-valid checks merely to create a combined/final verification command.\n"
            "- After a relevant code change, rerun only the affected required bounded verification, individually in separate `run_command` invocations; retain unaffected valid evidence. Missing, failed, or unverifiable required evidence still requires an individual bounded check.\n"
            "- If all required bounded checks already passed individually and their evidence remains valid, record the existing successful evidence in the implementation report and finish the implementation/remediation turn instead of rerunning them as a combined command, subject to the Senior authority and blocker-by-blocker completion rules below.\n"
            "- After a permission stop or timeout, inspect the current dirty worktree and recorded verification evidence, preserve valid partial work, and continue from it rather than restarting the task.\n"
            "- Do not broaden permissions, use destructive git, push/merge/deploy, or access configured production databases/VPS.\n"
            "- For normal implementation/fix verification, prefer bounded, terminating commands only:\n"
            "  * build (`pnpm --dir backend run build`, etc.)\n"
            "  * typecheck (`pnpm --dir frontend run typecheck`, etc.)\n"
            "  * targeted tests (e.g. backend route/controller unit tests)\n"
            "  * Playwright tests (`pnpm --dir frontend exec playwright test ...`)\n"
            "  * lint where relevant\n"
            "  * git diff/check/status\n"
            "- If all required bounded verification passes, STOP further exploratory verification immediately.\n"
            "- Do NOT attempt persistent server startup (`run dev`) or unapproved exploratory commands after bounded checks succeed.\n"
            "- Proceed directly to the Workflow v2 implementation-evidence/report step: record results in the report and conclude only when required corrections/evidence are complete; passing checks alone do not resolve Senior blockers.\n"
        )

        verification_section = (
            "### Mandatory Continuation Verification Plan\n"
            "VALID REUSABLE EVIDENCE / INVALIDATED EVIDENCE / REQUIRED VERIFICATION THIS RUN:\n"
            + json.dumps(compact_verification_plan(verification_plan, run_id), sort_keys=True, indent=2) + "\n"
            "Evidence validity is calculated by the supervisor. Full coverage hashes, policy fingerprints, and provenance remain in its frozen runtime plan; do not recompute them or read that file during normal execution. After edits, treat affected checks as invalidated and verify them individually.\n"
            "FORBIDDEN REDUNDANT VERIFICATION: If a proposed verification command is already represented by valid reusable evidence and no relevant covered content changed, DO NOT execute or request that command. Use the existing evidence instead.\n"
            "This plan is mandatory: another run, timeout, permission denial, or FIX_REQUIRED state does not invalidate a check. Only changed covered content/path sets, runtime target, or a concrete invalid result does.\n"
            "If no implementation changes are made, do not rerun already-valid checks. After changes, rerun only invalidated affected required commands individually. Do not request broader suites for confidence when narrower valid evidence covers the blockers.\n"
            "Use view_file, grep_search, and list_dir for inspection; tests are not discovery tools. Broad pnpm --dir backend test and wildcard/arbitrary pnpm commands remain unauthorized.\n"
            "Empty required_verification means no KNOWN recorded check is invalidated; verification_gaps and missing latest Senior blocker evidence still require bounded work. A PASS does not certify that the fixture proves every Senior finding. Do not reopen resolved blockers unless a new correction invalidates their relevant evidence.\n"
            "Reused evidence contributes to completion only after current Senior blockers are addressed, required verification/evidence is satisfied, and normal report/completion-provenance rules pass. Never promote stale evidence.\n\n"
        )

        plan_line = f"- Implementation Plan: {plan_path}\n" if plan_path else ""

        permission_continuation = permission_stop_continuation and role == Role.IMPLEMENTATION and not is_fix
        permission_section = (
            "### RunCommand Permission-Stop Continuation (CRITICAL)\n"
            "- Do not use RunCommand or shell commands for repository navigation/discovery.\n"
            "- Use built-in workspace tools: list_dir, grep_search, view_file.\n"
            "- Preserve all existing partial implementation changes.\n"
            "- Resume from the current repository state; do not restart or overwrite completed work.\n"
            "- Do not reset, clean, revert, or duplicate completed implementation work.\n"
            "- Use shell execution only when a genuinely required approved command must be executed and is permitted by the existing allowlist.\n"
            "- Do not request broad command(*) permission.\n"
            "- Do not weaken or bypass headless permission policy.\n"
            "- Do not escalate model solely because of permission denial.\n\n"
        ) if permission_continuation else ""
        continuation_section = ""
        if dirty_files:
            files_list = "\n".join(f"- `{f}`" for f in dirty_files[:25])
            continuation_section = (
                "### Continuation from Existing Working Tree (CRITICAL)\n"
                "The repository already contains partial implementation changes from an earlier turn:\n"
                f"{files_list}\n\n"
                "Continuation Instructions:\n"
                "1. Inspect the existing partial implementation and working tree diff first (`git status`, `git diff`).\n"
                "2. Preserve valid completed work — do NOT discard, revert, or reimplement already-correct portions unnecessarily.\n"
                "3. Continue resolving the remaining unresolved review blockers and completing required verification.\n"
                "4. Apply the shared bounded verification rules to existing evidence and subsequent relevant changes.\n\n"
            )

        evidence_section = ""
        if completed_verifications:
            ev_list = "\n".join(f"- {ev}" for ev in completed_verifications)
            evidence_section = (
                "### Existing Verification Evidence (Validate Before Reuse)\n"
                "Earlier bounded verification results were supplied as context; verify their recorded content/target and continued validity under the shared bounded verification rules:\n"
                f"{ev_list}\n\n"
            )

        if is_fix:
            review_full = self.config.repo_root / review_path
            # A supplied legacy blocker string cannot override an available canonical Senior review.
            blockers_section = (remediation_review_context(review_full, report_full) if review_full.is_file()
                                else review_blockers.strip() if review_blockers else "Inspect latest review artifact.")
            senior_authority = (
                "### SENIOR AUTHORITY RULE\n"
                "The latest canonical Senior FIX_REQUIRED decision is authoritative for remediation scope.\n"
                "The implementation report is only an implementation claim and MUST NOT override Senior authority, even if it says COMPLETE or all blockers resolved.\n"
                "Work only on the latest remaining blockers and their direct regressions. Do not reopen resolved blockers unless a required correction directly affects them.\n"
                "Do not declare remediation complete merely because existing code/report text claims a blocker is fixed, or because generic build/typecheck/unit/whitespace checks pass.\n\n"
                "### CURRENT-CONTENT BINDING\n"
                "Bind remediation to the review run ID, remaining-blocker list, review SHA256, and recorded correction manifest/report hash above. Inspect the recorded manifest against relevant current application/report content; a report hash alone does not certify unchanged application content.\n"
                "If the latest Senior review records a correction manifest/report hash and no relevant application/report changes occurred afterward, assume the Senior finding still applies. Re-reading the same content and disagreeing with Senior is not remediation.\n"
                "A newer relevant implementation change permits targeted re-verification of affected blockers/checks; retain unaffected valid evidence and do not infer resolution from generic checks.\n\n"
                "### NO-OP REMEDIATION RULE\n"
                "When entering from FIX_REQUIRED, a zero-effect turn is not valid remediation completion if the latest Senior review examined the same current application/report content and still lists blockers.\n"
                "Make observable code/test/workflow-evidence corrections addressing those blockers, or stop with an explicit bounded inability/permission/infrastructure reason. Pure no-op reinspection/reverification is not completion.\n"
                "Evidence-only exception: a no-code-change remediation may complete only when the latest Senior blocker explicitly requires evidence/verification only AND this turn produces the missing required workflow evidence/artifacts. It must have an observable workflow-artifact effect and satisfy postconditions. Merely rerunning passing checks or rewriting a completion claim is insufficient.\n\n"
                "### REPORT_COMPLETION_VALIDATED GUARD\n"
                "Do NOT emit REPORT_COMPLETION_VALIDATED when the latest decision is FIX_REQUIRED, remaining blockers are nonempty, and this run produced no observable correction/evidence addressing them. Never emit it after pure no-op reinspection/reverification. Any later report-validation instruction is subordinate to this guard.\n\n"
                "### BLOCKER-BY-BLOCKER COMPLETION ACCOUNTING\n"
                "For EVERY latest remaining blocker, record: Senior finding; exact correction needed; files/evidence expected to change; correction performed this turn; targeted verification performed (identify valid reused evidence separately); unresolved limitation, if any.\n"
                "Finish only when every latest remaining blocker is corrected and evidenced, or explicitly stopped for a bounded reason. A bounded stop is not successful remediation and must not emit completion validation.\n\n"
            )
            return (
                f"### KhataSathi Execution Packet — FIX_REQUIRED Remediation\n"
                f"Task ID: {task_id}{task_title}\n"
                f"Workflow State: FIX_REQUIRED\n"
                f"Branch: {branch_name} | HEAD: {head_sha}\n\n"
                f"### Canonical Workflow Artifacts\n"
                f"- Task Contract: {task_path}\n"
                f"- Senior Review: {review_path}\n"
                f"- Implementation Report: {report_path} ({report_status})\n"
                f"{plan_line}"
                f"- Checkpoint: {checkpoint_path}\n\n"
                f"### Exact Unresolved Senior Review Blockers\n"
                f"{blockers_section}\n\n"
                f"{senior_authority}"
                f"{verification_section}"
                f"{continuation_section}"
                f"{evidence_section}"
                f"{nav_instructions}\n"
                f"{server_prohibition}\n"
                f"{bounded_verification}\n"
                f"### Required Behavior\n"
                f"1. Inspect existing partial implementation and preserve completed valid edits.\n"
                f"2. Fix ONLY the unresolved review blockers listed above and direct regressions.\n"
                f"3. Apply the shared bounded verification rules to required checks and recorded evidence.\n"
                f"4. If all required bounded verification passes, STOP further exploratory commands immediately.\n"
                f"5. Update or create the implementation report at `{report_path}` with exact blocker fix and verification evidence.\n"
                f"6. Request targeted senior verification.\n\n"
                f"### Prohibited Actions\n"
                f"- Do NOT commit, push, or execute production migrations.\n"
                f"- Do NOT modify senior review files.\n"
                f"- Do NOT execute terminal commands (`Get-ChildItem`, `dir`, `ls`, etc.) for repository navigation.\n"
                f"- Do NOT start persistent development servers (`pnpm --dir backend run dev`, `pnpm --dir frontend run dev`, `npm run dev`, etc.).\n"
                f"- Do NOT run exploratory verification commands after bounded verification has passed.\n"
            )
        else:
            return (
                f"### KhataSathi Execution Packet — Implementation\n"
                f"Task ID: {task_id}{task_title}\n"
                f"Workflow State: {'IMPLEMENTATION_IN_PROGRESS' if permission_continuation and dirty_files else 'DIRECT_IMPLEMENTATION'}\n"
                f"Branch: {branch_name} | HEAD: {head_sha}\n\n"
                f"### Canonical Workflow Artifacts\n"
                f"- Task Contract: {task_path}\n"
                f"- Implementation Report: {report_path} ({report_status})\n"
                f"{plan_line}"
                f"- Checkpoint: {checkpoint_path}\n\n"
                f"{permission_section}"
                f"{continuation_section}"
                f"{verification_section}"
                f"{evidence_section}"
                f"{nav_instructions}\n"
                f"{server_prohibition}\n"
                f"{bounded_verification}\n"
                f"### Required Behavior\n"
                f"1. Read the task contract (and plan if present) using built-in discovery tools.\n"
                f"2. Implement the smallest robust changes satisfying acceptance criteria.\n"
                f"3. Apply the shared bounded verification rules to required checks and recorded evidence.\n"
                f"4. If all required bounded verification passes, stop verification and write/update the implementation report at `{report_path}`.\n\n"
                f"### Prohibited Actions\n"
                f"- Do NOT commit, push, or execute production migrations.\n"
                f"- Do NOT execute terminal commands (`Get-ChildItem`, `dir`, `ls`, etc.) for repository navigation.\n"
                f"- Do NOT start persistent development servers (`pnpm --dir backend run dev`, `pnpm --dir frontend run dev`, `npm run dev`, etc.).\n"
                f"- Do NOT run exploratory verification commands after bounded verification has passed.\n"
            )

    def check_for_soft_permission_denials(self, output: str) -> bool:
        """Scan terminal output for tool permission denials that didn't fail the process exit code."""
        for pattern in SOFT_PERMISSION_DENIAL_PATTERNS:
            if re.search(pattern, output, re.IGNORECASE):
                return True
        return False

    def check_for_permission_denials(self, output: str) -> Tuple[bool, List[str]]:
        """Scan terminal stdout/stderr for explicit permission denials or headless auto-denials."""
        denied_actions: List[str] = []
        is_denied = False

        for pattern in SOFT_PERMISSION_DENIAL_PATTERNS:
            if re.search(pattern, output, re.IGNORECASE):
                is_denied = True
                break

        cmd_match = re.search(r"required the [\"']?(\w+)[\"']? permission.*auto-denied", output, re.IGNORECASE)
        if cmd_match:
            denied_actions.append(f"{cmd_match.group(1)} / RunCommand (auto-denied in headless mode)")
        elif is_denied:
            tool_match = re.search(r"(?:tool|command|operation|permission)\s*[\"']?([A-Za-z0-9_\-\.\s]+)[\"']?\s*(?:was\s+)?(?:denied|rejected|auto-denied|not permitted)", output, re.IGNORECASE)
            if tool_match:
                denied_actions.append(tool_match.group(0).strip())

        return is_denied, denied_actions

    def check_for_auth_or_quota_failure(self, output: str) -> Tuple[bool, Optional[str]]:
        """Scan terminal output for explicit provider authentication or quota exhaustion errors."""
        for pattern, reason in AUTH_OR_QUOTA_PATTERNS:
            if re.search(pattern, output, re.IGNORECASE):
                return True, reason
        return False, None

    def invoke(
        self,
        role: Role,
        task_id: str,
        prompt: Optional[str] = None,
        is_read_only: bool = False,
        profile: Optional[Any] = None,
        hard_timeout: Optional[int] = None,
        idle_timeout: Optional[int] = None,
        run_id: str = "",
        verification_observer: Optional[Callable[[dict], None]] = None,
        action: str = "",
    ) -> AgentResult:
        """Invoke Antigravity headless CLI non-interactively with selected model profile and streaming telemetry."""
        start_time = time.time()
        run_id = run_id or uuid4().hex
        started_at = datetime.now(timezone.utc).isoformat()
        final_prompt = prompt or self.build_prompt(role, task_id, run_id=run_id)

        # Verify readiness before running
        avail = self.check_availability()
        if not avail["available"]:
            return AgentResult(
                role=role,
                run_id=run_id,
                started_at=started_at,
                task_id=task_id,
                exit_code=127,
                stdout="",
                stderr=avail.get("error", "Antigravity CLI unavailable"),
                duration_seconds=0.0,
                success=False,
                process_started=False,
                infrastructure_failure=WorkflowState.AGENT_LAUNCH_FAILED,
                process_completed=False,
                provider_reported_success=False,
                error_message=avail.get("error", "Antigravity CLI unavailable"),
                provider="antigravity",
                model_name=profile.model if profile else "gemini-3.7-flash-medium",
                effort=profile.effort if profile else "medium",
            )

        bin_path = avail["binary"]
        model_name = profile.model if profile else "gemini-3.7-flash-medium"
        effort_val = profile.effort if profile else "medium"

        # Explicit mode: `--mode accept-edits` for write actions; `--mode plan` for read-only actions
        mode_flag = "plan" if (is_read_only or role == Role.PLANNER) else "accept-edits"

        # Headless non-interactive print mode (`agy -p` with stream-json format)
        if not avail.get("is_headless", True):
            cmd = [bin_path, "chat", "--mode", mode_flag, final_prompt]
        else:
            cmd = [
                bin_path,
                "-p", final_prompt,
                "--mode", mode_flag,
                "--project", CLI_PROJECT,
                "--model", model_name,
                "--effort", effort_val,
                "--output-format", "stream-json",
            ]

        size = invocation_size(cmd, final_prompt, self.config.antigravity_windows_command_line_limit_chars)
        size.update(run_id=run_id, provider="antigravity", model=model_name, effort=effort_val,
                    action=action or role.value)
        if sys.platform == "win32" and (not 0 < size["configured_limit"] <= 30000
                               or size["serialized_argv_utf16_units"] + 1 > size["configured_limit"]):
            error = "AGENT_INVOCATION_TOO_LARGE: serialized Windows invocation exceeds the safe configured bound"
            return AgentResult(
                role=role, task_id=task_id, run_id=run_id, started_at=started_at,
                exit_code=1, stdout="", stderr=error, error_message=error,
                duration_seconds=time.time()-start_time, success=False, process_started=False,
                infrastructure_failure=WorkflowState.AGENT_INVOCATION_TOO_LARGE,
                provider="antigravity", model_name=model_name, effort=effort_val, cmd_argv=cmd,
                stream_summary={"invocation_size": size, "lifecycle_stage": "invocation_preflight"},
            )

        env = sanitize_environment(self.config)

        # Set up runtime stream files inside .git/ks-runtime (never committed)
        runtime_dir = self.config.runtime_dir
        runtime_dir.mkdir(parents=True, exist_ok=True)
        stream_path = runtime_dir / "current_agent_stream.jsonl"
        stderr_path = runtime_dir / "current_agent_stderr.log"

        effective_idle_timeout = idle_timeout if idle_timeout is not None else self.config.agent_idle_timeout_seconds
        effective_hard_timeout = hard_timeout if hard_timeout is not None else self.config.agent_timeout_seconds

        stdout_lines: List[str] = []
        stderr_lines: List[str] = []
        stream_lock = threading.Lock()
        last_activity_time = time.time()
        last_activity_at_str = datetime.now(timezone.utc).isoformat()
        events_received = 0
        latest_step_index: Optional[int] = None
        latest_tool_name: Optional[str] = None
        latest_tool_target: Optional[str] = None
        latest_tool_state: Optional[str] = None
        accumulated_usage: Dict[str, Any] = {}
        captured_session_id: Optional[str] = None

        try:
            stream_file = open(stream_path, "w", encoding="utf-8")
            stderr_file = open(stderr_path, "w", encoding="utf-8")
        except Exception:
            stream_file = None
            stderr_file = None

        proc = None
        timed_out = False
        timeout_kind: Optional[str] = None

        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
                cwd=str(self.config.repo_root),
                bufsize=1,
            )

            def stdout_reader():
                nonlocal last_activity_time, last_activity_at_str, events_received
                nonlocal latest_step_index, latest_tool_name, latest_tool_target, latest_tool_state
                nonlocal captured_session_id
                try:
                    for line in iter(proc.stdout.readline, ""):
                        if not line:
                            break
                        with stream_lock:
                            now_ts = time.time()
                            last_activity_time = now_ts
                            last_activity_at_str = datetime.now(timezone.utc).isoformat()
                            stdout_lines.append(line)

                            redacted_line = redact_secrets(line)
                            if stream_file and not stream_file.closed:
                                stream_file.write(redacted_line if redacted_line.endswith("\n") else redacted_line + "\n")
                                stream_file.flush()

                            trimmed = line.strip()
                            if trimmed:
                                try:
                                    data = json.loads(trimmed)
                                    if isinstance(data, dict):
                                        if verification_observer:
                                            verification_observer(data)
                                        events_received += 1
                                        info = extract_event_info(data)
                                        if info["step_index"] is not None:
                                            latest_step_index = info["step_index"]
                                        if info["tool_name"]:
                                            latest_tool_name = info["tool_name"]
                                        if info["tool_target"]:
                                            latest_tool_target = info["tool_target"]
                                        if info["tool_state"]:
                                            latest_tool_state = info["tool_state"]
                                        if info["session_id"]:
                                            captured_session_id = info["session_id"]
                                        if info["usage"]:
                                            accumulated_usage.update(info["usage"])
                                except ValueError:
                                    pass
                except Exception:
                    pass

            def stderr_reader():
                nonlocal last_activity_time, last_activity_at_str
                try:
                    for line in iter(proc.stderr.readline, ""):
                        if not line:
                            break
                        with stream_lock:
                            last_activity_time = time.time()
                            last_activity_at_str = datetime.now(timezone.utc).isoformat()
                            stderr_lines.append(line)
                            redacted_line = redact_secrets(line)
                            if stderr_file and not stderr_file.closed:
                                stderr_file.write(redacted_line if redacted_line.endswith("\n") else redacted_line + "\n")
                                stderr_file.flush()
                except Exception:
                    pass

            t_out = threading.Thread(target=stdout_reader, daemon=True)
            t_err = threading.Thread(target=stderr_reader, daemon=True)
            t_out.start()
            t_err.start()

            while proc.poll() is None:
                time.sleep(0.1)
                now = time.time()
                with stream_lock:
                    idle_duration = now - last_activity_time
                total_duration = now - start_time

                if idle_duration > effective_idle_timeout:
                    timed_out = True
                    timeout_kind = "idle"
                    break
                if total_duration > effective_hard_timeout:
                    timed_out = True
                    timeout_kind = "hard_limit"
                    break

            if timed_out:
                terminate_process_tree(proc)

            t_out.join(timeout=2.0)
            t_err.join(timeout=2.0)

        except Exception as e:
            if proc:
                terminate_process_tree(proc)
            duration = time.time() - start_time
            if stream_file and not stream_file.closed:
                try:
                    stream_file.close()
                except Exception:
                    pass
            if stderr_file and not stderr_file.closed:
                try:
                    stderr_file.close()
                except Exception:
                    pass
            return AgentResult(
                role=role,
                run_id=run_id,
                started_at=started_at,
                task_id=task_id,
                exit_code=1,
                stdout="".join(stdout_lines),
                stderr=str(e),
                duration_seconds=duration,
                success=False,
                process_completed=False,
                provider_reported_success=False,
                process_started=proc is not None,
                infrastructure_failure=WorkflowState.AGENT_LAUNCH_FAILED if proc is None else None,
                error_message=redact_secrets(str(e)),
                provider="antigravity",
                model_name=model_name,
                effort=effort_val,
                cmd_argv=cmd,
                stream_summary={"invocation_size": size, "lifecycle_stage": "process_launch" if proc is None else "provider_execution",
                                "launch_winerror": getattr(e, "winerror", None)},
                last_activity_at=last_activity_at_str,
                last_step_index=latest_step_index,
                last_tool_name=latest_tool_name,
                last_tool_target=latest_tool_target,
                events_received=events_received,
            )
        finally:
            if stream_file and not stream_file.closed:
                try:
                    stream_file.close()
                except Exception:
                    pass
            if stderr_file and not stderr_file.closed:
                try:
                    stderr_file.close()
                except Exception:
                    pass

        duration = time.time() - start_time
        full_stdout = "".join(stdout_lines)
        full_stderr = "".join(stderr_lines)
        exit_code = 124 if timed_out else (proc.returncode if proc else 1)

        combined_output = full_stdout + "\n" + full_stderr
        stream = parse_antigravity_stream(full_stdout)
        session_id = stream["session_id"] or captured_session_id
        parsed_usage = stream["usage"]
        if accumulated_usage:
            for uk, uv in accumulated_usage.items():
                if uk not in parsed_usage:
                    parsed_usage[uk] = uv

        denied_actions = list(stream.get("denied_actions", []))
        text_denied, text_denials = self.check_for_permission_denials(combined_output)
        for td in text_denials:
            if td not in denied_actions:
                denied_actions.append(td)

        soft_denial = stream["soft_denial"] or text_denied or bool(denied_actions)
        is_auth_quota, auth_reason = self.check_for_auth_or_quota_failure(combined_output)

        if timed_out:
            error_msg = f"Antigravity execution timed out ({timeout_kind}) after {duration:.1f}s"
            return AgentResult(
                role=role,
                run_id=run_id,
                started_at=started_at,
                task_id=task_id,
                exit_code=124,
                stdout=full_stdout,
                stderr=full_stderr if full_stderr else error_msg,
                duration_seconds=duration,
                success=False,
                process_completed=False,
                process_started=True,
                provider_reported_success=False,
                error_message=error_msg,
                soft_permission_denial=soft_denial,
                denied_actions=denied_actions,
                auth_or_quota_failure=is_auth_quota,
                session_id=session_id,
                provider="antigravity",
                model_name=model_name,
                effort=effort_val,
                token_usage=parsed_usage,
                cmd_argv=cmd,
                final_status=stream["final_status"],
                stream_summary={
                    "invocation_size": size,
                    "lifecycle_stage": "provider_execution",
                    "event_count": stream["event_count"] or events_received,
                    "unparsed_line_count": stream["unparsed_line_count"],
                    "event_types": stream["event_types"],
                    "final_result_present": stream["final_result"] is not None,
                    "final_status": stream["final_status"],
                    "is_error": stream["is_error"],
                    "usage_present": bool(parsed_usage),
                    "denied_actions": denied_actions,
                    "timed_out": True,
                    "timeout_kind": timeout_kind,
                },
                timed_out=True,
                timeout_kind=timeout_kind,
                last_activity_at=last_activity_at_str,
                last_step_index=latest_step_index,
                last_tool_name=latest_tool_name,
                last_tool_target=latest_tool_target,
                events_received=events_received,
            )

        process_completed = exit_code == 0
        final_reports_error = stream["is_error"] is True

        provider_semantic_success = (
            process_completed
            and not soft_denial
            and not bool(denied_actions)
            and not is_auth_quota
            and not final_reports_error
        )
        provider_reported_success = provider_semantic_success
        success = provider_semantic_success

        error_msg = None
        if not provider_semantic_success:
            if is_auth_quota:
                error_msg = f"PROVIDER_QUOTA_OR_AUTH_REQUIRED: {auth_reason}"
            elif soft_denial or denied_actions:
                denied_summary = ", ".join(denied_actions) if denied_actions else "unapproved tool command"
                error_msg = f"AGENT_PERMISSION_REQUIRED: Headless mode auto-denied permission for: {denied_summary}"
            elif final_reports_error:
                error_msg = f"Antigravity final result reported an error (status={stream['final_status']})"
            else:
                error_msg = f"Antigravity CLI exited with code {exit_code}: {full_stderr[:200]}"

        return AgentResult(
            role=role,
            run_id=run_id,
            started_at=started_at,
            task_id=task_id,
            exit_code=exit_code,
            stdout=full_stdout,
            stderr=full_stderr,
            duration_seconds=duration,
            success=success,
            process_started=True,
            process_completed=process_completed,
            provider_reported_success=provider_reported_success,
            error_message=error_msg,
            soft_permission_denial=soft_denial,
            denied_actions=denied_actions,
            auth_or_quota_failure=is_auth_quota,
            session_id=session_id,
            provider="antigravity",
            model_name=model_name,
            effort=effort_val,
            token_usage=parsed_usage,
            cmd_argv=cmd,
            final_status=stream["final_status"],
            stream_summary={
                "invocation_size": size,
                "lifecycle_stage": "provider_execution",
                "event_count": stream["event_count"] or events_received,
                "unparsed_line_count": stream["unparsed_line_count"],
                "event_types": stream["event_types"],
                "final_result_present": stream["final_result"] is not None,
                "final_status": stream["final_status"],
                "is_error": stream["is_error"],
                "usage_present": bool(parsed_usage),
                "denied_actions": denied_actions,
                "timed_out": False,
                "timeout_kind": None,
            },
            timed_out=False,
            timeout_kind=None,
            last_activity_at=last_activity_at_str,
            last_step_index=latest_step_index,
            last_tool_name=latest_tool_name,
            last_tool_target=latest_tool_target,
            events_received=events_received,
        )
