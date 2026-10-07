"""Deterministic, permission-gated verification; no provider or shell invocation."""
from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import time

from tools.ks_supervisor.adapters.base import sanitize_environment, redact_secrets
from tools.ks_supervisor.verification import bounded_check


def canonical_argv(command):
    check = bounded_check(command)
    if not check:
        raise ValueError("No canonical bounded check")
    args = shlex.split(check["command"])
    if check["kind"] == "frontend targeted Playwright":
        if not all(re.fullmatch(r"tests/browser/[A-Za-z0-9_./-]+\.[cm]?[jt]sx?", a) for a in args[6:]):
            raise ValueError("Only explicit browser specs are executable directly")
    elif check["kind"] == "backend targeted tests":
        if not all(re.fullmatch(r"backend/dist/tests/[A-Za-z0-9_./-]+\.test\.[cm]?js", a) for a in args[2:]):
            raise ValueError("Only explicit compiled backend tests are executable directly")
    return check, args


def execute_check(config, args, output_path, timeout, heartbeat):
    """Resolve npm Windows shim to its Node entry point; never execute a shell."""
    binary = shutil.which(args[0])
    if not binary:
        raise OSError("Verification executable unavailable")
    argv = [binary, *args[1:]]
    if os.name == "nt" and Path(binary).suffix.lower() in (".cmd", ".bat", ".ps1"):
        entry = Path(binary).parent / "node_modules/pnpm/bin/pnpm.cjs"
        node = shutil.which("node")
        if args[0] != "pnpm" or not entry.is_file() or not node:
            raise OSError("No shell-free canonical verification executable available")
        argv = [node, str(entry), *args[1:]]
    with output_path.open("wb") as stream:
        process = subprocess.Popen(argv, cwd=config.repo_root, env=sanitize_environment(config),
                                   stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT,
                                   shell=False, start_new_session=os.name != "nt",
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        deadline = time.monotonic() + timeout
        try:
            while True:
                heartbeat()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(argv, timeout)
                try:
                    return process.wait(timeout=min(5, remaining))
                except subprocess.TimeoutExpired:
                    continue
        except BaseException:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            else:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
            raise


def run_check(config, evidence, item, run_id, timeout, heartbeat):
    check, args = canonical_argv(item["command"])
    before = evidence.snapshot(check)
    directory = config.runtime_dir / "targeted_verification" / run_id
    directory.mkdir(parents=True, exist_ok=True)
    output_path = directory / f"{item['check_id']}.log"
    outcome, exit_code, error = "UNAVAILABLE", None, ""
    try:
        exit_code = execute_check(config, args, output_path, timeout, heartbeat)
        outcome = "PASS" if exit_code == 0 else "FAIL"
    except (OSError, subprocess.SubprocessError) as exc:
        error = type(exc).__name__
    output = redact_secrets(output_path.read_text(encoding="utf-8", errors="replace") if output_path.exists() else "")
    output_path.write_text(output, encoding="utf-8")
    if outcome == "PASS" and re.search(r"\b[1-9]\d* (?:failed|failing)\b|error TS\d+|ERR_PNPM|^# fail [1-9]\d*", output, re.I | re.M):
        outcome = "FAIL"
    after = evidence.snapshot(check)
    if before != after:
        outcome, error = "UNAVAILABLE", "Covered content/target changed during verification"
    record = {"task_id": evidence.task_id, "run_id": run_id, "verifier_run_id": run_id,
              "check_id": item["check_id"], "command": check["command"], "check": check,
              "outcome": outcome, "exit_code": exit_code, "snapshot": before,
              "result_sha256": hashlib.sha256(output.encode()).hexdigest(),
              "result_summary": f"Command completed with exit code {exit_code}",
              "output_path": str(output_path), "error": error,
              "recorded_at": datetime.now(timezone.utc).isoformat()}
    evidence.record_result(check, record)
    return record
